import AppIntents
import SwiftUI
import WidgetKit

struct UsageEntry: TimelineEntry {
  let date: Date
  let state: WidgetState
  /// How many leading sources the edit sheet placed first (`QuotaWidgetView.pinnedCount`).
  var pinnedCount = 0
}

/// Reads the state the app last wrote for the widget's computer. Entries every 15 minutes keep
/// reset countdowns and the "updated" age current without new data; the app reloads timelines
/// when data arrives.
struct UsageProvider<Configuration: UsageWidgetConfiguration>: AppIntentTimelineProvider {
  func placeholder(in context: Context) -> UsageEntry {
    UsageEntry(date: Date(), state: .sample)
  }

  func snapshot(for configuration: Configuration, in context: Context) async -> UsageEntry {
    let entry = Self.entry(configuration, at: Date())
    if context.isPreview, case .empty = entry.state { return UsageEntry(date: Date(), state: .sample) }
    return entry
  }

  func timeline(for configuration: Configuration, in context: Context) async -> Timeline<UsageEntry> {
    if let id = configuration.computerID, id != ComputerEntity.autoID { WidgetStore.recordPin(id) }
    let now = Date()
    let entries = (0..<24).map { Self.entry(configuration, at: now.addingTimeInterval(Double($0) * 15 * 60)) }
    return Timeline(entries: entries, policy: .atEnd)
  }

  private static func entry(_ configuration: Configuration, at date: Date) -> UsageEntry {
    let state = WidgetState.load(computer: configuration.computerID)
    if let arranged = state.arranged(pinned: configuration.pinnedAccounts, hidden: configuration.hiddenAccounts) {
      return UsageEntry(date: date, state: arranged.state, pinnedCount: arranged.pinnedCount)
    }
    return UsageEntry(date: date, state: state)
  }
}

private func openAppURL() -> URL? {
  guard let scheme = Bundle.main.object(forInfoDictionaryKey: "CindyURLScheme") as? String else { return nil }
  return URL(string: "\(scheme)://")
}

struct QuotaWidget: Widget {
  var body: some WidgetConfiguration {
    AppIntentConfiguration(kind: "CindyQuotaWidget", intent: QuotaWidgetIntent.self, provider: UsageProvider()) { entry in
      QuotaWidgetView(state: entry.state, now: entry.date, pinnedCount: entry.pinnedCount)
        .containerBackground(for: .widget) { WidgetBackdrop() }
        .widgetURL(openAppURL())
    }
    .configurationDisplayName(WidgetText.text("quotaName"))
    .description(WidgetText.text("quotaDescription"))
    .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
    .contentMarginsDisabled()
  }
}

struct DailyUsageWidget: Widget {
  var body: some WidgetConfiguration {
    AppIntentConfiguration(kind: "CindyDailyUsageWidget", intent: SelectComputerIntent.self, provider: UsageProvider()) { entry in
      UsageWidgetView(state: entry.state, now: entry.date)
        .containerBackground(for: .widget) { WidgetBackdrop() }
        .widgetURL(openAppURL())
    }
    .configurationDisplayName(WidgetText.text("usageName"))
    .description(WidgetText.text("usageDescription"))
    .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
    .contentMarginsDisabled()
  }
}

@main
struct CindyUsageWidgetsBundle: WidgetBundle {
  var body: some Widget {
    QuotaWidget()
    DailyUsageWidget()
  }
}

extension WidgetState {
  /// Gallery and placeholder content: shape only, never real account data.
  static var sample: WidgetState {
    let now = Date().timeIntervalSince1970 * 1000
    let hour = 3_600_000.0
    func source(_ id: String, _ logo: String, _ name: String, _ value: Double, reset: Double, emphasized: Bool = false) -> WidgetSource {
      WidgetSource(id: id, kind: "subscription", name: name, logo: logo, monogram: String(name.prefix(1)).uppercased(),
                   value: String(Int(value * 100)), unit: "%", label: nil, level: value <= 0.1 ? "error" : value <= 0.3 ? "warn" : "normal",
                   fill: value, reserve: false, emphasized: emphasized, when: "", resetsAtMs: now + reset * hour)
    }
    var days: [String] = []
    var daily: [WidgetDay] = []
    let calendar = Calendar.current
    let formatter = DateFormatter()
    formatter.dateFormat = "yyyy-MM-dd"
    for i in 0..<30 {
      let date = calendar.date(byAdding: .day, value: i - 29, to: Date()) ?? Date()
      days.append(formatter.string(from: date))
      let wave = 0.65 + 0.35 * sin(Double(i) * 0.9)
      daily.append(WidgetDay(money: [36 * wave, 20 * (1.2 - wave * 0.5), 2], paid: 2, tokens: [7e7 * wave, 4e7, 2e6]))
    }
    let snapshot = WidgetSnapshot(
      version: 1, generatedAtMs: now, updatedAtMs: now, locale: Locale.preferredLanguages.first ?? "en", moneySymbol: "$",
      sources: [
        source("a", "claude", "Claude", 0.62, reset: 2.6),
        source("b", "codex", "Codex", 0.78, reset: 129, emphasized: true),
        source("c", "codex", "Work", 0.39, reset: 52),
        source("d", "codex", "Team", 0.11, reset: 14.4),
      ],
      usage: WidgetUsage(scope: "all", days: days, daily: daily),
      strings: [:]
    )
    return .snapshot(receivedAtMs: now, deviceName: "Mac", snapshot: snapshot)
  }
}
