import XCTest
@testable import AiAppBridgeIOS

final class MobileCaptureStoreContractTests: XCTestCase {
    func testSharedFixturesPassThroughTheStoreInterface() throws {
        let root = try loadFixtures()
        let defaults = root["defaults"] as! [String: Any]
        let cases = root["cases"] as! [[String: Any]]
        for spec in cases {
            let name = spec["name"] as! String
            let store = MobileCaptureStore(budgets: budgets(of: spec, defaults: defaults), caps: caps(of: spec, defaults: defaults))
            let generationBefore = store.status().generation
            var lastReceipt = appendAll(store, spec["appends"] as! [[String: Any]], defaults: defaults)
            if let mark = spec["mark"] as? [String] {
                _ = store.mark(mark)
            }
            if let more = spec["moreAppends"] as? [[String: Any]] {
                lastReceipt = appendAll(store, more, defaults: defaults)
            }
            if spec["clear"] as? String == "all" {
                _ = store.clear("all")
            }
            let page = store.query(query(of: spec["query"] as! [String: Any]))
            let expect = spec["expect"] as! [String: Any]
            XCTAssertEqual(ids(of: page), int64s(expect["ids"] as! [Any]), name)
            // G1 fixtures continue to specify Legacy item projection. Memory-only facts cannot
            // meet the later persistent evidence contract, regardless of the old fixture metadata.
            XCTAssertFalse(page.coverage.committed, name)
            XCTAssertTrue(page.refs.isEmpty, name)
            if expect["persistent"] != nil {
                XCTAssertFalse(store.status().persistent, name)
            }
            if let messages = expect["messages"] as? [String] {
                XCTAssertEqual(page.items.map { $0["message"] as? String ?? "" }, messages, name)
            }
            if let values = expect["stateValues"] as? [String: Any] {
                for (key, value) in values {
                    XCTAssertEqual("\(page.values[key] ?? "")", "\(value)", name)
                }
            }
            if expect["secondAppend"] as? String == "deduplicated" {
                XCTAssertTrue(lastReceipt.deduplicated, name)
            }
            if expect["secondAppend"] as? String == "dropped" {
                XCTAssertTrue(lastReceipt.dropped, name)
            }
            if expect["generationChanged"] as? Bool == true {
                XCTAssertTrue(store.status().generation > generationBefore, name)
            }
            XCTAssertTrue(store.status().ownedBytes <= store.status().budgetBytes, name)
        }
    }

    func testOneMillionSmallRecordsStayInsideByteBudget() {
        let store = MobileCaptureStore()
        for index in 0..<1_000_000 {
            _ = store.append(
                CaptureInput(
                    stream: "logs",
                    targetKey: "t",
                    runtimeEpoch: "e",
                    captureId: Int64(index),
                    timestampMs: Int64(index),
                    record: ["id": index]
                )
            )
        }
        let status = store.status()
        XCTAssertFalse(status.persistent)
        XCTAssertTrue(status.ownedBytes <= status.budgetBytes)
        XCTAssertTrue(status.streams["logs"]!.ownedBytes <= 256 * 1024)
    }

    func testTenThousandNetworkRecordsStayInsideByteBudget() {
        let store = MobileCaptureStore()
        let body = String(repeating: "n", count: 20_000)
        for index in 0..<10_000 {
            _ = store.append(
                CaptureInput(
                    stream: "network",
                    targetKey: "t",
                    runtimeEpoch: "e",
                    captureId: Int64(index),
                    timestampMs: Int64(index),
                    record: ["id": index, "body": body]
                )
            )
        }
        let status = store.status()
        XCTAssertTrue(status.ownedBytes <= status.budgetBytes)
        XCTAssertTrue(status.streams["network"]!.ownedBytes <= 384 * 1024)
    }

