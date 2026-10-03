import SwiftUI
import WidgetKit

struct QuotaEntry: TimelineEntry { let date: Date; let snapshot: QuotaSnapshot }
struct QuotaTimeline: TimelineProvider {
  func placeholder(in context: Context) -> QuotaEntry { QuotaEntry(date: Date(), snapshot: .empty) }
  func getSnapshot(in context: Context, completion: @escaping (QuotaEntry) -> Void) {
    completion(QuotaEntry(date: Date(), snapshot: QuotaSnapshotStore.load()))
  }
  func getTimeline(in context: Context, completion: @escaping (Timeline<QuotaEntry>) -> Void) {
    let snapshot = QuotaSnapshotStore.load(), now = Date()
    let milliseconds = now.timeIntervalSince1970 * 1000
    let boundaries = snapshot.rows.flatMap { row -> [Double?] in
      let expiry = row.windows.map { $0.observedAtMs.map { $0 + QuotaSnapshot.maximumAge } }
      let rowExpiry = row.observedAtMs.map { $0 + QuotaSnapshot.maximumAge }
      return [rowExpiry] + expiry + row.windows.map(\.resetAtMs)
    }.compactMap { $0 }.filter { $0 > milliseconds && $0 <= milliseconds + 86_400_000 }
    // Local entries expire cached values and advance reset text; they never query a provider.
    let ticks = (1...15).map { now.addingTimeInterval(Double($0) * 60) }
    let dates = Array(Set([now] + ticks + boundaries.map { Date(timeIntervalSince1970: $0 / 1000) })).sorted()
    completion(Timeline(entries: dates.map { QuotaEntry(date: $0, snapshot: snapshot) }, policy: .after(now.addingTimeInterval(15 * 60))))
  }
}

/// User-reviewed widget frame, shared by every provider; only the information below it differs.
enum QuotaLayout {
  static let inset = QuotaWidgetResources.frameInset
  static let ring = QuotaWidgetResources.ringSize
  static let stroke = QuotaWidgetResources.ringStroke
  static let brandSize = QuotaWidgetResources.brandSize
  static let detailSize = QuotaWidgetResources.detailSize
  static let radii: [CGFloat] = [18.75, 13.1, 7.45]
  // Quota category colors, not severity. These are the reviewed widget design mappings.
  static func tint(_ index: Int, dark: Bool) -> Color {
    QuotaWidgetResources.color(index == 0 ? "quotaWeekly" : index == 1 ? "quotaSession" : "quotaScoped", dark: dark)
  }
}

