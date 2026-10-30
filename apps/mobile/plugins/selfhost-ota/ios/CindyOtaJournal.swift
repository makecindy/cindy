import Foundation

// Compiled only inside the isolated self-host EXUpdates source adapter. The
// atomic journal, not UserDefaults or JS AsyncStorage, owns update transactions.
enum CindyOtaJournal {
  private static let version = 1
  private static let maximumAttempts = 2
  private static let sharedID = "00000000-0000-4000-8000-000000000000"
  private static let channelKey = "x-cindy-update-channel"
  private static let lock = NSRecursiveLock()
  private static var file: URL?
  private static var defaults: UpdatesConfig?
  private static var state: Journal?
  private static var writable = true
  private static var activeAttempt: String?
  private static var embeddedUpdate: Update?

  private struct Receipt: Codable {
    let id: String
    let channel: String
    let embedded: Bool
    let commitTime: Date
    var attempts = 0
  }
  private struct Request: Codable {
    let token: String
    let channel: String
  }
  private struct Journal: Codable {
    var version: Int
    var runtime: String
    var url: String
    var binaryId: String?
    var good: Receipt?
    var pending: Receipt?
    var request: Request?
    var rejected: [String: Bool] = [:]
  }
  struct LaunchChoice {
    let update: Update?
  }

