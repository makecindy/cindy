// swift-tools-version: 5.9
import PackageDescription

let package = Package(
  name: "CindyRemoteCredentials",
  platforms: [.macOS(.v12), .iOS(.v16)],
  products: [
    .library(name: "CindyRemoteCredentials", targets: ["CindyRemoteCredentials"]),
    .executable(name: "cindy-macos-remote-credentials", targets: ["CredentialHost"]),
    .executable(name: "cindy-remote-unlock-inspect", targets: ["UnlockInspect"]),
  ],
  dependencies: [.package(url: "https://github.com/airsidemobile/JOSESwift.git", exact: "3.0.0")],
  targets: [
    .target(name: "DesktopNativeCaller"),
    .executableTarget(name: "CredentialHost", dependencies: ["CindyRemoteCredentials", "DesktopNativeCaller"]),
    .executableTarget(name: "UnlockInspect", dependencies: ["CindyRemoteCredentials"]),
    .target(name: "CindyRemoteCredentials", dependencies: ["JOSESwift"], resources: [.process("Resources")]),
    .testTarget(name: "CindyRemoteCredentialsTests", dependencies: ["CindyRemoteCredentials"]),
  ]
)