struct QuotaProviderView: View {
  let platform: String
  let row: QuotaRow?
  let entry: QuotaEntry
  let dark: Bool
  var medium: Bool = false
  private var name: String { ["claude": "Claude", "codex": "Codex", "xai": "Grok"][platform] ?? "Cindy" }
  private var secondary: Color { QuotaWidgetResources.color("widgetSecondary", dark: dark) }
  private var primary: Color { QuotaWidgetResources.color("widgetPrimary", dark: dark) }
  private var windows: [QuotaWindow] {
    guard let row else { return [] }
    if platform != "claude" { return Array(row.windows.filter { $0.minutes == 10080 && $0.kind != "scoped" }.prefix(1)) }
    return Array(row.windows.sorted { order($0) < order($1) }.prefix(3))
  }
  private func order(_ w: QuotaWindow) -> Int { w.kind == "scoped" ? 2 : w.minutes == 10080 ? 0 : 1 }
  private func state(_ w: QuotaWindow) -> String { row.map { entry.snapshot.state($0, w, at: entry.date) } ?? "unavailable" }
  private func value(_ w: QuotaWindow) -> String {
    state(w) == "fresh" ? "\(Int((w.remainingPercent ?? 0).rounded()))%" : "—"
  }
  private func label(_ w: QuotaWindow) -> String { QuotaFormatting.windowLabel(w) }
  private func detail(_ w: QuotaWindow) -> String {
    switch state(w) {
    case "fresh": return QuotaFormatting.duration(resetAtMs: w.resetAtMs, at: entry.date)
    case "stale": return "Outdated"
    case "offline": return "Offline"
    case "awaitingRefresh": return "Updating"
    default: return "—"
    }
  }
  private var emptyText: String {
    guard let row else { return "Open Cindy" }
    switch row.status {
    case "unauthorized": return "Reconnect"
    case "unsupported": return "Not supported"
    case "no-windows": return "No windows"
    default: return row.available && platform != "claude" && windows.isEmpty ? "No weekly data" : "Couldn’t load"
    }
  }
  private var rings: some View {
    ZStack {
      ForEach(Array(windows.enumerated()), id: \.element.key) { index, window in
        let slot = platform == "claude" ? order(window) : 0
        let radius = QuotaLayout.radii[slot]
        Circle().stroke(QuotaLayout.tint(platform == "claude" ? order(window) : 0, dark: dark).opacity(0.17), lineWidth: QuotaLayout.stroke)
          .frame(width: radius * 2, height: radius * 2)
        if state(window) == "fresh", let percent = window.remainingPercent, percent > 0 {
          Circle().trim(from: 0, to: percent / 100)
            .stroke(QuotaLayout.tint(platform == "claude" ? order(window) : 0, dark: dark), style: StrokeStyle(lineWidth: QuotaLayout.stroke, lineCap: .round))
            .rotationEffect(.degrees(-90)).frame(width: radius * 2, height: radius * 2)
        }
      }
    }.frame(width: QuotaLayout.ring, height: QuotaLayout.ring)
    .accessibilityHidden(true)
  }
  private var brand: some View {
    HStack(alignment: .top, spacing: 3) {
      Image(platform).resizable().renderingMode(.template).scaledToFit()
        .frame(width: 14, height: 14).accessibilityHidden(true)
      VStack(alignment: .leading, spacing: 2) {
        Text(name).font(.system(size: QuotaLayout.brandSize)).frame(height: 14, alignment: .leading)
        Text(row?.plan ?? " ").font(.system(size: QuotaLayout.brandSize))
          .fixedSize(horizontal: false, vertical: true).frame(height: 28, alignment: .topLeading)
          .opacity(row?.plan == nil ? 0 : 1)
      }.frame(width: 61, alignment: .leading)
    }.foregroundStyle(secondary).frame(width: 78, alignment: .leading)
  }
  /// Each semantic row shares a reference baseline across providers, including empty slots.
  /// No scale factor, clipping or provider-specific row heights are used in medium.
  private func mediumLine<Content: View>(primary: Bool = false, height: CGFloat, @ViewBuilder content: () -> Content) -> some View {
    ZStack(alignment: Alignment(horizontal: .leading, vertical: .firstTextBaseline)) {
      Text("100%").font(.system(size: primary ? QuotaWidgetResources.mediumValueSize : QuotaLayout.detailSize, weight: primary ? .medium : .regular))
        .hidden().accessibilityHidden(true)
      content()
    }
    .fixedSize(horizontal: true, vertical: false)
    .frame(height: height, alignment: .leading)
    .frame(maxWidth: .infinity, alignment: .leading)
    .accessibilityElement(children: .combine)
  }
  private func mediumQuota(_ window: QuotaWindow, primary: Bool) -> some View {
    HStack(alignment: .firstTextBaseline, spacing: primary ? QuotaWidgetResources.mediumPrimaryInlineGap : QuotaWidgetResources.mediumInlineGap) {
      Text(value(window)).font(.system(size: primary ? QuotaWidgetResources.mediumValueSize : QuotaLayout.detailSize, weight: primary ? .medium : .regular))
        .foregroundStyle(QuotaLayout.tint(platform == "claude" ? order(window) : 0, dark: dark))
      if !primary {
        Text(label(window)).font(.system(size: QuotaLayout.detailSize))
          .foregroundStyle(QuotaLayout.tint(order(window), dark: dark))
      }
      if window.kind != "scoped" || state(window) != "fresh" {
        Text(detail(window))
          .font(.system(size: QuotaLayout.detailSize)).foregroundStyle(secondary)
      }
    }
  }
  private var mediumInformation: some View {
    // Fixed semantic slots: missing windows stay absent instead of relabeling another quota.
    let week = windows.first { $0.minutes == 10080 && $0.kind != "scoped" }
    let session = windows.first { $0.minutes != 10080 && $0.kind != "scoped" }
    let scoped = windows.first { $0.kind == "scoped" }
    return VStack(alignment: .leading, spacing: QuotaWidgetResources.mediumRowGap) {
      mediumLine(primary: true, height: QuotaWidgetResources.mediumPrimaryRowHeight) {
        if let week { mediumQuota(week, primary: true) }
        else if windows.isEmpty {
          Text("—").font(.system(size: QuotaWidgetResources.mediumValueSize, weight: .medium)).foregroundStyle(secondary)
        }
      }
      mediumLine(height: QuotaWidgetResources.mediumSecondaryRowHeight) {
        if windows.isEmpty {
          Text(emptyText).font(.system(size: QuotaLayout.detailSize)).foregroundStyle(secondary)
        } else if platform == "claude" {
          if let session { mediumQuota(session, primary: false) }
        } else if week != nil {
          Text("Weekly").font(.system(size: QuotaLayout.detailSize)).foregroundStyle(platform == "codex" ? QuotaLayout.tint(1, dark: dark) : primary)
        }
      }
      mediumLine(height: QuotaWidgetResources.mediumTertiaryRowHeight) {
        if platform == "claude" {
          if let scoped { mediumQuota(scoped, primary: false) }
        } else if platform == "codex" {
          extraResets
        } else if let week {
          Text(state(week) == "fresh" ? "Reset \(detail(week))" : detail(week))
            .font(.system(size: QuotaLayout.detailSize)).foregroundStyle(secondary)
        }
      }
    }
  }
  private var extraResets: some View {
    Text("Extra resets: \(QuotaFormatting.extraResets(row, connection: entry.snapshot.connection, at: entry.date))")
      .font(.system(size: QuotaLayout.detailSize)).foregroundStyle(secondary)
  }
  @ViewBuilder private var information: some View {
    if windows.isEmpty {
      VStack(alignment: .leading, spacing: 8) {
        Text("—").font(.system(size: 32))
        Text(emptyText).font(.system(size: QuotaLayout.detailSize))
      }.foregroundStyle(secondary)
    } else if platform == "claude" {
      VStack(alignment: .leading, spacing: 3) {
        ForEach(Array(windows.enumerated()), id: \.element.key) { index, window in
          HStack(alignment: .firstTextBaseline, spacing: 1) {
            Text(value(window)).font(.system(size: 20, weight: .medium)).foregroundStyle(QuotaLayout.tint(platform == "claude" ? order(window) : 0, dark: dark))
            Text(label(window)).font(.system(size: QuotaLayout.detailSize, weight: .medium)).foregroundStyle(QuotaLayout.tint(platform == "claude" ? order(window) : 0, dark: dark))
            if window.kind != "scoped" || state(window) != "fresh" {
              Text(detail(window)).font(.system(size: QuotaLayout.detailSize)).foregroundStyle(secondary).padding(.leading, 3.5)
            }
          }.fixedSize(horizontal: true, vertical: false).frame(height: 24, alignment: .leading)
          .accessibilityElement(children: .combine)
        }
      }
    } else if let window = windows.first {
      VStack(alignment: .leading, spacing: 0) {
        Text(value(window)).font(.system(size: 32, weight: .medium)).foregroundStyle(QuotaLayout.tint(0, dark: dark)).frame(height: 38, alignment: .leading)
        HStack(spacing: 4.5) {
          Text("Weekly").font(.system(size: QuotaLayout.detailSize)).foregroundStyle(platform == "codex" ? QuotaLayout.tint(1, dark: dark) : primary)
          if platform == "codex" { Text(detail(window)).font(.system(size: QuotaLayout.detailSize)).foregroundStyle(secondary) }
        }.frame(height: 21, alignment: .leading)
        if platform == "codex" { extraResets.frame(height: 18, alignment: .leading) }
        else {
          Text(state(window) == "fresh" ? "Reset \(detail(window))" : detail(window))
            .font(.system(size: QuotaLayout.detailSize)).foregroundStyle(secondary).frame(height: 18, alignment: .leading)
        }
      }.fixedSize(horizontal: true, vertical: false)
    }
  }
  var body: some View {
    GeometryReader { geo in
      ZStack(alignment: .topLeading) {
        rings.offset(x: QuotaLayout.inset, y: QuotaLayout.inset)
        brand.offset(x: geo.size.width - 92, y: 17)
        if medium {
          mediumInformation.offset(x: QuotaLayout.inset, y: QuotaWidgetResources.mediumInformationTop)
        } else {
          information.offset(x: QuotaLayout.inset, y: platform == "claude" ? 68 : 66)
        }
      }.frame(width: geo.size.width, height: geo.size.height, alignment: .topLeading)
    }
  }
}

