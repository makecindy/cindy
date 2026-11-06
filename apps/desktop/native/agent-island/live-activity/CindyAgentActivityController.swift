import ActivityKit
import Foundation

/// Bridges one JSON command from the N-API shim to ActivityKit. Cindy keeps at most
/// one activity: started while a window is visible (ActivityKit refuses starts
/// from a process without one, `visibility`), then only updated, and ended when
/// no task needs it. Called on the Electron main thread.
private struct Alert: Decodable {
  var title: String
  var body: String
}

private struct Command: Decodable {
  var action: String
  var appName: String?
  var state: CindyAgentActivityAttributes.ContentState?
  /// `sync` only: briefly expand the activity (Dynamic Island / menu bar) for a new request.
  var alert: Alert?
  /// `end` only: block up to a second so quitting does not leave the activity behind.
  var wait: Bool?
}

/// Silent sound shipped in the app's Resources by build.mjs.
private let silentAlertSoundName = "cindy-live-activity-silent.caf"

private enum ControllerState {
  static var activity: Activity<CindyAgentActivityAttributes>?
}

private func reply(_ fields: [String: Any]) -> UnsafeMutablePointer<CChar>? {
  let data = (try? JSONSerialization.data(withJSONObject: fields)) ?? Data("{}".utf8)
  return strdup(String(decoding: data, as: UTF8.self))
}

@_cdecl("cindy_agent_activity_apply")
public func cindyAgentActivityApply(_ input: UnsafePointer<CChar>) -> UnsafeMutablePointer<CChar>? {
  guard let command = try? JSONDecoder().decode(Command.self, from: Data(String(cString: input).utf8)) else {
    return reply(["ok": false, "error": "invalid-command"])
  }
  switch command.action {
  case "status":
    return reply([
      "ok": true,
      "enabled": ActivityAuthorizationInfo().areActivitiesEnabled,
      "active": ControllerState.activity != nil,
    ])
  case "sync":
    guard let state = command.state else {
      return reply(["ok": false, "error": "missing-state"])
    }
    let content = ActivityContent(state: state, staleDate: nil)
    if let activity = ControllerState.activity, activity.activityState == .active {
      let alert = command.alert.map {
        // Silent: Agent Island and notifications already play Cindy's own sounds.
        AlertConfiguration(
          title: LocalizedStringResource(stringLiteral: $0.title),
          body: LocalizedStringResource(stringLiteral: $0.body),
          sound: .named(silentAlertSoundName)
        )
      }
      Task { await activity.update(content, alertConfiguration: alert) }
      return reply(["ok": true, "result": alert == nil ? "updated" : "alerted"])
    }
    ControllerState.activity = nil
    do {
      ControllerState.activity = try Activity.request(
        attributes: CindyAgentActivityAttributes(appName: command.appName ?? "Cindy"),
        content: content
      )
      return reply(["ok": true, "result": "started"])
    } catch let error as ActivityAuthorizationError {
      return reply(["ok": false, "error": "\(error)"])
    } catch {
      return reply(["ok": false, "error": String(describing: error)])
    }
  case "end":
    // Also ends activities left by a previous run that crashed or was killed.
    let activities = Activity<CindyAgentActivityAttributes>.activities
    ControllerState.activity = nil
    let done = DispatchSemaphore(value: 0)
    Task.detached {
      for activity in activities {
        await activity.end(nil, dismissalPolicy: .immediate)
      }
      done.signal()
    }
    if command.wait == true {
      _ = done.wait(timeout: .now() + 1)
    }
    return reply(["ok": true, "result": "ended", "count": activities.count])
  default:
    return reply(["ok": false, "error": "unknown-action"])
  }
}
