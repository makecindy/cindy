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
      UsageWidgetRoot(entry: entry, quota: true)
        .widgetURL(openAppURL())
    }
    .configurationDisplayName(WidgetText.text("quotaName"))
    .description(WidgetText.text("quotaDescription"))
    .supportedFamilies([.systemSmall, .systemMedium, .systemLarge, .accessoryCircular, .accessoryRectangular, .accessoryInline])
    .contentMarginsDisabled()
  }
}

struct DailyUsageWidget: Widget {
  var body: some WidgetConfiguration {
    AppIntentConfiguration(kind: "CindyDailyUsageWidget", intent: SelectComputerIntent.self, provider: UsageProvider()) { entry in
      UsageWidgetRoot(entry: entry, quota: false)
        .widgetURL(openAppURL())
    }
    .configurationDisplayName(WidgetText.text("usageName"))
    .description(WidgetText.text("usageDescription"))
    .supportedFamilies([.systemSmall, .systemMedium, .systemLarge, .accessoryCircular, .accessoryRectangular, .accessoryInline])
    .contentMarginsDisabled()
  }
}

/// Accessory families use the system's monochrome treatment, without the home-screen backdrop.
struct UsageWidgetRoot: View {
  let entry: UsageEntry
  let quota: Bool
  @Environment(\.widgetFamily) private var family

  private var accessory: Bool {
    [.accessoryCircular, .accessoryRectangular, .accessoryInline].contains(family)
  }

  var body: some View {
    Group {
      if accessory {
        UsageAccessoryView(state: entry.state, now: entry.date, quota: quota, family: family, pinnedCount: entry.pinnedCount)
          .privacySensitive()
      } else if quota {
        QuotaWidgetView(state: entry.state, now: entry.date, pinnedCount: entry.pinnedCount)
      } else {
        UsageWidgetView(state: entry.state, now: entry.date)
      }
    }
    .containerBackground(for: .widget) {
      if accessory { Color.clear } else { WidgetBackdrop() }
    }
  }
}

/// Lock-screen quota keeps compact tubes; daily usage pairs a seven-day trend with its total.
struct UsageAccessoryView: View {
  let state: WidgetState
  let now: Date
  let quota: Bool
  let family: WidgetFamily
  var pinnedCount = 0

  var body: some View {
    let format = WidgetFormat(snapshot: state.snapshot, now: now)
    Group {
      if quota, let sources = state.snapshot?.sources, !sources.isEmpty {
        if family == .accessoryInline, let source = lowestQuotaSource(sources) {
          let inlineSources = inlineQuotaSources(sources)
          ViewThatFits(in: .horizontal) {
            if inlineSources.count == 2 {
              inlineQuotaPair(inlineSources, format: format)
            }
            quotaContent(source, format: format)
          }
        } else {
          QuotaAccessoryStrip(sources: sources, pinnedCount: pinnedCount, format: format, compact: family == .accessoryCircular)
        }
      } else if !quota, let usage = state.snapshot?.usage,
                !usage.recentDays.isEmpty {
        if family == .accessoryInline {
          DailyUsageInline(usage: usage, format: format)
        } else {
          DailyUsageAccessory(usage: usage, format: format, compact: family == .accessoryCircular)
        }
      } else {
        let update: Bool = { if case .updateDesktop = state { return true }; return false }()
        let title = WidgetText.text(update ? "updateTitle" : quota ? "emptyTitle" : "emptyUsageTitle", locale: format.locale)
        reading(title: "Cindy", value: "—", unit: "", detail: title,
                symbol: update ? "arrow.up.circle" : "arrow.clockwise", stale: false)
      }
    }
    .foregroundStyle(.primary)
  }

  private func inlineQuotaPair(_ sources: [WidgetSource], format: WidgetFormat) -> some View {
    let first = sources[0]
    let second = sources[1]
    let label: (WidgetSource) -> String = { source in
      let value = source.value ?? source.label ?? "—"
      let unit = source.value == nil ? "" : source.unit ?? ""
      return "\(value)\(unit == "%" ? "" : " ")\(unit)"
    }
    let icon: (WidgetSource) -> Image = { source in
      // Inline templates include top optical padding: WidgetKit ignores Text baseline
      // modifiers on image attachments, so align artwork inside the asset canvas.
      source.logo.map { Image("inline-logo-\($0)").renderingMode(.template) }
        ?? Image(systemName: "person.crop.circle")
    }
    // Images embedded in a single Text survive the system's inline widget rendering.
    // Fixed ideal width lets ViewThatFits prefer the single-account fallback over truncation.
    return Text("\(icon(first)) \(label(first)) · \(icon(second)) \(label(second))")
      .fixedSize(horizontal: true, vertical: false)
      .opacity(format.staleLabel(minimumHours: 1) != nil || sources.contains(where: {
        $0.stale == true || ($0.resetsAtMs.map { $0 <= now.timeIntervalSince1970 * 1000 } ?? false)
      }) ? 0.55 : 1)
      .accessibilityLabel(sources.map { "\($0.name), \(label($0)), \(quotaTiming($0, format: format))" }.joined(separator: "; ") + ", " + format.updatedLabel())
  }

