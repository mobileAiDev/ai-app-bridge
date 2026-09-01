import XCTest
@testable import AiAppBridgeIOS

final class AutomaticLogCaptureTests: XCTestCase {
    func testH5ConsoleDrainParserReadsArrayAndJsonString() {
        let array = H5ConsoleDrainParser.parse([
            ["method": "warn", "message": "hello", "atMs": 10]
        ])
        let text = H5ConsoleDrainParser.parse(
            "[{\"method\":\"error\",\"message\":\"boom\",\"atMs\":11}]"
        )

        XCTAssertEqual(array.map(\.method), ["warn"])
        XCTAssertEqual(array.map(\.message), ["hello"])
        XCTAssertEqual(text.map(\.method), ["error"])
        XCTAssertTrue(H5ConsoleDrainParser.parse("undefined").isEmpty)
        XCTAssertTrue(H5ConsoleDrainParser.parse("not-json").isEmpty)
        XCTAssertTrue(H5ConsoleDrainParser.parse(123).isEmpty)
        let missing = H5ConsoleDrainParser.parse([["message": "only-message"]])
        XCTAssertEqual(missing.map(\.method), ["log"])
        XCTAssertEqual(missing.map(\.message), ["only-message"])
    }
}
