// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "Sharkord",
    platforms: [.macOS(.v14)],
    products: [.executable(name: "Sharkord", targets: ["Sharkord"])],
    targets: [
        .executableTarget(name: "Sharkord", resources: [.copy("Resources")]),
        .testTarget(name: "SharkordTests", dependencies: ["Sharkord"])
    ]
)