  private func quotaContent(_ source: WidgetSource, format: WidgetFormat) -> some View {
    let stale = source.stale == true || format.staleLabel(minimumHours: 1) != nil
    let reset = source.resetsAtMs.map { $0 <= now.timeIntervalSince1970 * 1000 } ?? false
    let detail = quotaTiming(source, format: format)
    let value = source.value ?? source.label ?? "—"
    let unit = source.value == nil ? "" : source.unit ?? ""
    let label = "\(value)\(unit == "%" ? "" : " ")\(unit)"
    return Label {
      Text(label)
    } icon: {
      // Inline accepts a single Image, not the composed LogoMark view.
      if let logo = source.logo {
        Image("logo-\(logo)").renderingMode(.template)
      } else {
        Image(systemName: "person.crop.circle")
      }
    }
    .opacity(stale || reset ? 0.55 : 1)
    .accessibilityLabel("\(source.name), \(label), \(detail)")
  }

  private func quotaTiming(_ source: WidgetSource, format: WidgetFormat) -> String {
    let duration = format.when(source)
    let reset = source.resetsAtMs.map { $0 <= now.timeIntervalSince1970 * 1000 } ?? false
    let timing = duration.isEmpty ? "" : reset ? duration
      : WidgetText.text("resetsIn", locale: format.locale).replacingOccurrences(of: "{{duration}}", with: duration)
    let stale = source.stale == true || format.staleLabel(minimumHours: 1) != nil
    return [timing, stale || timing.isEmpty ? format.updatedLabel() : ""]
      .filter { !$0.isEmpty }.joined(separator: ", ")
  }

  @ViewBuilder
  private func reading(title: String, value: String, unit: String, detail: String,
                       symbol: String, stale: Bool) -> some View {
    let label = "\(title) \(value)\(unit == "%" ? "" : " ")\(unit)"
    Group {
      switch family {
      case .accessoryInline:
        Label("\(value)\(unit == "%" ? "" : " ")\(unit) · \(title)", systemImage: stale ? "clock" : symbol)
      case .accessoryCircular:
        ZStack {
          AccessoryWidgetBackground()
          VStack(spacing: 1) {
            Image(systemName: stale ? "clock" : symbol).font(.caption2)
            Text(value).font(.headline).monospacedDigit().lineLimit(1).minimumScaleFactor(0.6)
            Text(unit.isEmpty ? title : unit).font(.system(size: 9)).lineLimit(1).minimumScaleFactor(0.7)
          }.padding(4)
        }
      default:
        VStack(alignment: .leading, spacing: 1) {
          Label(title, systemImage: stale ? "clock" : symbol)
            .font(.caption).lineLimit(1)
          HStack(alignment: .firstTextBaseline, spacing: 2) {
            Text(value).font(.title2.bold()).monospacedDigit()
            Text(unit).font(.caption)
          }.lineLimit(1).minimumScaleFactor(0.65)
          Text(detail).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
        }.frame(maxWidth: .infinity, alignment: .leading)
      }
    }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("\(label), \(detail)")
  }
}

/// The same real daily readings drive both the inline sparkline and larger accessories.
struct DailyUsageTrend: View {
  let values: [Double]
  var body: some View {
    GeometryReader { geometry in
      let peak = max(1, values.max() ?? 0)
      let step = geometry.size.width / CGFloat(max(1, values.count))
      HStack(alignment: .bottom, spacing: step * 0.38) {
        ForEach(values.indices, id: \.self) { index in
          RoundedRectangle(cornerRadius: min(1.5, step * 0.15), style: .circular)
            .fill(.primary.opacity(index == values.count - 1 ? 0.85 : 0.4))
            .frame(width: step * 0.62,
                   height: CGFloat(values[index] / peak) * geometry.size.height)
        }
      }.frame(width: geometry.size.width, height: geometry.size.height, alignment: .bottomTrailing)
    }
  }
}

struct DailyUsageInline: View {
  let usage: WidgetUsage
  let format: WidgetFormat
  @Environment(\.displayScale) private var displayScale

