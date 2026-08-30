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
            observer.start()
            observer.start()
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

    private func onMain(_ body: @escaping () -> Void) {
        if Thread.isMainThread {
            body()
        } else {
            DispatchQueue.main.sync(execute: body)
        }
    }
}
#endif
