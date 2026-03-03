// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "Kerstel",
    platforms: [
        .macOS(.v14)
    ],
    targets: [
        .target(
            name: "KerstelCore",
            path: "Sources/KerstelCore",
            resources: [.copy("Resources/")],
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
        .executableTarget(
            name: "Kerstel",
            dependencies: ["KerstelCore"],
            path: "Sources/Kerstel",
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
        .testTarget(
            name: "KerstelTests",
            dependencies: ["KerstelCore"],
            path: "Tests/KerstelTests",
            swiftSettings: [.swiftLanguageMode(.v5)]
        )
    ]
)