  var body: some View {
    let days = usage.recentDays
    let date = days.last?.date ?? ""
    let title = format.isToday(date) ? format.s("today") : format.monthDay(date)
    let value = format.tokens(days.last?.tokens ?? 0)
    let renderer = ImageRenderer(content: DailyUsageTrend(values: days.map(\.tokens))
      .frame(width: 28, height: 12).environment(\.colorScheme, .light))
    let _ = renderer.scale = displayScale
    Label {
      Text("\(title) \(value) \(format.s("tokenUnit"))")
    } icon: {
      if let image = renderer.uiImage {
        Image(uiImage: image).renderingMode(.template)
      }
    }
    .opacity(format.staleLabel(minimumHours: 1) != nil ? 0.55 : 1)
    .accessibilityLabel("\(title), \(value) \(format.s("tokenUnit")), \(format.updatedLabel())")
    .accessibilityValue(days.map { "\(format.monthDay($0.date)): \(format.tokens($0.tokens))" }.joined(separator: ", "))
  }
}

/// A seven-day trend above the compact total, or beside it in the wider accessory.
struct DailyUsageAccessory: View {
  let usage: WidgetUsage
  let format: WidgetFormat
  let compact: Bool

  var body: some View {
    let days = usage.recentDays
    let date = days.last?.date ?? ""
    let title = format.isToday(date) ? format.s("today") : format.monthDay(date)
    let value = format.tokens(days.last?.tokens ?? 0)
    let stale = format.staleLabel(minimumHours: 1) != nil
    GeometryReader { geometry in
      if compact {
        VStack(spacing: 3) {
          DailyUsageTrend(values: days.map(\.tokens))
            .frame(width: min(40, geometry.size.width), height: 20)
            .opacity(stale ? 0.45 : 1)
          HStack(alignment: .firstTextBaseline, spacing: 2) {
            if stale {
              Image(systemName: "clock").font(.system(size: 7)).foregroundStyle(.secondary)
            }
            Text(value).font(.system(size: 13, weight: .regular)).monospacedDigit()
            Text(format.s("tokenUnit")).font(.system(size: 7)).foregroundStyle(.secondary)
          }.lineLimit(1).minimumScaleFactor(0.7)
          if !format.isToday(date) {
            Text(title).font(.system(size: 8)).foregroundStyle(.secondary)
              .lineLimit(1).minimumScaleFactor(0.8)
          }
        }
        .frame(width: min(60, geometry.size.width))
        .frame(width: geometry.size.width, height: geometry.size.height)
      } else {
        let height = max(0, min(34, geometry.size.height - 16))
        HStack(spacing: 10) {
          DailyUsageTrend(values: days.map(\.tokens))
            .frame(width: 48, height: height)
            .opacity(stale ? 0.45 : 1)
          VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 2) {
              if stale { Image(systemName: "clock").font(.system(size: 8)) }
              Text(title).font(.system(size: 10)).lineLimit(1).minimumScaleFactor(0.8)
            }.foregroundStyle(.secondary)
            HStack(alignment: .firstTextBaseline, spacing: 3) {
              Text(value).font(.system(size: 16, weight: .regular)).monospacedDigit()
              Text(format.s("tokenUnit")).font(.system(size: 8)).foregroundStyle(.secondary)
            }.lineLimit(1).minimumScaleFactor(0.7)
          }.frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(width: min(geometry.size.width, 138))
        .frame(width: geometry.size.width, height: geometry.size.height)
      }
    }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("\(title), \(value) \(format.s("tokenUnit")), \(format.updatedLabel())")
    .accessibilityValue(days.map {
      "\(format.monthDay($0.date)): \(format.tokens($0.tokens)) \(format.s("tokenUnit"))"
    }.joined(separator: ", "))
  }
}

/// Mirrors Android's compact selection: pinned accounts, then subscriptions (or balances if none).
/// Two accounts in a circular slot, four in a rectangle. Names/times remain available to VoiceOver.
struct QuotaAccessoryStrip: View {
  let sources: [WidgetSource]
  let pinnedCount: Int
  let format: WidgetFormat
  let compact: Bool

  private var shown: [WidgetSource] {
    let pinned = sources.prefix(max(0, pinnedCount))
    let rest = sources.dropFirst(pinned.count)
    let subscriptions = rest.filter { $0.kind == "subscription" }
    return Array((Array(pinned) + (subscriptions.isEmpty ? Array(rest) : subscriptions)).prefix(compact ? 2 : 4))
  }

  var body: some View {
    GeometryReader { geometry in
      HStack(spacing: compact ? 6 : 10) {
        ForEach(shown) { source in column(source) }
      }
      .frame(width: min(geometry.size.width, CGFloat(shown.count) * (compact ? 27 : 29) + CGFloat(max(0, shown.count - 1)) * (compact ? 6 : 10)))
      .frame(width: geometry.size.width, height: geometry.size.height)
    }
  }

