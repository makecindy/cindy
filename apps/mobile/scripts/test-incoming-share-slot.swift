// Compile alongside modules/cindy-incoming-share/ios/IncomingShareSlot.swift.
import Foundation
import Darwin

// Fault injection separates process cache from durable bytes. A failed flush
// must not be reported as successful removal or erase the retry state in memory.
final class RejectionDefaults: UserDefaults {
  var cached: Data?
  var durable: Data?
  var failRemoval = true
  init(_ persisted: Data?) { cached = persisted; durable = persisted; super.init(suiteName: UUID().uuidString)! }
  override func data(forKey key: String) -> Data? { cached }
  override func set(_ value: Any?, forKey key: String) { cached = value as? Data }
  override func removeObject(forKey key: String) { cached = nil }
  override func synchronize() -> Bool {
    if cached == nil && failRemoval { return false }
    durable = cached
    return true
  }
}

@main
enum IncomingShareSlotTest {
  static func main() throws {
    let arguments = CommandLine.arguments
    if arguments.count > 1 && ["--rejected", "--unknown"].contains(arguments[1]) {
      let persisted = UserDefaults(suiteName: arguments[2])!
      precondition(persisted.synchronize())
      precondition(IncomingShareSlot.read(Data("A".utf8), rejections: persisted) { _ in throw POSIXError(.EIO) } == nil)
      precondition(persisted.data(forKey: IncomingShareSlot.rejectedKey) == Data("A".utf8))
      return
    }
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
    let rejectionSuite = suite + "-rejections"
    let rejections = UserDefaults(suiteName: rejectionSuite)!
    defer { rejections.removePersistentDomain(forName: rejectionSuite); rejections.synchronize() }
    do {
      _ = try IncomingShareSlot.discard(a, rejections: rejections) { _ in throw POSIXError(.EIO) }
      fatalError("Expected failed App Group cleanup")
    } catch {}
    let reader = Process()
    reader.executableURL = URL(fileURLWithPath: arguments[0])
    reader.arguments = ["--rejected", rejectionSuite]
    try reader.run()
    reader.waitUntilExit()
    precondition(reader.terminationStatus == 0)
    // A fresh instance models restart after account A's App Group clear failed.
    let restarted = UserDefaults(suiteName: rejectionSuite)!
    for _ in 0..<2 {
      precondition(IncomingShareSlot.read(a, rejections: restarted) { _ in throw POSIXError(.EIO) } == nil)
    }
    precondition(IncomingShareSlot.read(a, rejections: restarted) { _ in true } == nil)
    // Clearing succeeded: a deliberate identical share is eligible again.
    precondition(IncomingShareSlot.read(a, rejections: restarted) { _ in fatalError("Not rejected") } == a)
    try IncomingShareSlot.reject(a, in: rejections)
    precondition(IncomingShareSlot.read(b, rejections: restarted) { _ in fatalError("Never clear newer bytes") } == b)
    let discarded = try IncomingShareSlot.discard(a, rejections: rejections) { _ in true }
    precondition(discarded)
    precondition(IncomingShareSlot.read(a, rejections: restarted) { _ in fatalError("Already cleared") } == a)
    let failingDiscard = RejectionDefaults(nil)
    var snapshot: Data? = a
    var reportedSuccess = false
    do {
      _ = try IncomingShareSlot.discard(a, rejections: failingDiscard) { expected in
        precondition(snapshot == expected)
        snapshot = nil
        return true
      }
      reportedSuccess = true
    } catch {}
    precondition(!reportedSuccess, "Discard falsely acknowledged a failed tombstone removal")
    precondition(failingDiscard.cached == a && failingDiscard.durable == a)
    // Retrying after the App Group slot was already cleared must still finish.
    precondition(IncomingShareSlot.read(snapshot, rejections: failingDiscard) { _ in fatalError("Slot is empty") } == nil)
    precondition(failingDiscard.cached == a && failingDiscard.durable == a)
    let cold = RejectionDefaults(failingDiscard.durable)
    cold.failRemoval = false
    precondition(IncomingShareSlot.read(snapshot, rejections: cold) { _ in fatalError("Slot is empty") } == nil)
    precondition(cold.durable == nil)
    // A new identical text/URL snapshot after recovery is no longer rejected.
    let recovered = RejectionDefaults(cold.durable)
    precondition(IncomingShareSlot.read(a, rejections: recovered) { _ in fatalError("New share") } == a)
    let retryDiscard = RejectionDefaults(a)
    retryDiscard.failRemoval = false
    let alreadyGone = try IncomingShareSlot.discard(a, rejections: retryDiscard) { _ in false }
    precondition(!alreadyGone && retryDiscard.durable == nil && retryDiscard.cached == nil)
    let failingRead = RejectionDefaults(a)
    precondition(IncomingShareSlot.read(a, rejections: failingRead) { _ in true } == nil)
    precondition(failingRead.cached == a && failingRead.durable == a, "Read lost tombstone removal retry state")
    failingRead.failRemoval = false
    precondition(IncomingShareSlot.read(nil, rejections: failingRead) { _ in fatalError("Slot is empty") } == nil)
    precondition(failingRead.cached == nil && failingRead.durable == nil)
    // A newer share remains readable even when stale-marker cleanup cannot flush.
    let newer = RejectionDefaults(a)
    precondition(IncomingShareSlot.read(b, rejections: newer) { _ in fatalError("Never clear newer bytes") } == b)
    precondition(newer.cached == a && newer.durable == a)
    newer.failRemoval = false
    precondition(IncomingShareSlot.read(b, rejections: newer) { _ in fatalError("Never clear newer bytes") } == b)
    precondition(newer.durable == nil)
    // Read failure cannot capture exact bytes: persist unknown before App Group
    // recovery, then verify a new process rejects and pins the recovered bytes.
    try IncomingShareSlot.rejectUnreadable(in: rejections)
    let unknownReader = Process()
    unknownReader.executableURL = URL(fileURLWithPath: arguments[0])
    unknownReader.arguments = ["--unknown", rejectionSuite]
    try unknownReader.run()
    unknownReader.waitUntilExit()
    precondition(unknownReader.terminationStatus == 0)
    precondition(rejections.synchronize())
    precondition(IncomingShareSlot.read(a, rejections: rejections) { _ in throw POSIXError(.EIO) } == nil)
    precondition(IncomingShareSlot.read(b, rejections: rejections) { _ in fatalError("New bytes remain eligible") } == b)
    try IncomingShareSlot.rejectUnreadable(in: rejections)
    precondition(IncomingShareSlot.read(a, rejections: rejections) { _ in true } == nil)
    precondition(IncomingShareSlot.read(a, rejections: rejections) { _ in fatalError("New identical share after recovery") } == a)
    let unknownEmpty = RejectionDefaults(Data())
    precondition(IncomingShareSlot.read(nil, rejections: unknownEmpty) { _ in fatalError("Empty slot") } == nil)
    precondition(unknownEmpty.cached == Data() && unknownEmpty.durable == Data())
    unknownEmpty.failRemoval = false
    precondition(IncomingShareSlot.read(nil, rejections: unknownEmpty) { _ in fatalError("Empty slot") } == nil)
    precondition(unknownEmpty.durable == nil)
    print("PASS: unreadable account-boundary fence survives process restart and recovery")
    print("PASS: failed rejection removal retains retry state until durable recovery")
    print("PASS: durable exact-snapshot rejection, retry and replacement")
    print("PASS: cross-process exclusion, stale/current/duplicate acknowledgement, error unlock")
  }
}
