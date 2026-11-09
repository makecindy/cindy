import ActivityKit
import ExpoModulesCore
import UIKit

private struct ActivitySnapshot: Decodable {
  var accountId: String
  var state: CindyAgentActivityAttributes.ContentState
}

@MainActor
private final class AgentActivityController {
  static let shared = AgentActivityController()
  private var tail: Task<Void, Never>?
  private var observed: Activity<CindyAgentActivityAttributes>?
  private var dismissedAccount: String?

  // Serialize end/update/request, including account switches while update is suspended.
  func enqueue(_ json: String?) {
    let previous = tail
    tail = Task {
      await previous?.value
      await apply(json)
    }
  }

  func markStale() {
    let previous = tail
    tail = Task {
      await previous?.value
      for activity in Activity<CindyAgentActivityAttributes>.activities {
        guard activity.activityState == .active else { continue }
        await activity.update(ActivityContent(state: activity.content.state, staleDate: .distantPast))
      }
    }
  }

  private func apply(_ json: String?) async {
    let snapshot = json.flatMap { try? JSONDecoder().decode(ActivitySnapshot.self, from: Data($0.utf8)) }
    let activities = Activity<CindyAgentActivityAttributes>.activities
    guard let snapshot else {
      observed = nil
      dismissedAccount = nil
      for activity in activities { await activity.end(nil, dismissalPolicy: .immediate) }
      return
    }
    // Activity.activities no longer contains a dismissed activity. Retain its
    // handle so a store update cannot immediately recreate what the user hid.
    if let observed, observed.activityState == .dismissed {
      dismissedAccount = observed.attributes.accountId
      self.observed = nil
    }
    if dismissedAccount == snapshot.accountId { return }
    var current: Activity<CindyAgentActivityAttributes>?
    for activity in activities {
      if activity.attributes.accountId == snapshot.accountId,
         activity.activityState == .active || activity.activityState == .stale,
         current == nil {
        current = activity
      } else {
        await activity.end(nil, dismissalPolicy: .immediate)
      }
    }
    let content = ActivityContent(state: snapshot.state, staleDate: Date().addingTimeInterval(120))
    if let current {
      observed = current
      await current.update(content)
    } else if UIApplication.shared.applicationState == .active,
              ActivityAuthorizationInfo().areActivitiesEnabled {
      // ActivityKit owns authorization; disabled/unsupported activities never block a task.
      observed = try? Activity.request(attributes: CindyAgentActivityAttributes(accountId: snapshot.accountId),
                                       content: content, pushType: nil)
    }
  }
}

public final class CindyAgentActivityModule: Module {
  public func definition() -> ModuleDefinition {
    Name("CindyAgentActivity")
    Function("setState") { (json: String?) in
      DispatchQueue.main.async { AgentActivityController.shared.enqueue(json) }
    }
    Function("markStale") {
      DispatchQueue.main.async { AgentActivityController.shared.markStale() }
    }
  }
}
