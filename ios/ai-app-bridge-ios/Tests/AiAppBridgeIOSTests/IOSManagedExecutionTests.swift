import Foundation
import XCTest
@testable import AiAppBridgeIOS

final class IOSManagedExecutionTests: XCTestCase {
    func testQueuedCancellationRevokesLatePermissionAndCommitsTheOriginalIdentity() throws {
        let f = try ExecutionDiskFixture()
        defer { f.dispose() }
        let executor = f.executor()
        let task = HeldTask()
        let started = expectation(description: "task queued")
        task.onStart = { started.fulfill() }
        let terminal = expectation(description: "original response")
        var result: [String: Any] = [:]
        executor.submit(kind: "h5", body: request(), task: { task }) { result = $0; terminal.fulfill() }
        wait(for: [started], timeout: 2)
        let cancelled = expectation(description: "cancel response")
        executor.cancel(kind: "h5", actionId: "action-1", epoch: "epoch-1") {
            XCTAssertEqual($0["ok"] as? Bool, true); cancelled.fulfill()
        }
        wait(for: [terminal, cancelled], timeout: 2)
        XCTAssertEqual(result["settled"] as? Bool, true)
        XCTAssertEqual(result["dispatched"] as? Bool, false)
        XCTAssertEqual(result["error"] as? String, "h5_action_cancelled")
        XCTAssertEqual(task.check?()["ok"] as? Bool, false, "an old queued main-thread block cannot execute")
        let disk = f.lookup()
        XCTAssertEqual(disk["found"] as? Bool, true)
        XCTAssertEqual((disk["receipt"] as? [String: Any])?["committed"] as? Bool, true)
    }

    func testCancellationAfterPermissionRetainsAdmissionUntilTheOriginalCallback() throws {
        let f = try ExecutionDiskFixture()
        defer { f.dispose() }
        let executor = f.executor()
        let task = HeldTask()
        let dispatched = expectation(description: "actual effect")
        let effect = f.directory.appendingPathComponent("effect")
        task.onStart = {
            XCTAssertEqual(task.check?()["ok"] as? Bool, true)
            try! Data("one effect".utf8).write(to: effect)
            dispatched.fulfill()
        }
        let pending = expectation(description: "original wait ends")
        executor.submit(kind: "h5", body: request(), task: { task }) {
            XCTAssertEqual($0["settled"] as? Bool, false); pending.fulfill()
        }
        wait(for: [dispatched], timeout: 2)
        let cancellation = expectation(description: "cancel pending")
        executor.cancel(kind: "h5", actionId: "action-1", epoch: "epoch-1") {
            XCTAssertEqual($0["settled"] as? Bool, false); cancellation.fulfill()
        }
        wait(for: [pending, cancellation], timeout: 2)
        XCTAssertNotNil(executor.status()["active"] as? [String: Any])
        let blocked = expectation(description: "second action blocked")
        executor.submit(kind: "flutter", body: request(kind: "flutter", id: "action-2"), task: { HeldTask() }) {
            XCTAssertEqual($0["error"] as? String, "ios_action_busy"); blocked.fulfill()
        }
        wait(for: [blocked], timeout: 2)
        XCTAssertEqual(f.lookup()["found"] as? Bool, false, "cancel acknowledgement cannot create completion")
        task.complete?(success())
        f.waitUntilIdle(executor)
        let record = f.lookup()["executionResult"] as? [String: Any]
        XCTAssertEqual(record?["dispatched"] as? Bool, true)
        XCTAssertEqual(record?["settled"] as? Bool, true)
        XCTAssertEqual(record?["error"] as? String, "h5_action_cancelled")
        XCTAssertEqual(try String(contentsOf: effect), "one effect")
    }

