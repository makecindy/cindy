import ActivityKit
import ExpoModulesCore
import UIKit
import OSLog

private struct ActivitySnapshot: Decodable {
  var accountId: String
  var state: CindyAgentActivityAttributes.ContentState
}

@MainActor
private final class AgentActivityController {
  static let shared = AgentActivityController()
  private let log = Logger(subsystem: "app.cindy.activity", category: "freshness")
  private var tail: Task<Void, Never>?
  private var observed: Activity<CindyAgentActivityAttributes>?
  private var dismissedAccount: String? {
    didSet { UserDefaults.standard.set(dismissedAccount, forKey: dismissedOwnerKey) }
  }
  var registrationChanged: (() -> Void)?
  private let ownerKey = "cindy.liveActivity.accountScope"
  private let dismissedOwnerKey = "cindy.liveActivity.dismissedAccountScope"
  private var account: String?
  private var startToken: Data?
  private var watches: [String: [Task<Void, Never>]] = [:]
  private var observers: [Task<Void, Never>] = []

  private init() {
    account = UserDefaults.standard.string(forKey: ownerKey)
    dismissedAccount = UserDefaults.standard.string(forKey: dismissedOwnerKey)
    for activity in Activity<CindyAgentActivityAttributes>.activities { observe(activity) }
    observers.append(Task {
      for await activity in Activity<CindyAgentActivityAttributes>.activityUpdates { observe(activity) }
    })
    observers.append(Task {
      for await _ in ActivityAuthorizationInfo().activityEnablementUpdates { registrationChanged?() }
    })
    if #available(iOS 17.2, *) {
      startToken = Activity<CindyAgentActivityAttributes>.pushToStartToken
      observers.append(Task {
        for await token in Activity<CindyAgentActivityAttributes>.pushToStartTokenUpdates {
          startToken = token
          registrationChanged?()
        }
      })
    }
  }

  func configureAccount(_ next: String?) async {
    if account != next { dismissedAccount = nil; observed = nil }
    account = next
    // Scope only, never a credential. A background cold launch can reject an
    // activity for the account used before sign-out while JS restores auth.
    UserDefaults.standard.set(next, forKey: ownerKey)
    for activity in Activity<CindyAgentActivityAttributes>.activities {
      guard account == next else { return }
      if activity.attributes.accountId != next { await activity.end(nil, dismissalPolicy: .immediate) }
      else { observe(activity) }
    }
    registrationChanged?()
  }

  func registration() -> [String: Any] {
    let current = Activity<CindyAgentActivityAttributes>.activities.first {
      $0.attributes.accountId == account && ($0.activityState == .active || $0.activityState == .stale)
    }
    let hex: (Data?) -> Any = { data in
      guard let data else { return NSNull() }
      return data.map { String(format: "%02x", $0) }.joined()
    }
    let supportsInputPushToken: Bool
    if #available(iOS 18.0, *) { supportsInputPushToken = true } else { supportsInputPushToken = false }
    return ["accountScope": account as Any? ?? NSNull(),
            "supportsInputPushToken": supportsInputPushToken,
            "enabled": ActivityAuthorizationInfo().areActivitiesEnabled,
            "isStale": current?.activityState == .stale,
            "startToken": hex(startToken), "updateToken": hex(current?.pushToken),
            "activityId": current?.id as Any? ?? NSNull(),
            "dismissed": account != nil && dismissedAccount == account]
  }

  private func observe(_ activity: Activity<CindyAgentActivityAttributes>) {
    guard activity.attributes.accountId == account else {
      Task { await activity.end(nil, dismissalPolicy: .immediate) }
      return
    }
    // A foreground request may race push-to-start. Keep one account activity.
    if let current = observed, current.id != activity.id,
       current.activityState == .active || current.activityState == .stale {
      Task { await activity.end(nil, dismissalPolicy: .immediate) }
      return
    }
    guard watches[activity.id] == nil else { return }
    observed = activity
    watches[activity.id] = [Task {
      for await content in activity.contentUpdates {
        log.debug("content observed; expiry: \(content.staleDate?.timeIntervalSince1970 ?? 0)")
      }
    }, Task {
      for await _ in activity.pushTokenUpdates { registrationChanged?() }
    }, Task {
      for await state in activity.activityStateUpdates {
        if state == .stale { log.info("activity became stale") }
        if state == .dismissed || state == .ended {
          if state == .dismissed && activity.attributes.accountId == account {
            dismissedAccount = activity.attributes.accountId
          }
          if observed?.id == activity.id { observed = nil }
          for watcher in watches.removeValue(forKey: activity.id) ?? [] { watcher.cancel() }
        }
        registrationChanged?()
      }
    }]
    registrationChanged?()
  }

  // Serialize end/update/request, including account switches while update is suspended.
  func enqueue(_ json: String?) {
    let previous = tail
    let owner = account
    tail = Task {
      await previous?.value
      guard account == owner else { return }
      await apply(json)
    }
  }

  func markStale() {
    let previous = tail
    let owner = account
    tail = Task {
      await previous?.value
      for activity in Activity<CindyAgentActivityAttributes>.activities {
        guard account == owner else { return }
        guard activity.attributes.accountId == owner else { continue }
        guard activity.activityState == .active else { continue }
        log.info("activity marked stale: connection unverified")
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
      registrationChanged?()
      return
    }
    guard snapshot.accountId == account else { return }
    // Activity.activities no longer contains a dismissed activity. Retain its
    // handle so a store update cannot immediately recreate what the user hid.
    if let observed, observed.activityState == .dismissed {
      dismissedAccount = observed.attributes.accountId
      self.observed = nil
    }
    if dismissedAccount == snapshot.accountId { return }
    var current: Activity<CindyAgentActivityAttributes>?
    for activity in activities {
      guard snapshot.accountId == account else { return }
      if activity.attributes.accountId == snapshot.accountId,
         activity.activityState == .active || activity.activityState == .stale,
         current == nil {
        current = activity
      } else {
        await activity.end(nil, dismissalPolicy: .immediate)
      }
    }
    guard snapshot.accountId == account else { return }
    let now = Date()
    var state = snapshot.state
    state.confirmedAt = now.timeIntervalSince1970
    let content = ActivityContent(state: state, staleDate: now.addingTimeInterval(state.freshnessInterval))
    log.debug("local content confirmed; freshness seconds: \(state.freshnessInterval)")
    if let current {
      observed = current
      observe(current)
      await current.update(content)
    } else if UIApplication.shared.applicationState == .active,
              ActivityAuthorizationInfo().areActivitiesEnabled {
      // ActivityKit owns authorization; disabled/unsupported activities never block a task.
      observed = try? Activity.request(attributes: CindyAgentActivityAttributes(accountId: snapshot.accountId),
                                       content: content, pushType: .token)
      if let observed { observe(observed) }
    }
  }
}

public final class CindyAgentActivityModule: Module {
  public func definition() -> ModuleDefinition {
    Name("CindyAgentActivity")
    Events("pushRegistrationChanged")
    OnCreate {
      Task { @MainActor [weak self] in
        AgentActivityController.shared.registrationChanged = { [weak self] in
          self?.sendEvent("pushRegistrationChanged", [:])
        }
      }
    }
    AsyncFunction("configureAccount") { (accountScope: String?) in
      await AgentActivityController.shared.configureAccount(accountScope)
    }
    AsyncFunction("getPushRegistration") { () -> [String: Any] in
      await AgentActivityController.shared.registration()
    }
    Function("setState") { (json: String?) in
      DispatchQueue.main.async { AgentActivityController.shared.enqueue(json) }
    }
    Function("markStale") {
      DispatchQueue.main.async { AgentActivityController.shared.markStale() }
    }
  }
}