  private static func locked<T>(_ operation: () throws -> T) rethrows -> T {
    lock.lock()
    defer { lock.unlock() }
    return try operation()
  }
  private static func failure(_ message: String) -> NSError {
    NSError(domain: "CindySelfHostOTA", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
  }
  static func headers(_ channel: String) throws -> [String: String] {
    guard ["release", "beta", "canary"].contains(channel) else {
      throw failure("Invalid self-host OTA channel")
    }
    return ["EAS-Client-ID": sharedID, channelKey: channel == "release" ? "" : channel]
  }
  static func validateHeaders(_ value: [String: String]?) throws {
    guard let value else { return }
    let rawChannel = value[channelKey] ?? ""
    guard value == (try headers(rawChannel.isEmpty ? "release" : rawChannel)) else {
      throw failure("Self-host OTA requires canonical shared headers")
    }
  }

  @discardableResult
  static func prepare(storageDirectoryForTesting: URL? = nil) throws -> UpdatesConfig {
    try locked {
      writable = true
      let original = try UpdatesConfig.cindyEmbeddedConfiguration()
      guard original.originalEmbeddedRequestHeaders == (try headers("release")),
        !original.disableAntiBrickingMeasures else {
        throw failure("Invalid native OTA header contract")
      }
      defaults = original
      activeAttempt = nil
      embeddedUpdate = nil
      do {
        let directory = try storageDirectoryForTesting ?? FileManager.default.url(for: .applicationSupportDirectory,
          in: .userDomainMask, appropriateFor: nil, create: true)
          .appendingPathComponent("CindySelfHostOTA", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        var excluded = directory
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try excluded.setResourceValues(values)
        file = directory.appendingPathComponent("journal-v1.json")
        let old = try? JSONDecoder().decode(Journal.self, from: Data(contentsOf: file!))
        let compatible = old.map {
          $0.version == version && $0.runtime == original.runtimeVersion &&
            $0.url == original.updateUrl.absoluteString && valid($0.good) && valid($0.pending)
        } ?? false
        var next = compatible ? old! : Journal(version: version, runtime: original.runtimeVersion,
          url: original.updateUrl.absoluteString)
        next.request = nil
        try persist(next)
        saveOverride(compatible ? try currentHeaders() : nil)
        let effective = try currentHeaders()
        let configOverride = effective == (try headers("release")) ? nil
          : UpdatesConfigOverride(updateUrl: nil, requestHeaders: effective)
        return try UpdatesConfig.config(fromConfig: original, configOverride: configOverride)
      } catch {
        writable = false
        state = nil
        saveOverride(nil)
        NSLog("[CindySelfHostOTA] Journal unavailable; using embedded safety configuration")
        return original
      }
    }
  }

  private static func valid(_ receipt: Receipt?) -> Bool {
    guard let receipt else { return true }
    return UUID(uuidString: receipt.id) != nil && (try? headers(receipt.channel)) != nil &&
      receipt.attempts >= 0 && receipt.attempts <= maximumAttempts
  }
  // The caller is the embedded-only loader and supplies the signed binary's
  // manifest, never a remote response. Receipt pruning happens once per binary.
  static func observeEmbedded(_ update: Update) {
    locked {
      embeddedUpdate = update
      guard writable, state != nil else { return }
      do {
        var next = try loadState()
        let id = update.updateId.uuidString.lowercased()
        guard next.binaryId != id else { return }
        if let good = next.good, good.embedded || good.commitTime < update.commitTime { next.good = nil }
        if let pending = next.pending, pending.embedded || pending.commitTime < update.commitTime { next.pending = nil }
        next.binaryId = id
        try persist(next)
        saveOverride(try currentHeaders())
      } catch {
        writable = false
        state = nil
        NSLog("[CindySelfHostOTA] Unable to migrate binary identity; using embedded safety configuration")
      }
    }
  }
  private static func isCurrentEmbedded(_ update: Update, config: UpdatesConfig) -> Bool {
    update.updateId == embeddedUpdate?.updateId && update.status == .StatusEmbedded &&
      update.runtimeVersion == config.runtimeVersion && update.scopeKey == config.scopeKey &&
      update.url == defaults?.updateUrl && update.requestHeaders == (try? headers("release"))
  }
  private static func loadState() throws -> Journal {
    guard writable, let state else { throw failure("Self-host OTA journal unavailable") }
    return state
  }
  private static func persist(_ next: Journal) throws {
    guard let file else { throw failure("Self-host OTA journal unavailable") }
    // Write-ahead, atomic rename. A process killed before the matching Expo
    // UserDefaults write is repaired from this file on its next native startup.
    try JSONEncoder().encode(next).write(to: file, options: .atomic)
    state = next
  }
  private static func saveOverride(_ requestHeaders: [String: String]?) {
    if requestHeaders == nil || requestHeaders == (try? headers("release")) {
      UpdatesConfigOverride.save(configOverride: nil)
    } else {
      // Never preserve a legacy updateUrl hidden in UserDefaults.
      UpdatesConfigOverride.save(configOverride: UpdatesConfigOverride(updateUrl: nil, requestHeaders: requestHeaders))
    }
  }
  static func capabilities() -> [String: Any] {
    locked {
      ["version": version, "runtimeVersion": defaults?.runtimeVersion ?? "",
       "updateUrl": defaults?.updateUrl.absoluteString ?? "", "available": writable && state != nil]
    }
  }
  static func currentHeaders() throws -> [String: String] {
    try locked { try headers((state?.pending ?? state?.good)?.channel ?? "release") }
  }

  static func begin(_ channel: String) throws -> String {
    try locked {
      let target = try headers(channel)
      var next = try loadState()
      guard next.request == nil else { throw failure("Self-host OTA request already in progress") }
      let token = UUID().uuidString.lowercased()
      next.request = Request(token: token, channel: channel)
      try persist(next)
      do {
        try AppController.sharedInstance.setUpdateRequestHeadersOverride(target)
      } catch {
        try finish(token)
        throw error
      }
      return token
    }
  }
  static func finish(_ token: String) throws {
    try locked {
      var next = try loadState()
      guard next.request?.token == token else { return }
      next.request = nil
      try persist(next)
      try AppController.sharedInstance.setUpdateRequestHeadersOverride(currentHeaders())
    }
  }
  private static func snapshot(_ update: Update) -> Receipt? {
    guard let defaults, update.runtimeVersion == defaults.runtimeVersion,
      update.scopeKey == defaults.scopeKey else { return nil }
    let embedded = isCurrentEmbedded(update, config: defaults)
    let rawChannel = update.requestHeaders?[channelKey] ?? ""
    let channel = rawChannel.isEmpty ? "release" : rawChannel
    guard embedded || (update.url == defaults.updateUrl && update.requestHeaders == (try? headers(channel))) else { return nil }
    return Receipt(id: update.updateId.uuidString.lowercased(), channel: channel, embedded: embedded, commitTime: update.commitTime)
  }
  static func downloaded(_ update: Update, config: UpdatesConfig) throws {
    try locked {
      var next = try loadState()
      guard let request = next.request else { return }
      guard config.requestHeaders == (try headers(request.channel)), let receipt = snapshot(update),
        next.rejected[receipt.id] != true else { throw failure("Incompatible or previously failed self-host OTA download") }
      if next.good?.id == receipt.id || next.pending?.id == receipt.id { return }
      next.pending = receipt
      try persist(next)
    }
  }
  private static func matches(_ update: Update, receipt: Receipt, config: UpdatesConfig) -> Bool {
    guard update.updateId.uuidString.lowercased() == receipt.id, update.runtimeVersion == config.runtimeVersion,
      update.scopeKey == config.scopeKey, state?.rejected[receipt.id] != true,
      update.failedLaunchCount == 0 || update.successfulLaunchCount > 0 else { return false }
    return receipt.embedded
      ? isCurrentEmbedded(update, config: config)
      : update.url == defaults?.updateUrl && update.requestHeaders == (try? headers(receipt.channel))
  }
  static func select(_ updates: [Update], config: UpdatesConfig) -> LaunchChoice? {
    locked {
      let safeEmbedded = updates.filter { isCurrentEmbedded($0, config: config) }.max(by: { $0.commitTime < $1.commitTime })
      guard let current = state, current.runtime == config.runtimeVersion,
        current.url == config.updateUrl.absoluteString else { return LaunchChoice(update: safeEmbedded) }
      if let pending = current.pending {
        if let candidate = updates.first(where: { matches($0, receipt: pending, config: config) }),
          pending.attempts < maximumAttempts || activeAttempt == pending.id {
          return LaunchChoice(update: candidate)
        }
        do { try reject(pending.id) } catch { return LaunchChoice(update: nil) }
      }
      if let good = state?.good,
        let update = updates.first(where: { matches($0, receipt: good, config: config) }) {
        return LaunchChoice(update: update)
      }
      // Database launchability/runtime/scope checks remain authoritative. Only
      // receipts downloaded by this journal may cross channel/filter boundaries.
      return LaunchChoice(update: safeEmbedded)
    }
  }
  static func selected(_ update: Update) throws {
    try locked {
      guard writable, state != nil else { return }
      var next = try loadState()
      guard var pending = next.pending, pending.id == update.updateId.uuidString.lowercased() else { return }
      guard activeAttempt != pending.id else { return }
      pending.attempts += 1
      next.pending = pending
      try persist(next)
      activeAttempt = pending.id
    }
  }
  static func confirmed(_ update: Update) {
    locked {
      guard writable, state != nil, let receipt = snapshot(update) else { return }
      do {
        var next = try loadState()
        next.good = receipt
        if next.pending?.id == receipt.id { next.pending = nil }
        try persist(next)
        activeAttempt = nil
      } catch {
        NSLog("[CindySelfHostOTA] Unable to confirm launch; retaining previous safe receipt")
      }
    }
  }
  private static func reject(_ id: String) throws {
    var next = try loadState()
    if next.pending?.id == id { next.pending = nil }
    next.rejected[id] = true
    try persist(next)
    activeAttempt = nil
    saveOverride(try currentHeaders())
  }
  @discardableResult
  static func failed(_ update: Update?) -> Bool {
    locked {
      guard writable, let update, state?.pending?.id == update.updateId.uuidString.lowercased() else { return false }
      do {
        try reject(update.updateId.uuidString.lowercased())
        try AppController.sharedInstance.setUpdateRequestHeadersOverride(currentHeaders())
        return true
      } catch {
        NSLog("[CindySelfHostOTA] Unable to restore launch configuration")
        return false
      }
    }
  }
  static func pinned(_ id: UUID) -> Bool {
    locked { [state?.good?.id, state?.pending?.id].contains(id.uuidString.lowercased()) }
  }
  static func rolledBackToEmbedded() throws {
    try locked {
      var next = try loadState()
      next.good = nil
      next.pending = nil
      try persist(next)
      activeAttempt = nil
      saveOverride(nil)
      try AppController.sharedInstance.setUpdateRequestHeadersOverride(headers("release"))
    }
  }
}