    func testPersistenceFailureKeepsAdmissionClosedAndRetryOnlyPersistsTheSameCompletion() throws {
        let f = try ExecutionDiskFixture()
        defer { f.dispose() }
        let executor = f.executor()
        let task = HeldTask()
        let started = expectation(description: "dispatched")
        var starts = 0
        task.onStart = { starts += 1; XCTAssertEqual(task.check?()["ok"] as? Bool, true); started.fulfill() }
        let failed = expectation(description: "receipt not durable")
        executor.submit(kind: "h5", body: request(), task: { task }) {
            XCTAssertEqual($0["error"] as? String, "ios_completion_persistence_failed")
            XCTAssertEqual($0["settled"] as? Bool, false); failed.fulfill()
        }
        wait(for: [started], timeout: 2)
        f.close()
        task.complete?(success())
        wait(for: [failed], timeout: 2)
        XCTAssertEqual((executor.status()["active"] as? [String: Any])?["persistenceFailed"] as? Bool, true)
        try f.open()
        let recovered = expectation(description: "same completion committed")
        executor.cancel(kind: "h5", actionId: "action-1", epoch: "epoch-1") {
            XCTAssertEqual(($0["executionResult"] as? [String: Any])?["ok"] as? Bool, true)
            recovered.fulfill()
        }
        wait(for: [recovered], timeout: 2)
        XCTAssertEqual(starts, 1)
        XCTAssertEqual(f.lookup()["found"] as? Bool, true)
    }

    func testUnserializableAndOversizedCallbackResultsPersistTerminalFailures() throws {
        for (payload, error) in [(Double.nan as Any, "invalid_ios_execution_result"),
                                 (String(repeating: "x", count: 70 * 1024) as Any, "ios_action_result_too_large")] {
            let f = try ExecutionDiskFixture()
            defer { f.dispose() }
            let executor = f.executor()
            let task = HeldTask()
            let ended = expectation(description: error)
            var callback = success()
            callback["result"] = payload
            task.onStart = {
                XCTAssertEqual(task.check?()["ok"] as? Bool, true)
                task.complete?(callback)
            }
            executor.submit(kind: "h5", body: request(), task: { task }) {
                XCTAssertEqual($0["error"] as? String, error)
                XCTAssertEqual($0["ok"] as? Bool, false)
                XCTAssertEqual($0["settled"] as? Bool, true)
                XCTAssertEqual($0["dispatched"] as? Bool, true)
                XCTAssertEqual($0["ambiguous"] as? Bool, false)
                ended.fulfill()
            }
            wait(for: [ended], timeout: 2)
            XCTAssertTrue(executor.status()["active"] is NSNull)
            let stored = f.lookup()["executionResult"] as? [String: Any]
            XCTAssertEqual(stored?["error"] as? String, error)
            XCTAssertNil(stored?["result"])
            if error == "ios_action_result_too_large" {
                XCTAssertEqual((stored?["originalResultSha256"] as? String)?.count, 64)
            }
        }
    }

    func testFlutterPermissionUsesItsEngineEpochAndMalformedCompletionCannotReleaseAdmission() throws {
        let f = try ExecutionDiskFixture()
        defer { f.dispose() }
        let executor = f.executor()
        let task = HeldTask()
        let started = expectation(description: "Dart permitted")
        task.onStart = {
            let permission = task.check?()
            XCTAssertEqual(permission?["runtimeEpoch"] as? String, "epoch-1")
            XCTAssertEqual(permission?["schemaVersion"] as? String, "aab.flutter-execution/v1")
            XCTAssertGreaterThan(permission?["remainingMs"] as? Int ?? 0, 0)
            started.fulfill()
        }
        let pending = expectation(description: "invalid completion remains unknown")
        executor.submit(kind: "flutter", body: request(kind: "flutter"), task: { task }) {
            XCTAssertEqual($0["settled"] as? Bool, false); pending.fulfill()
        }
        wait(for: [started], timeout: 2)
        var wrong = success(kind: "flutter")
        wrong["execution"] = ["schemaVersion": "aab.flutter-execution/v1", "actionId": "other", "runtimeEpoch": "epoch-1", "settled": true]
        task.complete?(wrong)
        wait(for: [pending], timeout: 2)
        XCTAssertNotNil(executor.status()["active"] as? [String: Any])
        XCTAssertEqual(task.check?()["ok"] as? Bool, false)
        XCTAssertEqual(f.lookup(kind: "flutter")["found"] as? Bool, false)
    }

