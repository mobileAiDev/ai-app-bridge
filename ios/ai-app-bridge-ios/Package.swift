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
            path: "Sources/SegmentedFactStoreC",
            publicHeadersPath: "include"
        ),
        .target(
            name: "AiAppBridgeFactStoreC",
            dependencies: ["SegmentedFactStoreC"],
            path: "Sources/AiAppBridgeFactStoreC",
            publicHeadersPath: "include",
            linkerSettings: [
                .linkedFramework("Foundation")
            ]
        ),
        .target(
            name: "AiAppBridgeIOS",
            dependencies: ["AiAppBridgeFactStoreC"],
            path: "Sources/AiAppBridgeIOS"
        ),
        .testTarget(
            name: "AiAppBridgeIOSTests",
            dependencies: ["AiAppBridgeIOS"],
            path: "Tests/AiAppBridgeIOSTests"
        )
    ]
)
