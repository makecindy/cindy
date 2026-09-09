import Foundation
import Darwin

@main
struct ClipboardSizeTests {
  static func main() throws {
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