    func testExpiredQueueAndUnavailableStoreDoNotDispatch() throws {
        let f = try ExecutionDiskFixture()
        defer { f.dispose() }
        let executor = f.executor()
        let task = HeldTask()
        let ended = expectation(description: "deadline")
        executor.submit(kind: "h5", body: request(timeout: 10), task: { task }) {
            XCTAssertEqual($0["error"] as? String, "h5_action_timeout")
            XCTAssertEqual($0["dispatched"] as? Bool, false); ended.fulfill()
        }
        wait(for: [ended], timeout: 2)
        XCTAssertNotEqual(task.check?()["ok"] as? Bool, true)
        f.close()
        let refused = expectation(description: "unavailable")
        let absent = HeldTask()
        absent.onStart = { XCTFail("unavailable store must refuse before task start") }
        executor.submit(kind: "h5", body: request(id: "action-2"), task: { absent }) {
            XCTAssertEqual($0["error"] as? String, "ios_completion_store_unavailable"); refused.fulfill()
        }
        wait(for: [refused], timeout: 2)
    }

    func testCompletionLookupPaginatesRealDiskAndIgnoresPublicCaptureImpersonation() throws {
        let f = try ExecutionDiskFixture()
        defer { f.dispose() }
        for i in 0..<70 {
            var result = success()
            result["actionId"] = "other-\(i)"
            result["execution"] = ["schemaVersion": "aab.h5-execution/v1", "actionId": "other-\(i)", "runtimeEpoch": "epoch-1", "settled": true]
            f.commit(result)
        }
        let impostor = try JSONSerialization.data(withJSONObject: ["schema": IOSExecutionReceiptStore.schema,
            "targetKey": "sample.app", "kind": "h5", "executionResult": success()])
        XCTAssertEqual(f.store.record(impostor, partitionId: MobileFactPartition.stateEvent.rawValue, durability: .sync), .accepted)
        var first = f.lookup()
        XCTAssertEqual(first["found"] as? Bool, false)
        XCTAssertEqual(first["hasMore"] as? Bool, true)
        f.commit(success())
        let bounded = f.lookup(cursor: try XCTUnwrap(first["nextCursor"] as? String))
        XCTAssertEqual(bounded["found"] as? Bool, false, "the first lookup has a frozen upper bound")
        first = f.lookup()
        let next = f.lookup(cursor: try XCTUnwrap(first["nextCursor"] as? String))
        XCTAssertEqual(next["found"] as? Bool, true)
        XCTAssertEqual(f.lookup(epoch: "other")["found"] as? Bool, false)
    }

