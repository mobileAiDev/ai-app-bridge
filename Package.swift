// swift-tools-version: 5.9

import PackageDescription

let package = Package(
    name: "AiAppBridgeIOS",
    platforms: [
        .iOS(.v13)
    ],
    products: [
        .library(
            name: "AiAppBridgeIOS",
            targets: ["AiAppBridgeIOS"]
        )
    ],
    targets: [
        .target(
            name: "SegmentedFactStoreC",
            path: "ios/ai-app-bridge-ios/Sources/SegmentedFactStoreC",
            publicHeadersPath: "include"
        ),
        .target(
            name: "AiAppBridgeFactStoreC",
            dependencies: ["SegmentedFactStoreC"],
            path: "ios/ai-app-bridge-ios/Sources/AiAppBridgeFactStoreC",
            publicHeadersPath: "include",
            linkerSettings: [
                .linkedFramework("Foundation")
            ]
        ),
        .target(
            name: "AiAppBridgeIOS",
            dependencies: ["AiAppBridgeFactStoreC"],
            path: "ios/ai-app-bridge-ios/Sources/AiAppBridgeIOS"
        )
    ]
)
