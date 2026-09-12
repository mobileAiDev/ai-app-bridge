import Foundation

// The descriptor is copied through devicectl from one device's App container.
// Its epoch binds routing to this process; it is not an authentication token.
struct IOSRuntimeIdentity {
    static let schemaVersion = "aab.ios-runtime/v1"
    let bundleId: String
    let runtimeEpoch: String
    let processId: Int32
    let port: UInt16

    var json: [String: Any] {
        ["schemaVersion": Self.schemaVersion, "bundleId": bundleId,
         "runtimeEpoch": runtimeEpoch, "processId": Int(processId), "port": Int(port)]
    }

    func publish(to url: URL, ready: Bool, sdkVersion: String, error: String?) throws {
        var descriptor = json
        descriptor["ok"] = ready
        descriptor["sdkVersion"] = sdkVersion
        descriptor["updatedAtMs"] = Int64(Date().timeIntervalSince1970 * 1000)
        descriptor["error"] = error ?? NSNull()
        let data = try JSONSerialization.data(withJSONObject: descriptor, options: [.sortedKeys])
        try data.write(to: url, options: [.atomic])
    }

    func admissionError(headers: [String: [String]], descriptorReady: Bool) -> String? {
        guard descriptorReady else { return "ios_runtime_descriptor_unavailable" }
        let expected = [
            "x-aab-runtime-schema": Self.schemaVersion,
            "x-aab-bundle-id": bundleId,
            "x-aab-runtime-epoch": runtimeEpoch,
            "x-aab-process-id": String(processId),
            "x-aab-runtime-port": String(port)
        ]
        if expected.keys.contains(where: { headers[$0] == nil }) { return "ios_runtime_binding_required" }
        if expected.contains(where: { headers[$0.key] != [$0.value] }) { return "ios_runtime_binding_mismatch" }
        return nil
    }

    static func requiresBinding(method: String, path: String) -> Bool {
        // Capture producers publish into their own SDK. Host reads and controls
        // must carry identity even when using a manually forwarded endpoint.
        let captureInputs = ["/v1/logs", "/v1/network", "/v1/state", "/v1/events", "/v1/flutter/snapshot"]
        return method == "GET" || (method == "POST" && !captureInputs.contains(path))
    }
}