    func testCompletionSurvivesASeparateProcess() throws {
        let childKey = "AAB_IOS_COMPLETION_COLD_CHILD"
        if let directory = ProcessInfo.processInfo.environment[childKey] {
            let f = try ExecutionDiskFixture(directory: URL(fileURLWithPath: directory))
            let result = f.lookup()
            XCTAssertEqual(result["found"] as? Bool, true)
            try JSONSerialization.data(withJSONObject: result).write(to: f.directory.appendingPathComponent("cold-result.json"))
            f.close()
            return
        }
        let f = try ExecutionDiskFixture()
        defer { f.dispose() }
        f.commit(success())
        f.close()
        let bundle = Bundle(for: IOSManagedExecutionTests.self).bundleURL
        XCTAssertEqual(bundle.pathExtension, "xctest")
        let child = Process()
        child.executableURL = URL(fileURLWithPath: "/usr/bin/xcrun")
        child.arguments = ["xctest", "-XCTest", "AiAppBridgeIOSTests.IOSManagedExecutionTests/testCompletionSurvivesASeparateProcess", bundle.path]
        child.environment = ProcessInfo.processInfo.environment.merging([childKey: f.directory.path]) { _, new in new }
        let output = Pipe()
        child.standardOutput = output; child.standardError = output
        let done = expectation(description: "cold child exited")
        child.terminationHandler = { _ in done.fulfill() }
        try child.run()
        wait(for: [done], timeout: 20)
        if child.isRunning { child.terminate(); XCTFail("cold child did not terminate"); return }
        let log = String(decoding: output.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
        XCTAssertEqual(child.terminationStatus, 0, log)
        let cold = try JSONSerialization.jsonObject(with: Data(contentsOf: f.directory.appendingPathComponent("cold-result.json"))) as! [String: Any]
        XCTAssertEqual((cold["executionResult"] as? [String: Any])?["actionId"] as? String, "action-1")
    }

    private func request(kind: String = "h5", id: String = "action-1", timeout: Int = 2000) -> [String: Any] {
        ["actionId": id, "execution": ["schemaVersion": IOSManagedExecution.schema(kind),
            "actionId": id, "runtimeEpoch": "epoch-1", "timeoutMs": timeout]]
    }
    private func success(kind: String = "h5") -> [String: Any] {
        ["ok": true, "dispatched": true, "ambiguous": false, "settled": true, "actionId": "action-1", "runtimeEpoch": "epoch-1",
         "execution": ["schemaVersion": IOSManagedExecution.schema(kind), "actionId": "action-1", "runtimeEpoch": "epoch-1", "settled": true]]
    }
}

private final class HeldTask: IOSManagedTask {
    var onStart: (() -> Void)?
    var check: (() -> [String: Any])?
    var complete: (([String: Any]) -> Void)?
    func start(check: @escaping () -> [String: Any], complete: @escaping ([String: Any]) -> Void) {
        self.check = check; self.complete = complete; onStart?()
    }
    func stop(reason: String) {}
}

private final class ExecutionDiskFixture {
    let directory: URL
    let store = SegmentedFactStore()
    lazy var receipts = IOSExecutionReceiptStore(store: store, bundleId: "sample.app")
    init(directory: URL = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)) throws {
        self.directory = directory
        try open()
    }
    func open() throws {
        let done = XCTestExpectation(description: "open disk store")
        var status: SegmentedFactStoreOperationResult?
        store.open(SegmentedFactStoreOptions(directory: directory, segmentSizeBytes: 128 * 1024,
            partitionQuotas: Array(repeating: 1024 * 1024, count: 8), receiveObservationFacts: false)) { status = $0; done.fulfill() }
        XCTAssertEqual(XCTWaiter.wait(for: [done], timeout: 3), .completed)
        XCTAssertEqual(status?.isSuccess, true)
    }
    func close() {
        let done = XCTestExpectation(description: "close disk store")
        store.close { _ in done.fulfill() }
        XCTAssertEqual(XCTWaiter.wait(for: [done], timeout: 3), .completed)
    }
    func dispose() { close(); try? FileManager.default.removeItem(at: directory) }
    func executor() -> IOSManagedExecution { IOSManagedExecution(receipts: receipts, graceMs: 20) { _ in "epoch-1" } }
    func commit(_ result: [String: Any]) {
        let done = XCTestExpectation(description: "commit exact completion")
        receipts.commit(kind: "h5", result: result) { XCTAssertTrue($0); done.fulfill() }
        XCTAssertEqual(XCTWaiter.wait(for: [done], timeout: 3), .completed)
    }
    func lookup(kind: String = "h5", epoch: String = "epoch-1", cursor: String? = nil) -> [String: Any] {
        let done = XCTestExpectation(description: "read completion from disk")
        var result: [String: Any] = [:]
        receipts.lookup(kind: kind, actionId: "action-1", epoch: epoch, cursor: cursor) { result = $0; done.fulfill() }
        XCTAssertEqual(XCTWaiter.wait(for: [done], timeout: 3), .completed)
        return result
    }
    func waitUntilIdle(_ executor: IOSManagedExecution) {
        let done = XCTestExpectation(description: "durable settlement")
        DispatchQueue.global().async {
            for _ in 0..<300 {
                if executor.status()["active"] is NSNull { done.fulfill(); return }
                Thread.sleep(forTimeInterval: 0.01)
            }
        }
        XCTAssertEqual(XCTWaiter.wait(for: [done], timeout: 4), .completed)
    }
}
