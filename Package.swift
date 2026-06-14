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
            name: "AiAppBridgeIOS",
            path: "ios/ai-app-bridge-ios/Sources/AiAppBridgeIOS"
        )
    ]
)
