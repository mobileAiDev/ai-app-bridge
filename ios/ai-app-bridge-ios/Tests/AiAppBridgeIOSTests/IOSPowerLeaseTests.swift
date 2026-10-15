import Foundation
import XCTest
@testable import AiAppBridgeIOS

final class IOSPowerLeaseTests: XCTestCase {
    private let first = "c3b1e4ce-7b48-456a-a5e1-9b786e874039"
    private let second = "95f8b7ac-b176-4347-9bcd-54d1ec6f8c3b"
    private func acquire(_ id: String, ttl: Int = 1000) -> [String: Any] {
        ["operation": "acquire", "leaseId": id, "mode": "display", "ttlMs": ttl]
    }

    func testOverlappingLeasesRenewExpireAndRestoreOnlyAfterLastOwner() {
        var disabled = false, time: TimeInterval = 0
        let controller = IOSPowerLeaseController(readIdleDisabled: { disabled }, writeIdleDisabled: { disabled = $0 },
            isForeground: { true }, now: { time }, automaticallySchedule: false)
        XCTAssertEqual(controller.control(acquire(first))["ok"] as? Bool, true)
        XCTAssertTrue(disabled)
        XCTAssertEqual(controller.control(acquire(second, ttl: 3000))["ok"] as? Bool, true)
        time = 0.5
        XCTAssertEqual(controller.control(["operation": "renew", "leaseId": first, "ttlMs": 2000])["ok"] as? Bool, true)
        time = 2
        XCTAssertEqual(controller.control(["operation": "status", "leaseId": first])["active"] as? Bool, true)
        XCTAssertEqual(controller.control(["operation": "release", "leaseId": second])["released"] as? Bool, true)
        XCTAssertTrue(disabled)
        time = 3
        XCTAssertEqual(controller.control(["operation": "status", "leaseId": first])["active"] as? Bool, false)
        XCTAssertFalse(disabled)
        XCTAssertEqual(controller.control(["operation": "renew", "leaseId": first, "ttlMs": 2000])["error"] as? String, "power_lease_ended")
    }

    func testAutomaticPlatformExpiryDoesNotNeedAnotherHostRequest() {
        var disabled = false
        let controller = IOSPowerLeaseController(readIdleDisabled: { disabled }, writeIdleDisabled: { disabled = $0 }, isForeground: { true })
        XCTAssertEqual(controller.control(acquire(first, ttl: 30))["ok"] as? Bool, true)
        let expired = expectation(description: "The platform timer expires independently of Host calls")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
            XCTAssertFalse(disabled)
            XCTAssertEqual(controller.control(["operation": "status", "leaseId": self.first])["active"] as? Bool, false)
            expired.fulfill()
        }
        wait(for: [expired], timeout: 1)
    }

    func testAppResignOrTransportStopRestoresPreexistingStateAndDoesNotProtectExternalApps() {
        var disabled = true, foreground = true
        let controller = IOSPowerLeaseController(readIdleDisabled: { disabled }, writeIdleDisabled: { disabled = $0 },
            isForeground: { foreground }, automaticallySchedule: false)
        let result = controller.control(acquire(first))
        let coverage = result["coverage"] as? [String: Any]
        XCTAssertEqual(coverage?["scope"] as? String, "selected-sdk-app-foreground")
        XCTAssertEqual(coverage?["externalApps"] as? Bool, false)
        controller.releaseAll()
        XCTAssertTrue(disabled)
        disabled = false
        foreground = false
        XCTAssertEqual(controller.control(acquire(second))["error"] as? String, "power_ios_app_not_foreground")
        XCTAssertFalse(disabled)
    }

    func testInvalidModeAndMalformedRequestsHaveNoIdleTimerSideEffectAndRequireRuntimeBinding() {
        var writes = 0
        let controller = IOSPowerLeaseController(readIdleDisabled: { false }, writeIdleDisabled: { _ in writes += 1 },
            isForeground: { true }, automaticallySchedule: false)
        var request = acquire(first)
        request["mode"] = "both"
        XCTAssertEqual(controller.control(request)["error"] as? String, "power_mode_unsupported")
        for invalid: Any in [true, 1.5, 0, 300001, "1000"] {
            request = acquire(first); request["ttlMs"] = invalid
            XCTAssertEqual(controller.control(request)["error"] as? String, "invalid_power_request")
        }
        request = acquire(first); request["extra"] = "no"
        XCTAssertEqual(controller.control(request)["error"] as? String, "invalid_power_request")
        XCTAssertEqual(writes, 0)
        XCTAssertTrue(IOSRuntimeIdentity.requiresBinding(method: "POST", path: "/v1/power"))
    }
}
