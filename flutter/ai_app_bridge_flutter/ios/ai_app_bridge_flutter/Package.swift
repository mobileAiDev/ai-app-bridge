// swift-tools-version: 5.9

import PackageDescription

let package = Package(
    name: "ai_app_bridge_flutter",
    platforms: [
        .iOS(.v13)
    ],
    products: [
        .library(
            name: "ai-app-bridge-flutter",
            targets: ["ai_app_bridge_flutter"]
        )
    ],
    dependencies: [
        .package(name: "FlutterFramework", path: "../FlutterFramework")
    ],
    targets: [
        .target(
            name: "ai_app_bridge_flutter",
            dependencies: [
                .product(name: "FlutterFramework", package: "FlutterFramework")
            ],
            path: "Sources"
        )
    ]
)
