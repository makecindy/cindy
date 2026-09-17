import Foundation
import Darwin

/// Nonsecret marker outside Keychain. It must not migrate with backups: a new
/// installation must never adopt another controller's keys or saved passwords.
public enum InstallationMarker {
  public static func loadOrCreate(directory: URL) throws -> UUID {
    do {
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
        attributes: [.posixPermissions: 0o700])
      var directory = directory
      var values = URLResourceValues(); values.isExcludedFromBackup = true
      try directory.setResourceValues(values)
      let file = directory.appendingPathComponent("installation-id")
      // Publish only a fully written marker. A crash before link leaves an
      // unreferenced temporary file, never a partial installation identity.
      let temporary = directory.appendingPathComponent(".installation-id-" + UUID().uuidString)
      let descriptor = open(temporary.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
      guard descriptor >= 0 else { throw CredentialError.unavailable }
      defer { close(descriptor); unlink(temporary.path) }
      do {
        let id = UUID(), bytes = Array(id.uuidString.lowercased().utf8)
        guard bytes.withUnsafeBytes({ write(descriptor, $0.baseAddress, $0.count) }) == bytes.count,
          fsync(descriptor) == 0 else { throw CredentialError.unavailable }
        if link(temporary.path, file.path) == 0 { return id }
        let rejected = errno
        switch InstallationPublish.decide(errno: rejected) {
        case .adoptedExisting:
          break
        case .createExclusive:
          if try publishExclusiveMarker(file, bytes: bytes) { return id }
        case .unavailable:
          throw CredentialError.unavailable
        }
      }
      let existing = open(file.path, O_RDONLY | O_NOFOLLOW)
      guard existing >= 0 else { throw CredentialError.unavailable }
      defer { close(existing) }
      var info = stat()
      guard fstat(existing, &info) == 0, info.st_mode & S_IFMT == S_IFREG,
        info.st_uid == getuid(), info.st_size == 36 else { throw CredentialError.unavailable }
      var bytes = [UInt8](repeating: 0, count: 37)
      guard read(existing, &bytes, bytes.count) == 36,
        let text = String(bytes: bytes.prefix(36), encoding: .utf8),
        let id = UUID(uuidString: text), id.uuidString.lowercased() == text else { throw CredentialError.unavailable }
      return id
    } catch { throw CredentialError.unavailable }
  }

  /// Exclusive create of a complete marker. Returns false when another writer won.
  private static func publishExclusiveMarker(_ file: URL, bytes: [UInt8]) throws -> Bool {
    let published = open(file.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
    if published >= 0 {
      defer { close(published) }
      guard bytes.withUnsafeBytes({ write(published, $0.baseAddress, $0.count) }) == bytes.count,
        fsync(published) == 0 else {
        unlink(file.path)
        throw CredentialError.unavailable
      }
      return true
    }
    guard errno == EEXIST else { throw CredentialError.unavailable }
    return false
  }
}
