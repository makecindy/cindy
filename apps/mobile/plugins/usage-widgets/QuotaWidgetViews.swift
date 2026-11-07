import SwiftUI
import WidgetKit

/// The Mac panel's glass tube, without motion: widgets are still snapshots. The liquid is teal
/// while plenty is left and takes the quota color below 30% (yellow) and 10% (red).
struct TubeView: View {
  let source: WidgetSource
  let width: CGFloat
  let height: CGFloat
  @Environment(\.widgetRenderingMode) private var renderingMode

  private var radius: CGFloat { min(13, width / 2) }

  var body: some View {
    let inset: CGFloat = 3
    let wellHeight = height - inset * 2
    let fraction = max(0, min(1, source.fill))
    let liquid = fraction > 0 ? max(3, fraction * wellHeight) : 0
    let accented = renderingMode == .accented
    let tint = accented ? nil : WidgetPalette.level(source.level)
    ZStack {
      RoundedRectangle(cornerRadius: radius, style: .circular)
        .fill(LinearGradient(colors: [WidgetPalette.wellTop, WidgetPalette.wellBottom], startPoint: .top, endPoint: .bottom)
          .shadow(.inner(color: WidgetPalette.wellShade, radius: 1.5, y: 1)))
      if source.reserve {
        HatchPattern()
          .stroke(WidgetPalette.ink4, lineWidth: 2)
          .clipShape(RoundedRectangle(cornerRadius: radius - inset, style: .circular))
          .padding(inset)
      }
      VStack(spacing: 0) {
        Spacer(minLength: 0)
        // The surface's corners are softly rounded rather than a hard flat edge; the well's
        // rounded bottom still shapes low levels.
        let surface = min(4, liquid / 2)
        UnevenRoundedRectangle(topLeadingRadius: surface, topTrailingRadius: surface, style: .circular)
          .fill(accented ? WidgetPalette.liquid : (tint ?? WidgetPalette.plenty))
          .frame(height: liquid)
          .widgetAccentable()
      }
      .clipShape(RoundedRectangle(cornerRadius: radius - inset, style: .circular))
      .padding(inset)
      RoundedRectangle(cornerRadius: radius, style: .circular)
        .strokeBorder(source.emphasized ? WidgetPalette.ink2 : WidgetPalette.ink4, lineWidth: source.emphasized ? 1 : 0.5)
    }
    .background(alignment: .bottom) {
      if let tint, fraction > 0 {
        Ellipse()
          .fill(RadialGradient(colors: [tint.opacity(0.5), .clear], center: .center, startRadius: 0, endRadius: 18))
          .frame(width: 34, height: 14)
          .blur(radius: 4)
          .offset(y: 7)
          .opacity(0.45)
      }
    }
    .frame(width: width, height: height)
    .opacity(source.stale == true ? 0.45 : 1)
  }
}

struct HatchPattern: Shape {
  func path(in rect: CGRect) -> Path {
    var path = Path()
    var x = -rect.height
    while x < rect.width {
      path.move(to: CGPoint(x: x, y: rect.maxY))
      path.addLine(to: CGPoint(x: x + rect.height, y: rect.minY))
      x += 7
    }
    return path
  }
}

/// Number above the tube: Barlow digits with a smaller % on the same baseline. It keeps its
/// ink at every level; the liquid alone carries the quota color.
struct SourceValue: View {
  let source: WidgetSource
  let size: CGFloat
  let unitSize: CGFloat

  var body: some View {
    if let value = source.value {
      HStack(alignment: .firstTextBaseline, spacing: 1) {
        Text(value).font(WidgetNumFont.font(source.kind == "balance" ? size - 2 : size))
        if let unit = source.unit {
          Text(unit).font(WidgetNumFont.font(unitSize)).foregroundStyle(WidgetPalette.ink3)
        }
      }
      .lineLimit(1)
      .minimumScaleFactor(0.7)
      .foregroundStyle(WidgetPalette.ink)
      .opacity(source.stale == true ? 0.5 : 1)
    } else {
      Text(source.label ?? "—")
        .font(.system(size: 10.5, weight: .semibold))
        .foregroundStyle(WidgetPalette.ink2)
        .lineLimit(1)
        .minimumScaleFactor(0.8)
    }
  }
}