  private func column(_ source: WidgetSource) -> some View {
    let stale = source.stale == true || format.staleLabel(minimumHours: 1) != nil
    let expired = source.resetsAtMs.map { $0 <= format.now.timeIntervalSince1970 * 1000 } ?? false
    let when = stale ? format.updatedLabel() : format.when(source, coarse: true)
    let logoSize: CGFloat = compact ? 13 : 14
    return VStack(spacing: 4) {
      Group {
        if stale || expired { Image(systemName: "clock").font(.system(size: logoSize)) }
        else { LogoMark(source: source, size: logoSize) }
      }.frame(height: logoSize)
      HStack(alignment: .firstTextBaseline, spacing: 0) {
        Text(source.value ?? source.label ?? "—")
          .font(.system(size: compact ? 11 : 13, weight: .regular))
        if source.value != nil, let unit = source.unit {
          Text(unit).font(.system(size: compact ? 6 : 7)).foregroundStyle(.secondary)
        }
      }.monospacedDigit().lineLimit(1).minimumScaleFactor(0.65)
      AccessoryQuotaTube(source: source, width: 4, height: compact ? 24 : 28, faded: stale || expired)
        .rotationEffect(.degrees(90))
        .frame(width: compact ? 24 : 28, height: 4)
    }
    .frame(maxWidth: .infinity)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("\(source.name), \(source.value ?? source.label ?? "—") \(source.unit ?? ""), \(when)")
  }

}

/// The desktop tube's inset well and gently rounded surface, scaled for monochrome accessories.
/// Clip the liquid to the well instead of rounding its bottom independently: tiny values should
/// pool at the bottom, while a full reading still leaves glass between the liquid and outer edge.
struct AccessoryQuotaTube: View {
  let source: WidgetSource
  let width: CGFloat
  let height: CGFloat
  var faded = false
  @Environment(\.displayScale) private var displayScale

  var body: some View {
    // strokeBorder consumes space inside the outer bounds. Measure the clear gap from its
    // inner edge, not the outer bounds; otherwise emphasized tubes almost touch the liquid.
    // Whole physical pixels keep this tiny gap consistent instead of antialiasing it away.
    let scale = max(1, displayScale)
    let borderWidth: CGFloat = (source.emphasized ? 2 : 1) / scale
    // Preserve at least two physical pixels of liquid at 2x as well as 3x.
    // Reduce only the clear gap when the emphasized border leaves too little room.
    let gap = min(2 / scale, max(0, (width - 2 * borderWidth - 2 / scale) / 2))
    let inset = borderWidth + gap
    let wellWidth = max(0, width - 2 * inset)
    let radius = width / 2
    let innerRadius = max(0, radius - inset)
    let wellHeight = max(0, height - 2 * inset)
    let fraction = source.fill.isFinite ? min(1, max(0, source.fill)) : 0
    let liquidHeight = fraction > 0 ? min(wellHeight, max(1, fraction * wellHeight)) : 0
    let percent = source.unit == "%" && source.value != nil && !source.reserve
    ZStack {
      RoundedRectangle(cornerRadius: radius, style: .circular)
        .fill(LinearGradient(colors: [.primary.opacity(0.10), .primary.opacity(0.025)],
                             startPoint: .top, endPoint: .bottom))
      if percent {
        VStack(spacing: 0) {
          Spacer(minLength: 0)
          let surface = min(0.7, liquidHeight / 2)
          UnevenRoundedRectangle(topLeadingRadius: surface, topTrailingRadius: surface, style: .circular)
            .fill(.primary.opacity(0.68))
            .frame(height: liquidHeight)
        }
        .frame(width: wellWidth, height: wellHeight)
        .clipShape(RoundedRectangle(cornerRadius: innerRadius, style: .circular))
      } else {
        // Balances have no denominator; keep a striped well without implying percentage.
        HatchPattern().stroke(.primary.opacity(0.35), lineWidth: 0.6)
          .frame(width: wellWidth, height: wellHeight)
          .clipShape(RoundedRectangle(cornerRadius: innerRadius, style: .circular))
      }
      RoundedRectangle(cornerRadius: radius, style: .circular)
        .strokeBorder(.primary.opacity(source.emphasized ? 0.6 : 0.25),
                      lineWidth: borderWidth)
    }
    .frame(width: width, height: height)
    .opacity(faded ? 0.45 : 1)
  }
}

@main
struct CindyUsageWidgetsBundle: WidgetBundle {
  var body: some Widget {
    QuotaWidget()
    DailyUsageWidget()
    CindyAgentActivityWidget()
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
