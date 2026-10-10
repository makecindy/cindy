import Foundation

// Shared by the Expo bridge and the WidgetKit target. Re-encoding discards every unknown field.
struct QuotaWindow: Codable {
  let kind: String
  var scope: String? = nil
  var observedAtMs: Double? = nil
  var key: String { kind + ":" + (scope ?? "") }
  let minutes: Double?
  let remainingPercent: Double?
  let resetAtMs: Double?
}
struct QuotaRow: Codable {
  var plan: String? = nil
  var extraResetsRemaining: Double? = nil
  var status: String? = nil
  var provenance: String? = nil
  let platform: String
  let observedAtMs: Double?
  let available: Bool
  let windows: [QuotaWindow]
}
struct QuotaSnapshot: Codable {
  let version: Int
  let source: String
  let connection: String
  let rows: [QuotaRow]
  static let empty = QuotaSnapshot(version: 2, source: "live-source", connection: "offline", rows: [])
  static let maximumAge: Double = 15 * 60 * 1000

  static func decode(_ data: Data) throws -> QuotaSnapshot {
    guard data.count <= 16384 else { throw CocoaError(.fileReadCorruptFile) }
    let value = try JSONDecoder().decode(QuotaSnapshot.self, from: data)
    guard value.version == 2, ["live-source", "demo"].contains(value.source),
          ["online", "offline"].contains(value.connection), value.rows.count <= 3,
          Set(value.rows.map(\.platform)).count == value.rows.count else { throw CocoaError(.fileReadCorruptFile) }
    func validTime(_ value: Double?) -> Bool { value == nil || (value!.isFinite && value! > 0 && value! <= 8_640_000_000_000_000) }
    for row in value.rows {
      guard row.extraResetsRemaining == nil || (row.platform == "codex" && row.extraResetsRemaining!.isFinite && row.extraResetsRemaining! >= 0 && row.extraResetsRemaining! <= 9_007_199_254_740_991 && row.extraResetsRemaining!.rounded(.down) == row.extraResetsRemaining!) else { throw CocoaError(.fileReadCorruptFile) }
      guard row.plan == nil || ["Free", "Plus", "Pro", "Business", "Enterprise", "Edu", "Team", "Max", "SuperGrok", "SuperGrok Heavy"].contains(row.plan!),
            row.status == nil || ["ready", "no-windows", "unavailable", "unsupported", "unauthorized"].contains(row.status!),
            row.provenance == nil || ["codex-control", "codex-cache", "claude-control", "claude-event", "grok-subscription", "unknown"].contains(row.provenance!) else { throw CocoaError(.fileReadCorruptFile) }
      guard ["codex", "claude", "xai"].contains(row.platform), validTime(row.observedAtMs), row.windows.count <= 16,
            Set(row.windows.map(\.key)).count == row.windows.count else { throw CocoaError(.fileReadCorruptFile) }
      for window in row.windows {
        guard ["primary", "secondary", "fiveHour", "sevenDay", "week", "scoped"].contains(window.kind), validTime(window.resetAtMs), validTime(window.observedAtMs),
              (window.kind != "scoped" || window.scope != nil),
              window.scope == nil || ["Fable", "Opus", "Sonnet", "Haiku", "Mythos"].contains(window.scope!),
              window.minutes == nil || (window.minutes!.isFinite && window.minutes! > 0 && window.minutes! <= 525600),
              window.remainingPercent == nil || (window.remainingPercent!.isFinite && (0...100).contains(window.remainingPercent!))
        else { throw CocoaError(.fileReadCorruptFile) }
      }
    }
    return value
  }
  func state(_ row: QuotaRow, _ window: QuotaWindow, at date: Date) -> String {
    let now = date.timeIntervalSince1970 * 1000
    guard row.available, window.remainingPercent != nil, let observed = window.observedAtMs, observed <= now + 60000 else { return "unavailable" }
    if let reset = window.resetAtMs, reset <= now { return "awaitingRefresh" }
    if now - observed >= Self.maximumAge { return "stale" }
    return connection == "offline" ? "offline" : "fresh"
  }
}

enum QuotaSnapshotStore {
  static var group: String? { Bundle.main.object(forInfoDictionaryKey: "CindyQuotaAppGroup") as? String }
  static var defaults: UserDefaults? { group.flatMap { UserDefaults(suiteName: $0) } }
  static func file() throws -> URL {
    guard let group, let root = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group)
    else { throw CocoaError(.fileNoSuchFile) }
    return root.appendingPathComponent("subscription-quota-v1.json")
  }
  static func load() -> QuotaSnapshot {
    guard let url = try? file(), let size = try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize,
          size <= 16384, let data = try? Data(contentsOf: url), let value = try? QuotaSnapshot.decode(data) else { return .empty }
    return value
  }
  static func save(_ json: String) throws {
    let value = try QuotaSnapshot.decode(Data(json.utf8))
    var url = try file()
    try JSONEncoder().encode(value).write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    var attributes = URLResourceValues()
    attributes.isExcludedFromBackup = true
    try url.setResourceValues(attributes)
  }
  static func clear() throws {
    let url = try file()
    if FileManager.default.fileExists(atPath: url.path) { try FileManager.default.removeItem(at: url) }
  }
}

/// Shared English display rules; reset is never interpreted as a refill or as cache freshness.
enum QuotaFormatting {
  static func extraResets(_ row: QuotaRow?, connection: String, at date: Date) -> String {
    let now = date.timeIntervalSince1970 * 1000
    guard let row, row.platform == "codex", row.status == "ready" || row.status == "no-windows",
          connection == "online", let observed = row.observedAtMs, observed <= now + 60000,
          now - observed < QuotaSnapshot.maximumAge, let count = row.extraResetsRemaining else { return "—" }
    return String(format: "%.0f", count)
  }
  static func windowLabel(_ window: QuotaWindow) -> String {
    window.scope ?? (window.minutes == 10080 ? "W" : window.minutes == 300 ? "5h" : "Quota")
  }
  static func duration(resetAtMs: Double?, at date: Date) -> String {
    guard let resetAtMs else { return "—" }
    let seconds = max(0, (resetAtMs / 1000) - date.timeIntervalSince1970)
    guard seconds > 0 else { return "—" }
    let minutes = Int(min(seconds / 60, 99 * 1440))
    let value: String
    if minutes < 1 { value = "<1m" }
    else if minutes >= 1440 { value = "\(minutes / 1440)d \((minutes % 1440) / 60)h" }
    else if minutes >= 60 { value = "\(minutes / 60)h \(minutes % 60)m" }
    else { value = "\(minutes)m" }
    return value
  }
}
