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
    /// Localized status line, prepared by the main process.
    var detail: String
    /// Localized secondary line ("2 more tasks running"); empty when nothing to add.
    var summary: String
    /// Agent Island mascot skin id; the extension falls back to `cindy`.
    var mascot: String
  }

  var appName: String
}
