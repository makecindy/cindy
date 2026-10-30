import Foundation
import Darwin

// Compiled into both the app module and generated share extension. Never unlink
// the lock file: all processes must continue locking the same inode.
enum IncomingShareSlot {
  static let key = "expo-sharing"
  static let rejectedKey = "cindy-rejected-incoming-share"

  // Main-app storage is independent of the App Group lock/synchronization that
  // may be unavailable during logout. Persist before attempting that cleanup.
  static func reject(_ expected: Data, in defaults: UserDefaults = .standard) throws {
    defaults.set(expected, forKey: rejectedKey)
    guard defaults.synchronize() else { throw POSIXError(.EIO) }
  }

  // An empty marker cannot be a JSON payload. It rejects the first readable
  // slot after an account transition whose App Group read failed, across restart.
  static func rejectUnreadable(in defaults: UserDefaults = .standard) throws {
    try reject(Data(), in: defaults)
  }

  static func discard(_ expected: Data, rejections: UserDefaults = .standard,
                      clear: (Data) throws -> Bool) throws -> Bool {
    try reject(expected, in: rejections)
    let cleared = try clear(expected)
    // A false comparison also means the old bytes are absent or replaced.
    // Finish the rejection even when a previous attempt already cleared the slot.
    try removeRejection(expected, from: rejections)
    return cleared
  }

  static func read(_ snapshot: Data?, rejections: UserDefaults = .standard,
                   clear: (Data) throws -> Bool) -> Data? {
    guard var rejected = rejections.data(forKey: rejectedKey) else { return snapshot }
    if rejected.isEmpty, let snapshot {
      // Pin the recovered bytes before cleanup. Later, different shares remain
      // eligible even if clearing this old slot fails again.
      do { try reject(snapshot, in: rejections) } catch { return nil }
      rejected = snapshot
    }
    if let snapshot, snapshot == rejected {
      // Retry clearing, but never return rejected bytes even if it still fails.
      do { _ = try clear(snapshot) } catch { return nil }
    }
    // Empty/replaced snapshots are safe too, but a failed flush must leave a
    // marker in this process so subsequent reads can retry its durable removal.
    try? removeRejection(rejected, from: rejections)
    return snapshot == rejected ? nil : snapshot
  }

  private static func removeRejection(_ rejected: Data, from defaults: UserDefaults) throws {
    defaults.removeObject(forKey: rejectedKey)
    guard defaults.synchronize() else {
      defaults.set(rejected, forKey: rejectedKey)
      throw POSIXError(.EIO)
    }
  }

  static func withLock<T>(at url: URL, _ operation: () throws -> T) throws -> T {
    let fd = open(url.path, O_CREAT | O_RDWR, S_IRUSR | S_IWUSR)
    guard fd >= 0 else { throw POSIXError(.EIO) }
    defer { close(fd) }
    guard flock(fd, LOCK_EX) == 0 else { throw POSIXError(.EIO) }
    defer { flock(fd, LOCK_UN) }
    return try operation()
  }

  static func withDefaults<T>(group: String, _ operation: (UserDefaults) throws -> T) throws -> T {
    guard let root = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group),
          let defaults = UserDefaults(suiteName: group) else { throw POSIXError(.ENOENT) }
    return try withLock(at: root.appendingPathComponent(".cindy-incoming-share.lock")) {
      // Refresh the process cache while holding the same lock as the writer.
      guard defaults.synchronize() else { throw POSIXError(.EIO) }
      return try operation(defaults)
    }
  }

  static func clear(_ expected: Data, from defaults: UserDefaults) throws -> Bool {
    guard defaults.data(forKey: key) == expected else { return false }
    defaults.removeObject(forKey: key)
    guard defaults.synchronize() else { throw POSIXError(.EIO) }
    return true
  }

  static func write(_ data: Data, group: String) throws {
    try withDefaults(group: group) { defaults in
      defaults.set(data, forKey: key)
      guard defaults.synchronize() else { throw POSIXError(.EIO) }
    }
  }
}
