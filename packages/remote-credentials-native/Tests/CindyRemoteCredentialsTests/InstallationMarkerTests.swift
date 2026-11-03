import Darwin
import XCTest
@testable import CindyRemoteCredentials

final class InstallationMarkerTests: XCTestCase {
  func testInterruptedTemporaryWriteDoesNotPoisonInstallation() throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("cindy-marker-test-" + UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let abandoned = directory.appendingPathComponent(".installation-id-" + UUID().uuidString)
    try Data("partial".utf8).write(to: abandoned)
    let id = try InstallationMarker.loadOrCreate(directory: directory)
    XCTAssertEqual(try InstallationMarker.loadOrCreate(directory: directory), id)
    XCTAssertEqual(try Data(contentsOf: abandoned), Data("partial".utf8))
    XCTAssertEqual(Set(try FileManager.default.contentsOfDirectory(atPath: directory.path)),
      Set(["installation-id", abandoned.lastPathComponent]))
  }

  func testConcurrentCreatorsAdoptOneCompleteMarker() throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("cindy-marker-test-" + UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let lock = NSLock()
    var ids = [UUID](), failures = 0
    DispatchQueue.concurrentPerform(iterations: 32) { _ in
      do {
        let id = try InstallationMarker.loadOrCreate(directory: directory)
        lock.lock(); ids.append(id); lock.unlock()
      } catch {
        lock.lock(); failures += 1; lock.unlock()
      }
    }
    XCTAssertEqual(failures, 0)
    XCTAssertEqual(ids.count, 32)
    XCTAssertEqual(Set(ids).count, 1)
    XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: directory.path), ["installation-id"])
  }

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

  func testLinkRefusalUsesExclusiveCreateOrExistingMarker() {
    XCTAssertEqual(InstallationPublish.decide(errno: EEXIST), .adoptedExisting)
    XCTAssertEqual(InstallationPublish.decide(errno: EACCES), .createExclusive)
    XCTAssertEqual(InstallationPublish.decide(errno: EPERM), .createExclusive)
    XCTAssertEqual(InstallationPublish.decide(errno: EXDEV), .createExclusive)
    XCTAssertEqual(InstallationPublish.decide(errno: ENOSYS), .createExclusive)
    XCTAssertEqual(InstallationPublish.decide(errno: ENOTSUP), .createExclusive)
    XCTAssertEqual(InstallationPublish.decide(errno: EIO), .unavailable)
  }

  func testExclusiveRenamePublishesACompleteFileAndDoesNotReplaceAWinner() throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("cindy-rename-excl-" + UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let dest = directory.appendingPathComponent("installation-id")
    let first = directory.appendingPathComponent("first")
    let second = directory.appendingPathComponent("second")
    let winner = Data(UUID().uuidString.lowercased().utf8)
    try winner.write(to: first)
    try Data(UUID().uuidString.lowercased().utf8).write(to: second)
    XCTAssertEqual(renamex_np(first.path, dest.path, UInt32(RENAME_EXCL)), 0)
    XCTAssertEqual(try Data(contentsOf: dest), winner)
    XCTAssertNotEqual(renamex_np(second.path, dest.path, UInt32(RENAME_EXCL)), 0)
    XCTAssertEqual(errno, EEXIST)
    XCTAssertEqual(try Data(contentsOf: dest), winner)
  }
}