/// Reset time under a tube. It colors only when quota will go unused at the reset
/// (`WidgetFormat.resetLevel`); tinted screens lose the color, so a dot marks it there.
struct SourceWhen: View {
  let text: String
  let level: String
  let size: CGFloat
  @Environment(\.widgetRenderingMode) private var renderingMode

  var body: some View {
    let accented = renderingMode == .accented
    HStack(spacing: 3) {
      if accented && level != "normal" {
        Circle().frame(width: 4, height: 4)
      }
      Text(text)
        .font(.system(size: size, weight: .medium))
        .monospacedDigit()
        .lineLimit(1)
        .truncationMode(.tail)
    }
    .foregroundStyle((accented ? nil : WidgetPalette.level(level)) ?? WidgetPalette.ink2)
  }
}

struct SourceColumn: View {
  let source: WidgetSource
  let format: WidgetFormat
  let tubeWidth: CGFloat
  let tubeHeight: CGFloat
  let valueSize: CGFloat
  let unitSize: CGFloat
  var nameSize: CGFloat = 10.5
  var whenSize: CGFloat = 10
  /// Logo above the name (Mac layout) instead of beside it.
  var stacked = false
  var coarseWhen = false

  var body: some View {
    VStack(spacing: 0) {
      SourceValue(source: source, size: valueSize, unitSize: unitSize)
        .frame(height: valueSize + 2, alignment: .bottom)
      TubeView(source: source, width: tubeWidth, height: tubeHeight)
        .padding(.top, stacked ? 6 : 4)
      Group {
        if stacked {
          VStack(spacing: 4) {
            LogoMark(source: source, size: nameSize + 1.5).foregroundStyle(WidgetPalette.ink)
            Text(source.name).lineLimit(1).truncationMode(.tail)
          }
        } else {
          HStack(spacing: 3) {
            LogoMark(source: source, size: 10).foregroundStyle(WidgetPalette.ink)
            Text(source.name).lineLimit(1).truncationMode(.tail)
          }
        }
      }
      .font(.system(size: nameSize))
      .foregroundStyle(WidgetPalette.ink2)
      .padding(.top, stacked ? 8 : 6)
      SourceWhen(text: format.when(source, coarse: coarseWhen), level: format.resetLevel(source), size: whenSize)
        .padding(.top, stacked ? 3 : 1)
    }
    .frame(maxWidth: .infinity)
  }
}

/// Orange "updated 7 hours ago" line, shown only when the readings are old.
struct StaleLine: View {
  let text: String
  var body: some View {
    Text(text)
      .font(.system(size: 11, weight: .medium))
      .foregroundStyle(WidgetPalette.warn)
      .lineLimit(1)
      .frame(maxWidth: .infinity, alignment: .leading)
  }
}

struct EmptyStateView: View {
  let title: String
  let body_: String

  var body: some View {
    VStack(alignment: .leading, spacing: 3) {
      Image("logo-cindy").renderingMode(.template).resizable().scaledToFit()
        .frame(width: 16, height: 16).foregroundStyle(WidgetPalette.ink3)
      Spacer(minLength: 0)
      Text(title).font(.system(size: 15, weight: .semibold)).tracking(-0.3).foregroundStyle(WidgetPalette.ink)
      Text(body_).font(.system(size: 12)).foregroundStyle(WidgetPalette.ink3).lineLimit(3)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
  }
}

struct QuotaWidgetView: View {
  let state: WidgetState
  let now: Date
  /// Leading sources the edit sheet placed first; the small size keeps them as placed.
  var pinnedCount = 0
  @Environment(\.widgetFamily) private var family

  var body: some View {
    let format = WidgetFormat(snapshot: state.snapshot, now: now)
    Group {
      switch state {
      case .updateDesktop:
        EmptyStateView(title: WidgetText.text("updateTitle"), body_: WidgetText.text("updateBody"))
          .padding(16)
      case .empty:
        EmptyStateView(title: WidgetText.text("emptyTitle"), body_: WidgetText.text("emptyBody"))
          .padding(16)
      case .snapshot(_, _, let snapshot):
        if snapshot.sources.isEmpty {
          EmptyStateView(title: WidgetText.text("noSources", locale: format.locale), body_: WidgetText.text("emptyBody", locale: format.locale))
            .padding(16)
        } else if snapshot.sources.count == 1, let source = snapshot.sources.first, let detail = source.detail {
          SingleSourceView(source: source, detail: detail, format: format)
        } else {
          content(snapshot.sources, format: format)
        }
      }
    }
  }

