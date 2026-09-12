// Compile alongside modules/cindy-incoming-share/ios/IncomingShareSlot.swift.
import Foundation
import Darwin

@main
enum IncomingShareSlotTest {
  static func main() throws {
    let arguments = CommandLine.arguments
    if arguments.count > 1 {
      let lock = URL(fileURLWithPath: arguments[1])
      // Prove that the other process cannot enter the compare/clear window.
      let fd = open(lock.path, O_RDWR)
      precondition(fd >= 0)
      precondition(flock(fd, LOCK_EX | LOCK_NB) == -1 && errno == EWOULDBLOCK)
      close(fd)
      FileHandle.standardOutput.write(Data([1]))
      try IncomingShareSlot.withLock(at: lock) {
        let defaults = UserDefaults(suiteName: arguments[2])!
        precondition(defaults.synchronize())
        defaults.set(Data("B".utf8), forKey: IncomingShareSlot.key)
        precondition(defaults.synchronize())
      }
      return
    }

    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let suite = "cindy-share-test-" + UUID().uuidString
    let defaults = UserDefaults(suiteName: suite)!
    defer { defaults.removePersistentDomain(forName: suite); defaults.synchronize() }
    let lock = root.appendingPathComponent("slot.lock")
    let a = Data("A".utf8)
    let b = Data("B".utf8)
    defaults.set(a, forKey: IncomingShareSlot.key)
    precondition(defaults.synchronize())

    let writer = Process()
    writer.executableURL = URL(fileURLWithPath: arguments[0])
    writer.arguments = [lock.path, suite]
    let ready = Pipe()
    writer.standardOutput = ready
    try IncomingShareSlot.withLock(at: lock) {
      precondition(defaults.data(forKey: IncomingShareSlot.key) == a)
      try writer.run()
      precondition(ready.fileHandleForReading.readData(ofLength: 1) == Data([1]))
      // B has attempted to write after comparison. It must wait for clearing A.
      let cleared = try IncomingShareSlot.clear(a, from: defaults)
      precondition(cleared)
    }
    writer.waitUntilExit()
    precondition(writer.terminationStatus == 0)
    try IncomingShareSlot.withLock(at: lock) {
      precondition(defaults.synchronize())
      precondition(defaults.data(forKey: IncomingShareSlot.key) == b)
      let staleCleared = try IncomingShareSlot.clear(a, from: defaults)
      precondition(!staleCleared && defaults.data(forKey: IncomingShareSlot.key) == b)
      let currentCleared = try IncomingShareSlot.clear(b, from: defaults)
      let duplicateCleared = try IncomingShareSlot.clear(b, from: defaults)
      precondition(currentCleared && !duplicateCleared)
    }
    // An error must release the lock as well.
    do { try IncomingShareSlot.withLock(at: lock) { throw POSIXError(.EIO) } } catch {}
    try IncomingShareSlot.withLock(at: lock) {}
    print("PASS: cross-process exclusion, stale/current/duplicate acknowledgement, error unlock")
  }
}
