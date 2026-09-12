import Foundation
import XCTest
@testable import AiAppBridgeIOS

final class IOSRuntimeIdentityTests: XCTestCase {
    private let identity = IOSRuntimeIdentity(bundleId: "sample.app", runtimeEpoch: "epoch-1", processId: 42, port: 18080)

    private var headers: [String: [String]] {
        ["x-aab-runtime-schema": ["aab.ios-runtime/v1"], "x-aab-bundle-id": ["sample.app"],
         "x-aab-runtime-epoch": ["epoch-1"], "x-aab-process-id": ["42"], "x-aab-runtime-port": ["18080"]]
    }

    func testDescriptorIsActuallyReplacedOnDiskWithTheNewProcessIdentity() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let url = directory.appendingPathComponent("ai_app_bridge_port.json")
        let unbound = IOSRuntimeIdentity(bundleId: "sample.app", runtimeEpoch: "epoch-1", processId: 42, port: 0)
        try unbound.publish(to: url, ready: false, sdkVersion: "test", error: "starting")
        let starting = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        XCTAssertEqual(starting["ok"] as? Bool, false)
        XCTAssertEqual(starting["port"] as? Int, 0)
        XCTAssertEqual(starting["error"] as? String, "starting")
        let next = IOSRuntimeIdentity(bundleId: "sample.app", runtimeEpoch: "epoch-2", processId: 43, port: 18081)
        try next.publish(to: url, ready: true, sdkVersion: "test", error: nil)
        let read = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        XCTAssertEqual(read["ok"] as? Bool, true)
        XCTAssertEqual(read["schemaVersion"] as? String, "aab.ios-runtime/v1")
        XCTAssertEqual(read["runtimeEpoch"] as? String, "epoch-2")
        XCTAssertEqual(read["processId"] as? Int, 43)
        XCTAssertEqual(read["port"] as? Int, 18081)
        XCTAssertThrowsError(try identity.publish(to: directory.appendingPathComponent("missing/file"), ready: true, sdkVersion: "test", error: nil))
    }

    func testMissingMismatchedAndDuplicateHeadersAreRejectedBeforeDispatch() {
        XCTAssertNil(identity.admissionError(headers: headers, descriptorReady: true))
        XCTAssertEqual(identity.admissionError(headers: headers, descriptorReady: false), "ios_runtime_descriptor_unavailable")
        for key in headers.keys {
            var missing = headers
            missing.removeValue(forKey: key)
            XCTAssertEqual(identity.admissionError(headers: missing, descriptorReady: true), "ios_runtime_binding_required", key)
            var wrong = headers
            wrong[key] = ["different"]
            XCTAssertEqual(identity.admissionError(headers: wrong, descriptorReady: true), "ios_runtime_binding_mismatch", key)
            var duplicate = headers
            duplicate[key] = headers[key]! + headers[key]!
            XCTAssertEqual(identity.admissionError(headers: duplicate, descriptorReady: true), "ios_runtime_binding_mismatch", key)
        }
        let restarted = IOSRuntimeIdentity(bundleId: "sample.app", runtimeEpoch: "epoch-2", processId: 43, port: 18080)
        XCTAssertEqual(restarted.admissionError(headers: headers, descriptorReady: true), "ios_runtime_binding_mismatch")
    }

    func testWireParserPreservesIdentityAndDuplicateHeadersForAdmission() throws {
        let rawHeaders = headers.map { key, values in "\(key): \(values[0])" }.joined(separator: "\r\n")
        let wire = "POST /v1/h5/eval?limit=2 HTTP/1.1\r\n\(rawHeaders)\r\nContent-Length: 2\r\n\r\n{}"
        let request = try XCTUnwrap(IOSHttpRequest.parse(Data(wire.utf8)))
        XCTAssertEqual(request.method, "POST")
        XCTAssertEqual(request.path, "/v1/h5/eval")
        XCTAssertEqual(request.query["limit"], "2")
        XCTAssertEqual(request.body, "{}")
        XCTAssertNil(identity.admissionError(headers: request.headers, descriptorReady: true))
        let duplicate = wire.replacingOccurrences(of: "Content-Length: 2", with: "X-AAB-Runtime-Epoch: epoch-1\r\nContent-Length: 2")
        let parsed = try XCTUnwrap(IOSHttpRequest.parse(Data(duplicate.utf8)))
        XCTAssertEqual(identity.admissionError(headers: parsed.headers, descriptorReady: true), "ios_runtime_binding_mismatch")
    }

    func testControlAndReadRoutesRequireBindingWhileCaptureIngressRetainsItsContract() {
        for path in ["/v1/status", "/v1/view/tree", "/v1/events", "/v1/h5/dom"] {
            XCTAssertTrue(IOSRuntimeIdentity.requiresBinding(method: "GET", path: path), path)
        }
        for path in ["/v1/h5/eval", "/v1/flutter/action", "/v1/app/clear-data", "/v1/action/tap"] {
            XCTAssertTrue(IOSRuntimeIdentity.requiresBinding(method: "POST", path: path), path)
        }
        for path in ["/v1/logs", "/v1/network", "/v1/state", "/v1/events", "/v1/flutter/snapshot"] {
            XCTAssertFalse(IOSRuntimeIdentity.requiresBinding(method: "POST", path: path), path)
        }
    }

    func testMalformedLengthAndUnboundedRequestsFailWithoutSlicingOrAllocatingTheirBody() throws {
        for length in ["-1", "abc", "999999999999999999999999", "4194305", "2\r\nContent-Length: 2"] {
            XCTAssertThrowsError(try IOSHttpRequest.parse(Data("POST / HTTP/1.1\r\nContent-Length: \(length)\r\n\r\n{}".utf8)), length)
        }
        XCTAssertNil(try IOSHttpRequest.parse(Data("POST / HTTP/1.1\r\nContent-Length: 4\r\n\r\n{}".utf8)))
        XCTAssertThrowsError(try IOSHttpRequest.parse(Data(repeating: 65, count: 16385)))
        XCTAssertThrowsError(try IOSHttpRequest.parse(Data("POST / HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n".utf8)))
    }
}
