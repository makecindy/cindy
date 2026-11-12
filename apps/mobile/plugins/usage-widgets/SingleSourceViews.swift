import SwiftUI
import WidgetKit

/// The panel's detail arc: the visible stroke including both round caps spans exactly
/// 0...progress; a full ring uses butt caps so two caps never meet (`RingArc` on the Mac).
struct RingArc: Shape {
  let progress: Double
  let lineWidth: CGFloat

  func path(in rect: CGRect) -> Path {
    let radius = min(rect.width, rect.height) / 2 - lineWidth / 2
    let center = CGPoint(x: rect.midX, y: rect.midY)
    guard progress > 0.0005, radius > 0 else { return Path() }
    var arc = Path()
    if progress >= 0.9995 {
      arc.addArc(center: center, radius: radius, startAngle: .degrees(-90), endAngle: .degrees(270), clockwise: false)
      return arc.strokedPath(StrokeStyle(lineWidth: lineWidth, lineCap: .butt))
    }
    let cap = Double(lineWidth / 2 / radius)
    let start = -Double.pi / 2 + cap
    let end = max(start + 0.0001, -Double.pi / 2 + 2 * Double.pi * progress - cap)
    arc.addArc(center: center, radius: radius, startAngle: .radians(start), endAngle: .radians(end), clockwise: false)
    return arc.strokedPath(StrokeStyle(lineWidth: lineWidth, lineCap: .round))
  }
}

/// Nested rings with the big value in the middle, sized like the Mac detail page.
struct DetailRings: View {
  let detail: WidgetDetail
  let size: CGFloat
  var showCaption = true
  @Environment(\.widgetRenderingMode) private var renderingMode

  var body: some View {
    let accented = renderingMode == .accented
    let lineWidth = (size * (detail.rings.count > 1 ? 0.06 : 0.068)).rounded()
    let gap: CGFloat = max(2, size / 63)
    let scale = size / 188
    ZStack {
      ForEach(detail.rings.indices, id: \.self) { index in
        let ring = detail.rings[index]
        let inset = 3 * scale + CGFloat(index) * (lineWidth + gap)
        ZStack {
          Circle().strokeBorder(WidgetPalette.ink5, lineWidth: lineWidth)
          RingArc(progress: max(0, min(1, ring.fraction)), lineWidth: lineWidth)
            .fill(accented ? Color.white.opacity(index == 0 ? 1 : 0.6) : WidgetPalette.named(ring.color))
            .widgetAccentable(index == 0)
        }
        .padding(inset)
      }
      VStack(spacing: 2 * scale) {
        HStack(alignment: .firstTextBaseline, spacing: 2) {
          Text(detail.bigValue)
            .font(WidgetNumFont.font((detail.bigCompact ? 48 : 68) * scale, .medium))
            .lineLimit(1)
            .minimumScaleFactor(0.6)
          if let unit = detail.bigUnit {
            Text(unit).font(WidgetNumFont.font(24 * scale, .medium)).foregroundStyle(WidgetPalette.ink3)
          }
        }
        .foregroundStyle(accented ? WidgetPalette.ink : (detail.bigColor.map(WidgetPalette.named) ?? WidgetPalette.ink))
        if showCaption {
          Text(detail.bigCaption)
            .font(.system(size: max(9.5, 11 * scale)))
            .foregroundStyle(WidgetPalette.ink3)
            .lineLimit(1)
            .minimumScaleFactor(0.8)
        }
      }
      .frame(maxWidth: size - 2 * (3 * scale + CGFloat(detail.rings.count) * (lineWidth + gap)) - 6)
    }
    .frame(width: size, height: size)
  }
}

struct DetailHeader: View {
  let source: WidgetSource
  let detail: WidgetDetail
  var size: CGFloat = 13

