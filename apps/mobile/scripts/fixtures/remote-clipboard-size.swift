import Foundation
import Darwin

@main
struct ClipboardSizeTests {
  static func main() throws {
    precondition(RemoteClipboardSize.acceptsImage(width: 2000, height: 2000))
    precondition(!RemoteClipboardSize.acceptsImage(width: 2001, height: 2000))
    precondition(!RemoteClipboardSize.acceptsImage(width: 8000, height: 8000))
    precondition(!RemoteClipboardSize.acceptsImage(width: 0, height: 2000))
    precondition(!RemoteClipboardSize.acceptsImage(width: .infinity, height: 1))
    precondition(!RemoteClipboardSize.acceptsImage(width: 1, height: .nan))
    let data = try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))
    let string = String(data: data, encoding: .utf8)!
    let expected = CommandLine.arguments[2] == "true"
    guard RemoteClipboardSize.accepts(string) == expected else { exit(1) }
    if expected {
      guard RemoteClipboardSize.acceptsUTF8Bytes(data) else { exit(2) }
      let decoded = String(data: data, encoding: .utf8)!
      guard RemoteClipboardSize.accepts(decoded) else { exit(3) }
    }
  }
}
