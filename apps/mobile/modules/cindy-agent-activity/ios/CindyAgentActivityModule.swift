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
  private var foregroundEpoch = 0
  private var foregroundContent: CindyAgentActivityAttributes.ContentState?
  private var lastRecheckedConfirmation: Double?
  var foregroundConflict: (() -> Void)?
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
  // The system reports .dismissed for the app's own immediate end exactly as it
  // does for a swipe. Only an end the app did not ask for counts as a removal.
  private var endedByApp = Set<String>()

  private init() {
    account = UserDefaults.standard.string(forKey: ownerKey)
    dismissedAccount = UserDefaults.standard.string(forKey: dismissedOwnerKey)
    observers.append(Task {
      for await _ in NotificationCenter.default.notifications(named: UIApplication.willResignActiveNotification) {
        foregroundEpoch += 1
        foregroundContent = nil
        lastRecheckedConfirmation = nil
      }
    })
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

  private func end(_ activity: Activity<CindyAgentActivityAttributes>) async {
    endedByApp.insert(activity.id)
    await activity.end(nil, dismissalPolicy: .immediate)
  }

  func configureAccount(_ next: String?) async {
    if account != next {
      dismissedAccount = nil
      observed = nil
      foregroundContent = nil
      lastRecheckedConfirmation = nil
      foregroundEpoch += 1
    }
    account = next
    // Scope only, never a credential. A background cold launch can reject an
    // activity for the account used before sign-out while JS restores auth.
    UserDefaults.standard.set(next, forKey: ownerKey)
    for activity in Activity<CindyAgentActivityAttributes>.activities {
      guard account == next else { return }
      if activity.attributes.accountId != next { await end(activity) }
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
            "confirmedAt": current?.content.state.confirmedAt as Any? ?? NSNull(),
            "staleAt": current?.content.staleDate?.timeIntervalSince1970 as Any? ?? NSNull(),
            "startToken": hex(startToken), "updateToken": hex(current?.pushToken),
            "activityId": current?.id as Any? ?? NSNull(),
            "dismissed": account != nil && dismissedAccount == account]
  }

  private func observe(_ activity: Activity<CindyAgentActivityAttributes>) {
    guard activity.attributes.accountId == account else {
      Task { await end(activity) }
      return
    }
    // A foreground request may race push-to-start. Keep one account activity.
    if let current = observed, current.id != activity.id,
       current.activityState == .active || current.activityState == .stale {
      Task { await end(activity) }
      return
    }
    guard watches[activity.id] == nil else { return }
    if observed?.id != activity.id {
      foregroundContent = nil
      lastRecheckedConfirmation = nil
    }
    observed = activity
    // An activity that exists supersedes an earlier removal; keeping the flag
    // would go on reporting it and block the next local activity.
    if dismissedAccount == account { dismissedAccount = nil }
    watches[activity.id] = [Task {
      for await content in activity.contentUpdates {
        log.debug("content observed; expiry: \(content.staleDate?.timeIntervalSince1970 ?? 0)")
        if var expected = foregroundContent, observed?.id == activity.id,
           UIApplication.shared.applicationState == .active, content.state == activity.content.state,
           (content.state.confirmedAt ?? 0) >= (expected.confirmedAt ?? 0) {
          expected.confirmedAt = content.state.confirmedAt
          if expected != content.state {
            // A later APNs send can still describe an older task transition. Recheck
            // the computers once; never replay a saved local snapshot over a push.
            recheckForeground(after: content.state.confirmedAt ?? 0)
          }
        }
        // Let the phone-local diagnostic recorder observe content arrival. JS
        // strips these dates before comparing/sending registration payloads.
        registrationChanged?()
      }
    }, Task {
      for await _ in activity.pushTokenUpdates { registrationChanged?() }
    }, Task {
      for await state in activity.activityStateUpdates {
        if state == .stale { log.info("activity became stale") }
        if state == .dismissed || state == .ended {
          let byApp = endedByApp.remove(activity.id) != nil
          if state == .dismissed && !byApp && activity.attributes.accountId == account {
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

  private func recheckForeground(after confirmedAt: Double) {
    // A recheck may encounter the same timestamp again, for example with clock skew.
    if let lastRecheckedConfirmation, confirmedAt <= lastRecheckedConfirmation { return }
    foregroundContent = nil
    lastRecheckedConfirmation = confirmedAt
    foregroundConflict?()
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

  // Update only the registered activity that existed when the foreground snapshot arrived.
  // Queued work from a previous account, activity, or foreground lifetime has no authority.
  func updateForeground(_ scope: String, _ json: String?, _ observedAtMs: Double) {
    guard account == scope, UIApplication.shared.applicationState == .active,
          let current = observed, current.attributes.accountId == scope else { return }
    let epoch = foregroundEpoch
    let observedAt = Date(timeIntervalSince1970: observedAtMs / 1000)
    let previous = tail
    tail = Task {
      await previous?.value
      guard epoch == foregroundEpoch, account == scope, observed?.id == current.id, UIApplication.shared.applicationState == .active,
            current.activityState == .active || current.activityState == .stale else { return }
      let currentState = current.content.state
      let confirmedAt = currentState.confirmedAt ?? 0
      if confirmedAt > observedAt.timeIntervalSince1970 {
        // An APNs update can win before the first local write has set foregroundContent.
        if currentState != foregroundContent { recheckForeground(after: confirmedAt) }
        return
      }
      guard let json else {
        foregroundContent = nil
        if #available(iOS 17.2, *) {
          endedByApp.insert(current.id)
          await current.end(nil, dismissalPolicy: .immediate, timestamp: observedAt)
        } else { await end(current) }
        return
      }
      guard var state = try? JSONDecoder().decode(CindyAgentActivityAttributes.ContentState.self, from: Data(json.utf8)) else { return }
      state.confirmedAt = observedAt.timeIntervalSince1970
      foregroundContent = state
      let content = ActivityContent(state: state, staleDate: observedAt.addingTimeInterval(state.freshnessInterval))
      if #available(iOS 17.2, *) { await current.update(content, timestamp: observedAt) }
      else { await current.update(content) }
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
      for activity in activities { await end(activity) }
      registrationChanged?()
      return
    }
    guard snapshot.accountId == account else { return }
    // Activity.activities no longer contains a dismissed activity. Retain its
    // handle so a store update cannot immediately recreate what the user hid.
    if let observed, observed.activityState == .dismissed, !endedByApp.contains(observed.id) {
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
        await end(activity)
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
    Events("pushRegistrationChanged", "foregroundActivityConflict")
    OnCreate { [weak self] in
      Task { @MainActor [weak self] in
        AgentActivityController.shared.foregroundConflict = { [weak self] in
          self?.sendEvent("foregroundActivityConflict", [:])
        }
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
    Function("updateForeground") { (scope: String, json: String?, observedAtMs: Double) in
      DispatchQueue.main.async { AgentActivityController.shared.updateForeground(scope, json, observedAtMs) }
    }
    Function("markStale") {
      DispatchQueue.main.async { AgentActivityController.shared.markStale() }
    }
  }
}