  var body: some View {
    HStack(spacing: 5) {
      LogoMark(source: source, size: size).foregroundStyle(WidgetPalette.ink)
      Text(detail.title).font(.system(size: size, weight: .semibold)).lineLimit(1)
      Text(detail.plan).font(.system(size: size - 2.5, weight: .medium)).foregroundStyle(WidgetPalette.ink3).lineLimit(1)
    }
    .foregroundStyle(WidgetPalette.ink)
  }
}

struct DetailLegend: View {
  let detail: WidgetDetail
  var vertical = false
  @Environment(\.widgetRenderingMode) private var renderingMode

  var body: some View {
    let items = ForEach(detail.legend.indices, id: \.self) { index in
      let item = detail.legend[index]
      HStack(spacing: 5) {
        Circle()
          .fill(renderingMode == .accented ? Color.white.opacity(index == 0 ? 1 : 0.6) : WidgetPalette.named(item.color))
          .frame(width: 7, height: 7)
        Text(item.label).lineLimit(1)
      }
    }
    Group {
      if vertical {
        VStack(alignment: .leading, spacing: 5) { items }
      } else {
        HStack(spacing: 12) { items }
      }
    }
    .font(.system(size: 11))
    .foregroundStyle(WidgetPalette.ink2)
    .monospacedDigit()
  }
}

/// One source: the Mac detail ring instead of a lone tube in an empty row.
struct SingleSourceView: View {
  let source: WidgetSource
  let detail: WidgetDetail
  let format: WidgetFormat
  @Environment(\.widgetFamily) private var family

  var body: some View {
    let stale = format.staleLabel(minimumHours: 6)
    switch family {
    case .systemSmall:
      VStack(spacing: 6) {
        if let stale { StaleLine(text: stale) } else { DetailHeader(source: source, detail: detail, size: 12).frame(maxWidth: .infinity, alignment: .leading) }
        DetailRings(detail: detail, size: 104)
      }
      .padding(EdgeInsets(top: 14, leading: 14, bottom: 13, trailing: 14))
    case .systemLarge:
      VStack(spacing: 0) {
        HStack {
          DetailHeader(source: source, detail: detail)
          Spacer(minLength: 8)
          Text(format.updatedLabel())
            .font(.system(size: 11, weight: stale == nil ? .regular : .medium))
            .foregroundStyle(stale == nil ? WidgetPalette.ink3 : WidgetPalette.warn)
            .lineLimit(1)
        }
        Spacer(minLength: 6)
        DetailRings(detail: detail, size: 170)
        if !detail.legend.isEmpty {
          DetailLegend(detail: detail).padding(.top, 10)
        }
        SourceWhen(text: resetLine, level: format.resetLevel(source), size: 11).padding(.top, 4)
        Spacer(minLength: 8)
        MonthCard(snapshot: format.snapshot, format: format)
      }
      .padding(EdgeInsets(top: 16, leading: 14, bottom: 14, trailing: 14))
    default:
      HStack(spacing: 16) {
        DetailRings(detail: detail, size: 124, showCaption: false)
        VStack(alignment: .leading, spacing: 0) {
          if let stale { StaleLine(text: stale).padding(.bottom, 4) }
          DetailHeader(source: source, detail: detail)
          Text(detail.bigCaption)
            .font(.system(size: 11)).foregroundStyle(WidgetPalette.ink3).lineLimit(1)
            .padding(.top, 3)
          Spacer(minLength: 6)
          if !detail.legend.isEmpty { DetailLegend(detail: detail, vertical: true) }
          Spacer(minLength: 6)
          SourceWhen(text: resetLine, level: format.resetLevel(source), size: 11)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
      }
      .padding(EdgeInsets(top: 16, leading: 16, bottom: 16, trailing: 16))
    }
  }

  /// "1天5时后重置" from the live countdown, falling back to the panel's own text.
  private var resetLine: String {
    source.resetsAtMs == nil ? source.when : format.s("resetsIn", ["duration": format.when(source)])
  }
}