struct QuotaWidgetView: View {
  let entry: QuotaEntry
  var platform: String? = nil
  var previewFamily: WidgetFamily? = nil
  @Environment(\.widgetFamily) private var widgetFamily
  @Environment(\.colorScheme) private var systemScheme
  private var dark: Bool {
    let preference = QuotaSnapshotStore.defaults?.string(forKey: "appearance") ?? "system"
    return preference == "dark" || (preference == "system" && systemScheme == .dark)
  }
  private var platforms: [String] {
    if let platform { return [platform] }
    let present = entry.snapshot.rows.map(\.platform)
    return present.isEmpty ? ["claude", "codex"] : Array(present.prefix((previewFamily ?? widgetFamily) == .systemSmall ? 1 : 2))
  }
  private var content: some View {
    HStack(spacing: 6) {
      ForEach(platforms, id: \.self) { platform in
        QuotaProviderView(platform: platform, row: entry.snapshot.rows.first { $0.platform == platform }, entry: entry, dark: dark, medium: (previewFamily ?? widgetFamily) == .systemMedium)
      }
    }
    .overlay(alignment: .bottomTrailing) {
      if entry.snapshot.source == "demo" {
        Text("Demo").font(.system(size: 10))
          .foregroundStyle(QuotaWidgetResources.color("widgetSecondary", dark: dark))
          .padding(.trailing, QuotaLayout.inset).padding(.bottom, 8)
      }
    }
    .widgetURL(URL(string: (Bundle.main.object(forInfoDictionaryKey: "CindyQuotaScheme") as? String ?? "cindy") + "://subscription-widgets"))
    .privacySensitive()
  }
  var body: some View {
    if #available(iOS 17.0, *) { content.containerBackground(for: .widget) { QuotaWidgetResources.color("widgetSurface", dark: dark) } }
    else { content.background(QuotaWidgetResources.color("widgetSurface", dark: dark)) }
  }
}

struct CindyProviderWidget: Widget {
  let platform: String
  init() { platform = "claude" }
  init(platform: String) { self.platform = platform }
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: "CindySubscriptionQuota.\(platform)", provider: QuotaTimeline()) { QuotaWidgetView(entry: $0, platform: platform) }
      .configurationDisplayName(["claude": "Claude Usage", "codex": "Codex Usage", "xai": "Grok Usage"][platform] ?? "Subscription Usage")
      .description("Latest quota synced from your computer. Open Cindy to update.")
      .supportedFamilies([.systemSmall]).contentMarginsDisabled()
  }
}
struct CindyCombinedWidget: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: "CindySubscriptionQuota", provider: QuotaTimeline()) { QuotaWidgetView(entry: $0) }
      .configurationDisplayName("Subscription Usage")
      .description("Your first two connected subscriptions, side by side.")
      .supportedFamilies([.systemMedium]).contentMarginsDisabled()
  }
}
@main struct CindySubscriptionWidgets: WidgetBundle {
  var body: some Widget {
    CindyProviderWidget(platform: "claude")
    CindyProviderWidget(platform: "codex")
    CindyProviderWidget(platform: "xai")
    CindyCombinedWidget()
  }
}
