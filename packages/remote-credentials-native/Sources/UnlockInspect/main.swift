import Foundation
import CindyRemoteCredentials

/// Bounded diagnostics; default is read-only. Explicit --prepare may wake/show
/// the verified password field, but never accepts a password or submits login.
@main struct UnlockInspect {
  @MainActor static func main() async {
    #if os(macOS)
    if CommandLine.arguments.dropFirst() == ["--prepare"] {
      let report = await MacRemoteUnlockDiagnostics.prepare()
      if let data = try? JSONSerialization.data(withJSONObject: report, options: [.sortedKeys]) {
        FileHandle.standardOutput.write(data); FileHandle.standardOutput.write(Data([10]))
      }
      return
    }
    let watch = CommandLine.arguments.dropFirst() == ["--watch"]
    guard CommandLine.arguments.count == 1 || watch else { exit(64) }
    for _ in 0..<(watch ? 120 : 1) {
      let report = MacRemoteUnlockDiagnostics.inspect()
      if let data = try? JSONSerialization.data(withJSONObject: report, options: [.sortedKeys]) {
        FileHandle.standardOutput.write(data); FileHandle.standardOutput.write(Data([10]))
      }
      if watch { try? await Task.sleep(nanoseconds: 1_000_000_000) }
    }
    #endif
  }
}
