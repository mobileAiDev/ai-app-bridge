#if DEBUG && canImport(UIKit)
import UIKit
import XCTest
@testable import AiAppBridgeIOS

final class AiAppBridgeUiObserverTests: XCTestCase {
    func testStartIsIdempotentAndStopCleansResources() {
        var names: [String] = []
        let observer = AiAppBridgeUiObserver { _, name, _ in
            names.append(name)
        }

        onMain {
            XCTAssertFalse(observer.isStarted)
            XCTAssertEqual(observer.control(["operation": "start", "durationMs": 1000])["ok"] as? Bool, true)
            XCTAssertEqual(observer.control(["operation": "start", "durationMs": 1000])["error"] as? String, "ui_observation_busy")
            XCTAssertTrue(observer.isStarted)
            observer.stop()
            XCTAssertFalse(observer.isStarted)
        }

        XCTAssertEqual(names.filter { $0 == "ui.observer.started" }.count, 1)
    }

    func testSecureInputEventContainsOnlySecurityFlagAndLength() {
        let field = UITextField()
        field.isSecureTextEntry = true
        field.text = "do-not-record"

        let event = AiAppBridgeUiObserver.sanitizedInputEvent(view: field, timestampMs: 123)
        let input = event["input"] as? [String: Any]

        XCTAssertEqual(input?["secure"] as? Bool, true)
        XCTAssertEqual(input?["textLength"] as? Int, 13)
        XCTAssertEqual(input?["rawTextCaptured"] as? Bool, false)
        XCTAssertFalse(String(describing: event).contains("do-not-record"))
    }

    func testWindowRejectsUnboundedDurationAndWrongOwnerThenExpires() {
        var cleanupCount = 0
        let observer = AiAppBridgeUiObserver(onStop: { cleanupCount += 1 }) { _, _, _ in }
        let expired = expectation(description: "window expires without Host cleanup")
        onMain {
            XCTAssertEqual(observer.control(["operation": "start", "durationMs": 5001])["ok"] as? Bool, false)
            XCTAssertEqual(observer.control(["operation": "start", "durationMs": true])["ok"] as? Bool, false)
            XCTAssertEqual(observer.sampleCount, 0)
            XCTAssertEqual(observer.control(["operation": "start", "durationMs": 100])["ok"] as? Bool, true)
            XCTAssertEqual(observer.control(["operation": "stop", "leaseId": "another-owner"])["ok"] as? Bool, false)
            XCTAssertTrue(observer.isStarted)
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) {
                XCTAssertFalse(observer.isStarted)
                XCTAssertEqual(observer.status["remainingMs"] as? Int64, 0)
                XCTAssertEqual(cleanupCount, 1)
                expired.fulfill()
            }
        }
        wait(for: [expired], timeout: 2)
    }

    func testBackgroundStopsAssociatedCaptureAndDoesNotReopenOnForeground() {
        var cleanupCount = 0
        let observer = AiAppBridgeUiObserver(onStop: { cleanupCount += 1 }) { _, _, _ in }
        onMain {
            XCTAssertEqual(observer.control(["operation": "start", "durationMs": 5000])["ok"] as? Bool, true)
            NotificationCenter.default.post(name: UIApplication.didEnterBackgroundNotification, object: nil)
            XCTAssertFalse(observer.isStarted)
            XCTAssertEqual(cleanupCount, 1)
            NotificationCenter.default.post(name: UIApplication.didBecomeActiveNotification, object: nil)
            XCTAssertFalse(observer.isStarted)
        }
    }

    private func onMain(_ body: @escaping () -> Void) {
        if Thread.isMainThread {
            body()
        } else {
            DispatchQueue.main.sync(execute: body)
        }
    }
}
#endif
