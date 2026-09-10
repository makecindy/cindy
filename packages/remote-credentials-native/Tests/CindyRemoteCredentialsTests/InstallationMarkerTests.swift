import XCTest
@testable import CindyRemoteCredentials

final class InstallationMarkerTests: XCTestCase {
  func testStableWithinInstallationAndNeverAdoptsMalformedOrLinkedMarker() throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("cindy-marker-test-" + UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let id = try InstallationMarker.loadOrCreate(directory: directory)
    XCTAssertEqual(try InstallationMarker.loadOrCreate(directory: directory), id)
    let file = directory.appendingPathComponent("installation-id")
    try Data("broken".utf8).write(to: file)
    XCTAssertThrowsError(try InstallationMarker.loadOrCreate(directory: directory))
    XCTAssertEqual(try Data(contentsOf: file), Data("broken".utf8))
    try FileManager.default.removeItem(at: file)
    let target = directory.appendingPathComponent("other")
    try Data(id.uuidString.lowercased().utf8).write(to: target)
    try FileManager.default.createSymbolicLink(at: file, withDestinationURL: target)
    XCTAssertThrowsError(try InstallationMarker.loadOrCreate(directory: directory))
  }
}
