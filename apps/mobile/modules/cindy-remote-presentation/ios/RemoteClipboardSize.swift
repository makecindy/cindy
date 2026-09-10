import Foundation

enum RemoteClipboardSize {
  // CLIPBOARD_MAX_CHARS in packages/device-link/src/remoteClipboard.ts:
  // JavaScript string.length counts UTF-16 code units, not UTF-8 bytes or graphemes.
  static let limit = 32 * 1024 * 1024

  static func accepts(_ string: String) -> Bool {
    string.utf16.count <= limit
  }

  static func acceptsUTF8Bytes(_ data: Data) -> Bool {
    // A UTF-16 unit needs at most three UTF-8 bytes. Only a pre-decode bound;
    // the decoded string must still pass accepts(_:).
    data.count <= limit * 3
  }
}
