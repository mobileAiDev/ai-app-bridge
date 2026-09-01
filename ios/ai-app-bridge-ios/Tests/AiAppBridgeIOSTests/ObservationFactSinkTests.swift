import XCTest
@testable import AiAppBridgeIOS

final class ObservationFactSinkTests: XCTestCase {
    func testDiskPayloadKeepsBodiesAndNonTokenQueryValues() throws {
        let payload = try SanitizedFactPayload.network(
            context: context(),
            record: [
                "url": "https://example.test/orders?token=query-secret&station=station-secret#fragment",
                "requestBody": "request-secret",
                "responseBody": "response-secret",
                "headers": [
                    "Authorization": "Bearer header-secret",
                    "Cookie": "session=cookie-secret"
                ]
            ]
        )
        let encoded = String(decoding: payload.data, as: UTF8.self)

        XCTAssertTrue(encoded.contains("query-secret"))
        XCTAssertTrue(encoded.contains("station-secret"))
        XCTAssertTrue(encoded.contains("request-secret"))
        XCTAssertTrue(encoded.contains("response-secret"))
        XCTAssertTrue(encoded.contains("header-secret"))
        XCTAssertTrue(encoded.contains("cookie-secret"))
        XCTAssertFalse(encoded.contains("\"omitted\":true"))
    }

    func testCanonicalEnvelopeRoutesEveryAppCaptureStreamAndKeepsPathAndQuery() throws {
        let context = context()
        let facts = try [
            SanitizedFactPayload.log(context: context, record: ["message": "ready"]),
            SanitizedFactPayload.network(
                context: context,
                record: [
                    "url": "https://school.example.test/tokenpluginfile.php/path-secret/42/file.jpg?code=query-secret&view=summary"
                ]
            ),
            SanitizedFactPayload.state(context: context, record: ["key": "cart"]),
            SanitizedFactPayload.event(
                context: context,
                category: "app",
                name: "cart.updated",
                data: ["count": 2]
            ),
            SanitizedFactPayload.event(
                context: context,
                category: "ui",
                name: "ui.changed",
                data: ["nodeCount": 3]
            ),
            SanitizedFactPayload.deviceLog(context: context, record: ["message": "logcat-line"])
        ]

        XCTAssertEqual(facts.map(\.partitionId), [2, 0, 4, 4, 1, 3])
        let deviceLog = try XCTUnwrap(
            JSONSerialization.jsonObject(with: facts[5].data) as? [String: Any]
        )
        XCTAssertEqual(deviceLog["partition"] as? String, "device-log")
        let devicePayload = try XCTUnwrap(deviceLog["payload"] as? [String: Any])
        XCTAssertEqual(devicePayload["stream"] as? String, "logcat")
        let envelope = try XCTUnwrap(
            JSONSerialization.jsonObject(with: facts[1].data) as? [String: Any]
        )
        XCTAssertEqual(envelope["partition"] as? String, "network")
        XCTAssertEqual(envelope["platform"] as? String, "ios")
        XCTAssertEqual(envelope["targetKey"] as? String, "ios:sha256:device:com.example.app")
        XCTAssertEqual(envelope["runtimeEpoch"] as? String, "runtime-1")
        XCTAssertEqual(envelope["actionId"] as? String, "action-7")
        let timestamps = try XCTUnwrap(envelope["timestamps"] as? [String: Any])
        XCTAssertEqual((timestamps["occurredAtMs"] as? NSNumber)?.int64Value, 100)
        XCTAssertEqual((timestamps["observedAtMs"] as? NSNumber)?.int64Value, 110)
        let payload = try XCTUnwrap(envelope["payload"] as? [String: Any])
        XCTAssertEqual(payload["kind"] as? String, "evidence")
        XCTAssertEqual(payload["stream"] as? String, "network")
        let encoded = String(decoding: facts[1].data, as: UTF8.self)
        XCTAssertTrue(encoded.contains("path-secret"))
        XCTAssertTrue(encoded.contains("query-secret"))
        XCTAssertTrue(encoded.contains("view=summary"))
        XCTAssertTrue(encoded.contains("bundleId"))
        XCTAssertTrue(encoded.contains("deviceIdentity"))
        XCTAssertTrue(encoded.contains("iPhone Test"))
    }

    private func context() -> MobileFactEnvelopeContext {
        .init(
            platform: "ios",
            packageName: nil,
            bundleId: "com.example.app",
            model: "iPhone Test",
            deviceIdentity: "sha256:device",
            runtimeEpoch: "runtime-1",
            actionId: "action-7",
            occurredAtMs: 100,
            observedAtMs: 110
        )
    }
}
