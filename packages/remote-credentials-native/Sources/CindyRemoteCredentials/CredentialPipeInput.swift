#if os(macOS)
import Foundation
import Darwin

/// Blocking pipe input for the helper's dedicated reader queue. A short read
/// must return immediately: Foundation read(upToCount:) can wait for a full
/// buffer or EOF on macOS, deadlocking a request/reply pipe kept open by Main.
public enum CredentialPipeInput {
  public static func readChunk(from descriptor: Int32) throws -> Data? {
    var bytes = [UInt8](repeating: 0, count: 8192)
    while true {
      let count = Darwin.read(descriptor, &bytes, bytes.count)
      if count > 0 { return Data(bytes.prefix(count)) }
      if count == 0 { return nil }
      if errno != EINTR { throw CredentialError.unavailable }
    }
  }
}
#endif