  @ViewBuilder
  private func content(_ sources: [WidgetSource], format: WidgetFormat) -> some View {
    switch family {
    case .systemSmall:
      // Accounts placed first, then subscriptions; the Cindy balance is not a subscription.
      let rest = Array(sources.dropFirst(pinnedCount))
      let subscriptions = rest.filter { $0.kind == "subscription" }
      let list = Array((sources.prefix(pinnedCount) + (subscriptions.isEmpty ? rest : subscriptions)).prefix(4))
      let stale = format.staleLabel(minimumHours: 6)
      VStack(spacing: 0) {
        if let stale { StaleLine(text: stale).padding(.bottom, 4) }
        Spacer(minLength: 0)
        HStack(alignment: .top, spacing: 0) {
          ForEach(list) { source in
            SourceColumn(source: source, format: format, tubeWidth: 22, tubeHeight: stale == nil ? 62 : 44,
                         valueSize: 16, unitSize: 9.5, nameSize: 10, whenSize: 10, stacked: true, coarseWhen: true)
          }
        }
      }
      .padding(EdgeInsets(top: 13, leading: 8, bottom: 12, trailing: 8))
    case .systemLarge:
      let list = Array(sources.prefix(7))
      VStack(spacing: 0) {
        let stale = format.staleLabel(minimumHours: 6) != nil
        Text(format.updatedLabel())
          .font(.system(size: 11, weight: stale ? .medium : .regular))
          .foregroundStyle(stale ? WidgetPalette.warn : WidgetPalette.ink3)
          .frame(maxWidth: .infinity, alignment: .trailing)
        HStack(alignment: .top, spacing: list.count > 6 ? 2 : 4) {
          ForEach(list) { source in
            SourceColumn(source: source, format: format, tubeWidth: 38, tubeHeight: 140,
                         valueSize: 20, unitSize: 12, nameSize: 10.5, whenSize: 10.5, stacked: true)
          }
        }
        .padding(.top, 10)
        Spacer(minLength: 8)
        MonthCard(snapshot: format.snapshot, format: format)
      }
      .padding(EdgeInsets(top: 16, leading: 14, bottom: 14, trailing: 14))
    default:
      let list = Array(sources.prefix(6))
      let stale = format.staleLabel(minimumHours: 6)
      VStack(spacing: 0) {
        if let stale { StaleLine(text: stale).padding(.horizontal, 4).padding(.bottom, 4) }
        Spacer(minLength: 0)
        HStack(alignment: .top, spacing: 0) {
          ForEach(list) { source in
            SourceColumn(source: source, format: format, tubeWidth: 28, tubeHeight: stale == nil ? 72 : 54,
                         valueSize: 18, unitSize: 11)
          }
        }
      }
      .padding(EdgeInsets(top: 14, leading: 12, bottom: 12, trailing: 12))
    }
  }
}

/// "Last 30 days · All devices" total with the stacked area chart, as on the Mac panel.
struct MonthCard: View {
  let snapshot: WidgetSnapshot?
  let format: WidgetFormat

  var body: some View {
    let daily = snapshot?.usage.daily ?? []
    let total = daily.reduce(0) { $0 + $1.total }
    HStack(spacing: 12) {
      VStack(alignment: .leading, spacing: 0) {
        Text(format.s(snapshot?.usage.scope == "local" ? "monthScopeLocal" : "monthScopeAll"))
          .font(.system(size: 10.5))
          .foregroundStyle(WidgetPalette.ink3)
          .lineLimit(1)
        Text(format.money(total)).font(WidgetNumFont.font(22)).foregroundStyle(WidgetPalette.ink)
      }
      .fixedSize()
      StackedAreaChart(daily: daily, breakdown: UsageBreakdown(snapshot: snapshot, locale: format.locale, metric: .money))
        .frame(height: 28)
    }
    .padding(EdgeInsets(top: 9, leading: 12, bottom: 9, trailing: 12))
    .background(RoundedRectangle(cornerRadius: 14, style: .circular).fill(WidgetPalette.tile))
    .overlay(RoundedRectangle(cornerRadius: 14, style: .circular).strokeBorder(WidgetPalette.line, lineWidth: 0.5))
  }
}