    private func appendAll(_ store: MobileCaptureStore, _ items: [[String: Any]], defaults: [String: Any]) -> AppendReceipt {
        var last = AppendReceipt(status: "dropped", accepted: false, committed: false, dropped: true, deduplicated: false, mobileFactId: nil, reason: nil)
        for item in items {
            last = store.append(input(of: item, defaults: defaults))
        }
        return last
    }

    private func input(of item: [String: Any], defaults: [String: Any]) -> CaptureInput {
        CaptureInput(
            stream: item["stream"] as! String,
            targetKey: defaults["targetKey"] as! String,
            runtimeEpoch: defaults["runtimeEpoch"] as! String,
            captureId: int64(item["captureId"]!),
            timestampMs: int64(item["timestampMs"]!),
            record: item["record"] as! [String: Any],
            actionId: item["actionId"] as? String,
            stateKey: item["stateKey"] as? String
        )
    }

    private func query(of item: [String: Any]) -> CaptureQuery {
        CaptureQuery(
            view: item["view"] as! String,
            stream: item["stream"] as! String,
            sinceId: item["sinceId"].map(int64),
            sinceMs: item["sinceMs"].map(int64),
            limit: item["limit"] as? Int,
            afterActionId: item["afterActionId"] as? String
        )
    }

    private func budgets(of spec: [String: Any], defaults: [String: Any]) -> ByteBudgets {
        let raw = (spec["budgetBytes"] as? [String: Any]) ?? (defaults["budgetBytes"] as! [String: Any])
        return ByteBudgets(
            logs: raw["logs"] as! Int,
            network: raw["network"] as! Int,
            events: raw["events"] as! Int,
            state: raw["state"] as! Int
        )
    }

    private func caps(of spec: [String: Any], defaults: [String: Any]) -> CountCaps {
        let raw = (spec["countCaps"] as? [String: Any]) ?? (defaults["countCaps"] as! [String: Any])
        return CountCaps(
            logs: raw["logs"] as! Int,
            network: raw["network"] as! Int,
            events: raw["events"] as! Int,
            state: raw["state"] as! Int
        )
    }

    private func ids(of page: CapturePage) -> [Int64] {
        page.items.map { int64($0["id"]!) }
    }

    private func int64s(_ values: [Any]) -> [Int64] {
        values.map(int64)
    }

    private func int64(_ value: Any) -> Int64 {
        if let number = value as? Int64 { return number }
        if let number = value as? Int { return Int64(number) }
        if let number = value as? NSNumber { return number.int64Value }
        return 0
    }

    func testAppendQueryAndClearShareOneLock() {
        let store = MobileCaptureStore()
        let group = DispatchGroup()
        for worker in 1...4 {
            group.enter()
            DispatchQueue.global().async {
                defer { group.leave() }
                for index in 0..<80 {
                    let id = Int64(worker * 1_000 + index)
                    _ = store.append(
                        CaptureInput(
                            stream: "logs",
                            targetKey: "t",
                            runtimeEpoch: "e",
                            captureId: id,
                            timestampMs: id,
                            record: ["id": id, "message": "m\(id)"]
                        )
                    )
                    _ = store.query(CaptureQuery(view: "legacy-live", stream: "logs"))
                    if index % 20 == 0 {
                        _ = store.clear("all")
                    }
                }
            }
        }
        group.wait()
        _ = store.clear("all")
        XCTAssertEqual(store.query(CaptureQuery(view: "legacy-live", stream: "logs")).count, 0)
    }

    private func loadFixtures() throws -> [String: Any] {
        var dir = URL(fileURLWithPath: #file).deletingLastPathComponent()
        for _ in 0..<12 {
            let candidate = dir.appendingPathComponent("shared/mobile-capture-store/g1-contract-fixtures.json")
            if FileManager.default.isReadableFile(atPath: candidate.path) {
                let data = try Data(contentsOf: candidate)
                return try JSONSerialization.jsonObject(with: data) as! [String: Any]
            }
            dir = dir.deletingLastPathComponent()
        }
        XCTFail("g1-contract-fixtures.json not found from \(#file)")
        return [:]
    }
}
