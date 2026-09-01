import Foundation
import XCTest

final class SegmentedFactStoreSourceMirrorTests: XCTestCase {
    func testPublishableSourceMirrorsMatchCanonicalSourcesByteForByte() throws {
        let root = repositoryRoot()
        let canonical = root.appendingPathComponent("native/segmented-fact-store/src/sfs.c")
        guard FileManager.default.fileExists(atPath: canonical.path) else {
            throw XCTSkip("canonical monorepo sources are not present in a standalone package checkout")
        }

        let pairs: [(String, String)] = [
            (
                "native/segmented-fact-store/src/sfs.c",
                "ios/ai-app-bridge-ios/Sources/SegmentedFactStoreC/sfs.c"
            ),
            (
                "native/segmented-fact-store/include/sfs.h",
                "ios/ai-app-bridge-ios/Sources/SegmentedFactStoreC/include/sfs.h"
            ),
            (
                "native/segmented-fact-store/src/sfs.c",
                "flutter/ai_app_bridge_flutter/ios/ai_app_bridge_flutter/Sources/SegmentedFactStoreC/sfs.c"
            ),
            (
                "native/segmented-fact-store/include/sfs.h",
                "flutter/ai_app_bridge_flutter/ios/ai_app_bridge_flutter/Sources/SegmentedFactStoreC/include/sfs.h"
            ),
            (
                "ios/ai-app-bridge-ios/Sources/AiAppBridgeFactStoreC/AiAppBridgeFactStoreC.c",
                "flutter/ai_app_bridge_flutter/ios/ai_app_bridge_flutter/Sources/AiAppBridgeFactStoreC/AiAppBridgeFactStoreC.c"
            ),
            (
                "ios/ai-app-bridge-ios/Sources/AiAppBridgeFactStoreC/include/AiAppBridgeFactStoreC.h",
                "flutter/ai_app_bridge_flutter/ios/ai_app_bridge_flutter/Sources/AiAppBridgeFactStoreC/include/AiAppBridgeFactStoreC.h"
            ),
            (
                "ios/ai-app-bridge-ios/Sources/AiAppBridgeFactStoreC/include/aab_nslog_hook.h",
                "flutter/ai_app_bridge_flutter/ios/ai_app_bridge_flutter/Sources/AiAppBridgeFactStoreC/include/aab_nslog_hook.h"
            ),
            (
                "ios/ai-app-bridge-ios/Sources/AiAppBridgeFactStoreC/aab_nslog_hook.m",
                "flutter/ai_app_bridge_flutter/ios/ai_app_bridge_flutter/Sources/AiAppBridgeFactStoreC/aab_nslog_hook.m"
            ),
            (
                "ios/ai-app-bridge-ios/Sources/AiAppBridgeFactStoreC/fishhook.c",
                "flutter/ai_app_bridge_flutter/ios/ai_app_bridge_flutter/Sources/AiAppBridgeFactStoreC/fishhook.c"
            ),
            (
                "ios/ai-app-bridge-ios/Sources/AiAppBridgeFactStoreC/fishhook.h",
                "flutter/ai_app_bridge_flutter/ios/ai_app_bridge_flutter/Sources/AiAppBridgeFactStoreC/fishhook.h"
            )
        ] + swiftRuntimeSourcePairs

        for (source, mirror) in pairs {
            XCTAssertEqual(
                try Data(contentsOf: root.appendingPathComponent(source)),
                try Data(contentsOf: root.appendingPathComponent(mirror)),
                "source mirror drifted: \(mirror)"
            )
        }
    }

    private var swiftRuntimeSourcePairs: [(String, String)] {
        [
            "AiAppBridge.swift",
            "AiAppBridgeUiObserver.swift",
            "AutomaticLogCapture.swift",
            "H5ConsoleLog.swift",
            "ObservationFactSink.swift",
            "SegmentedFactStore.swift",
            "UiObservationStateMachine.swift"
        ].map { name in
            (
                "ios/ai-app-bridge-ios/Sources/AiAppBridgeIOS/\(name)",
                "flutter/ai_app_bridge_flutter/ios/ai_app_bridge_flutter/Sources/AiAppBridgeIOS/\(name)"
            )
        }
    }

    private func repositoryRoot() -> URL {
        var url = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<4 {
            url.deleteLastPathComponent()
        }
        return url
    }
}
