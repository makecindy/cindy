import ActivityKit
import Foundation

/// Shared by the Electron-loaded controller and the widget extension. ActivityKit
/// matches the two by module-qualified type name, so both are compiled with
/// `-module-name CindyAgentActivity` (see build.mjs).
struct CindyAgentActivityAttributes: ActivityAttributes {
  struct ContentState: Codable, Hashable {
    /// `running`, `attention` (blocked on the user) or `completed`.
    var status: String
    var runningCount: Int
    /// Tasks waiting on the user (question / permission).
    var attentionCount: Int
    /// Title of the task the island would surface first.
    var title: String
    /// Click destination, optional so existing activity payloads still decode.
    var taskUrl: String?
    /// Localized status line, prepared by the main process.
    var detail: String
    /// Localized secondary line ("2 more tasks running"); empty when nothing to add.
    var summary: String
    /// The companion the task speaks for, shown instead of the mascot once it needs
    /// the user or has replied. Optional so older payloads still decode.
    var companion: Companion?
    /// Agent Island mascot skin id; the extension falls back to `cindy`.
    var mascot: String
  }

  var appName: String

  /// Mirrors `AgentIslandCompanionSnapshot` (src/shared/agentIsland.ts).
  struct Companion: Codable, Hashable {
    var hue: String
    var glyph: String
    var glyphIsInitial: Bool
    /// Bounded JPEG thumbnail (base64, at most 2 KB) when the companion has artwork.
    var imageJpeg: String?
  }
}
