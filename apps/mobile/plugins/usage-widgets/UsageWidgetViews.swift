import SwiftUI
import WidgetKit

/// How a day's value is split: by model when the computer sends a model series (busiest
/// first, the rest last), otherwise by harness like the Mac chart (Codex, Claude Code, Pi).
struct UsageBreakdown {
  enum Metric { case money, tokens }

  /// Series keys in stacking order, bottom to top.
  let keys: [Int]
  let metric: Metric
  private let models: [WidgetModel]?
  private let locale: Locale

  init(snapshot: WidgetSnapshot?, locale: Locale, metric: Metric) {
    self.locale = locale
    self.metric = metric
    if let models = snapshot?.usage.models, !models.isEmpty,
       snapshot?.usage.daily.allSatisfy({ $0.models?.count == models.count + 1 && $0.modelTokens?.count == models.count + 1 }) == true {
      self.models = models
      keys = Array(0...models.count)
    } else {
      self.models = nil
      keys = [1, 0, 2]
    }
  }

  func value(_ day: WidgetDay, _ key: Int) -> Double {
    switch (models != nil, metric) {
    case (true, .money): return day.models?[key] ?? 0
    case (true, .tokens): return day.modelTokens?[key] ?? 0
    case (false, .money): return day.money[key]
    case (false, .tokens): return day.tokens[key]
    }
  }

  func total(_ day: WidgetDay) -> Double {
    metric == .money ? day.total : day.totalTokens
  }

  func amount(_ value: Double, format: WidgetFormat) -> String {
    metric == .money ? format.money(value) : format.tokens(value)
  }

  func label(_ key: Int, format: WidgetFormat) -> String {
    guard let models else { return format.s("harness.\(["claude-code", "codex", "pi"][key])") }
    return key < models.count ? models[key].name : WidgetText.text("other", locale: locale)
  }

  func color(_ key: Int, accented: Bool) -> Color {
    guard let models else {
      return accented ? Color.white.opacity(WidgetPalette.accentedOpacity(key)) : WidgetPalette.harness(key)
    }
    let isOther = key >= models.count
    if accented { return Color.white.opacity(isOther ? 0.2 : [1, 0.75, 0.56, 0.42, 0.32][min(key, 4)]) }
    return isOther ? WidgetPalette.otherModel : WidgetPalette.model(key)
  }

  /// Non-zero parts of `total(key)`, largest first; beyond `limit` the smallest merge into one
  /// "other" row (key -1).
  func ranked(limit: Int, total: (Int) -> Double) -> [(key: Int, value: Double)] {
    let rows = keys.map { (key: $0, value: total($0)) }.filter { $0.value > 0 }.sorted { $0.value > $1.value }
    guard rows.count > limit else { return rows }
    let kept = rows.prefix(limit - 1)
    return Array(kept) + [(key: -1, value: rows.dropFirst(limit - 1).reduce(0) { $0 + $1.value })]
  }

  func rowLabel(_ key: Int, format: WidgetFormat) -> String {
    key < 0 ? WidgetText.text("other", locale: locale) : label(key, format: format)
  }

  func rowColor(_ key: Int, accented: Bool) -> Color {
    key < 0 ? (accented ? Color.white.opacity(0.2) : WidgetPalette.otherModel) : color(key, accented: accented)
  }
}

/// Monotone cubic through the points (no overshoot), like Swift Charts' `.monotone`.
func monotonePath(_ points: [CGPoint], into path: inout Path, move: Bool) {
  let n = points.count
  guard n > 1 else { return }
  var dx = [CGFloat](repeating: 0, count: n - 1), m = dx
  for i in 0..<(n - 1) {
    dx[i] = points[i + 1].x - points[i].x
    m[i] = dx[i] == 0 ? 0 : (points[i + 1].y - points[i].y) / dx[i]
  }
  var t = [CGFloat](repeating: 0, count: n)
  t[0] = m[0]; t[n - 1] = m[n - 2]
  if n > 2 { for i in 1..<(n - 1) { t[i] = m[i - 1] * m[i] <= 0 ? 0 : (m[i - 1] + m[i]) / 2 } }
  for i in 0..<(n - 1) {
    if m[i] == 0 { t[i] = 0; t[i + 1] = 0; continue }
    let a = t[i] / m[i], b = t[i + 1] / m[i], s = a * a + b * b
    if s > 9 { let k = 3 / s.squareRoot(); t[i] = k * a * m[i]; t[i + 1] = k * b * m[i] }
  }
  if move { path.move(to: points[0]) } else { path.addLine(to: points[0]) }
  for i in 0..<(n - 1) {
    let h = dx[i] / 3
    path.addCurve(to: points[i + 1],
                  control1: CGPoint(x: points[i].x + h, y: points[i].y + h * t[i]),
                  control2: CGPoint(x: points[i + 1].x - h, y: points[i + 1].y - h * t[i + 1]))
  }
}

/// The month card's stacked area with the total line.
struct StackedAreaChart: View {
  let daily: [WidgetDay]
  let breakdown: UsageBreakdown
  @Environment(\.widgetRenderingMode) private var renderingMode

  var body: some View {
    GeometryReader { geometry in
      let size = geometry.size
      let n = daily.count
      if n > 1 {
        let layers = cumulative()
        let maxTotal = max(layers.last?.max() ?? 0, 0.0001) * 1.08
        let point = { (layer: [Double], i: Int) in
          CGPoint(x: CGFloat(i) / CGFloat(n - 1) * size.width, y: size.height - CGFloat(layer[i] / maxTotal) * size.height)
        }
        ZStack {
          ForEach(breakdown.keys.indices, id: \.self) { k in
            Path { path in
              monotonePath((0..<n).map { point(layers[k + 1], $0) }, into: &path, move: true)
              monotonePath((0..<n).reversed().map { point(layers[k], $0) }, into: &path, move: false)
              path.closeSubpath()
            }
            .fill(fill(breakdown.keys[k]))
          }
          Path { path in monotonePath((0..<n).map { point(layers[breakdown.keys.count], $0) }, into: &path, move: true) }
            .stroke(WidgetPalette.ink.opacity(0.55), lineWidth: 1)
        }
      }
    }
  }

  private func fill(_ key: Int) -> LinearGradient {
    let color = breakdown.color(key, accented: renderingMode == .accented)
    return LinearGradient(colors: [color.opacity(0.95), color.opacity(0.55)], startPoint: .top, endPoint: .bottom)
  }

  private func cumulative() -> [[Double]] {
    var layers: [[Double]] = [Array(repeating: 0, count: daily.count)]
    for key in breakdown.keys {
      let previous = layers.last!
      layers.append(daily.indices.map { previous[$0] + breakdown.value(daily[$0], key) })
    }
    return layers
  }
}

/// Daily stacked bars: today solid, earlier days at 60% (the usage-history emphasis rule).
struct DailyBars: View {
  let daily: [WidgetDay]
  let gap: CGFloat
  let breakdown: UsageBreakdown
  var average: Double? = nil
  @Environment(\.widgetRenderingMode) private var renderingMode

  var body: some View {
    GeometryReader { geometry in
      let size = geometry.size
      let n = max(daily.count, 1)
      let barWidth = max(1, (size.width - gap * CGFloat(n - 1)) / CGFloat(n))
      let maxTotal = max(daily.map { breakdown.total($0) }.max() ?? 0, average ?? 0, 0.0001) * 1.08
      let accented = renderingMode == .accented
      ZStack(alignment: .topLeading) {
        ForEach(daily.indices, id: \.self) { i in
          let day = daily[i]
          let x = CGFloat(i) * (barWidth + gap)
          let today = i == daily.count - 1
          let dayTotal = breakdown.total(day)
          if dayTotal <= 0 {
            RoundedRectangle(cornerRadius: 1).fill(WidgetPalette.ink4)
              .frame(width: barWidth, height: 2)
              .offset(x: x, y: size.height - 2)
          } else {
            let height = max(3, CGFloat(dayTotal / maxTotal) * size.height)
            VStack(spacing: 0) {
              ForEach(breakdown.keys.reversed(), id: \.self) { key in
                let value = breakdown.value(day, key)
                if value > 0 {
                  Rectangle()
                    .fill(breakdown.color(key, accented: accented))
                    .frame(height: CGFloat(value / dayTotal) * height)
                }
              }
            }
            .frame(width: barWidth, height: height)
            .clipShape(UnevenRoundedRectangle(topLeadingRadius: min(2, barWidth / 2), topTrailingRadius: min(2, barWidth / 2)))
            .opacity(today ? 1 : 0.6)
            .widgetAccentable(today)
            .offset(x: x, y: size.height - height)
          }
        }
        if let average, average > 0 {
          let y = size.height - CGFloat(average / maxTotal) * size.height
          Path { path in
            path.move(to: CGPoint(x: 0, y: y))
            path.addLine(to: CGPoint(x: size.width, y: y))
          }
          .stroke(WidgetPalette.ink2, style: StrokeStyle(lineWidth: 1, dash: [2, 3]))
        }
      }
    }
  }
}

struct AverageLegend: View {
  let text: String
  var body: some View {
    HStack(spacing: 4) {
      Path { path in
        path.move(to: CGPoint(x: 0, y: 0.5))
        path.addLine(to: CGPoint(x: 12, y: 0.5))
      }
      .stroke(WidgetPalette.ink2, style: StrokeStyle(lineWidth: 1, dash: [2, 2]))
      .frame(width: 12, height: 1)
      Text(text).font(.system(size: 10)).foregroundStyle(WidgetPalette.ink3).lineLimit(1)
    }
    .frame(maxWidth: .infinity, alignment: .trailing)
  }
}

/// Today's tokens as the headline: Barlow digits with a quiet "token" unit.
struct TokenFigure: View {
  let tokens: Double
  let size: CGFloat
  let format: WidgetFormat

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: 3) {
      Text(format.tokens(tokens)).font(WidgetNumFont.font(size))
      Text(format.s("tokenUnit")).font(.system(size: (size * 0.34).rounded(), weight: .medium)).foregroundStyle(WidgetPalette.ink3)
    }
    .foregroundStyle(tokens > 0 ? WidgetPalette.ink : WidgetPalette.ink3)
    .lineLimit(1)
    .minimumScaleFactor(0.6)
  }
}

struct BreakdownDot: View {
  let color: Color
  var body: some View { Circle().fill(color).frame(width: 6, height: 6) }
}

struct UsageWidgetView: View {
  let state: WidgetState
  let now: Date
  @Environment(\.widgetFamily) private var family
  @Environment(\.widgetRenderingMode) private var renderingMode

  var body: some View {
    switch state {
    case .updateDesktop:
      EmptyStateView(title: WidgetText.text("updateTitle"), body_: WidgetText.text("updateBody")).padding(16)
    case .empty:
      EmptyStateView(title: WidgetText.text("emptyUsageTitle"), body_: WidgetText.text("emptyUsageBody")).padding(16)
    case .snapshot(_, _, let snapshot):
      if snapshot.usage.daily.isEmpty || snapshot.usage.days.isEmpty {
        let locale = Locale(identifier: snapshot.locale)
        EmptyStateView(title: WidgetText.text("emptyUsageTitle", locale: locale), body_: WidgetText.text("emptyUsageBody", locale: locale)).padding(16)
      } else {
        let format = WidgetFormat(snapshot: snapshot, now: now)
        content(snapshot, format: format, breakdown: UsageBreakdown(snapshot: snapshot, locale: format.locale, metric: .tokens))
      }
    }
  }

  @ViewBuilder
  private func content(_ snapshot: WidgetSnapshot, format: WidgetFormat, breakdown: UsageBreakdown) -> some View {
    let daily = snapshot.usage.daily
    let days = snapshot.usage.days
    let today = daily[daily.count - 1]
    let average = daily.reduce(0) { $0 + $1.totalTokens } / Double(daily.count)
    // A snapshot that outlived its day shows its real date, never "today".
    let isCurrent = format.isToday(days[days.count - 1])
    let todayLabel = isCurrent ? format.s("today") : format.monthDay(days[days.count - 1])
    let accented = renderingMode == .accented
    let averageLabel = "\(format.s("dailyAverage")) \(format.tokens(average)) \(format.s("tokenUnit"))"
    let todayValue = "\(WidgetText.text("valueBasis", locale: format.locale)) \(format.money(today.total))"
    switch family {
    case .systemSmall:
      VStack(alignment: .leading, spacing: 0) {
        HStack {
          Text(todayLabel)
          Spacer(minLength: 4)
          if isCurrent { Text(format.monthDay(days[days.count - 1])) }
        }
        .font(.system(size: 11)).foregroundStyle(WidgetPalette.ink3)
        TokenFigure(tokens: today.totalTokens, size: 38, format: format)
          .padding(.top, 4)
        Text(today.totalTokens > 0 || !isCurrent ? todayValue : WidgetText.text("todayNone", locale: format.locale))
          .font(.system(size: 11)).foregroundStyle(WidgetPalette.ink3).lineLimit(1)
        Spacer(minLength: 0)
        let week = Array(daily.suffix(7)), weekDays = Array(days.suffix(7))
        DailyBars(daily: week, gap: 8, breakdown: breakdown).frame(height: 36)
        HStack(spacing: 8) {
          ForEach(weekDays.indices, id: \.self) { i in
            Text(format.weekdayNarrow(weekDays[i]))
              .font(.system(size: 9.5, weight: i == weekDays.count - 1 ? .semibold : .regular))
              .foregroundStyle(i == weekDays.count - 1 ? WidgetPalette.ink : WidgetPalette.ink3)
              .frame(maxWidth: .infinity)
          }
        }
        .padding(.top, 4)
      }
      .padding(EdgeInsets(top: 15, leading: 16, bottom: 12, trailing: 16))
    case .systemLarge:
      let total = daily.reduce(0) { $0 + $1.total }
      let paid = daily.reduce(0) { $0 + $1.paid }
      let tokens = daily.reduce(0) { $0 + $1.totalTokens }
      let lastDay = days[days.count - 1]
      VStack(alignment: .leading, spacing: 0) {
        HStack {
          Text(isCurrent ? "\(todayLabel) · \(format.monthDay(lastDay)) \(format.weekday(lastDay))" : "\(todayLabel) \(format.weekday(lastDay))")
          Spacer(minLength: 4)
          Text(format.s(snapshot.usage.scope == "local" ? "scopeLocal" : "scopeAll"))
        }
        .font(.system(size: 11)).foregroundStyle(WidgetPalette.ink3).lineLimit(1)
        TokenFigure(tokens: today.totalTokens, size: 46, format: format).padding(.top, 5)
        Text("\(WidgetText.text("valueBasisLong", locale: format.locale)) \(format.money(today.total))")
          .font(.system(size: 11)).foregroundStyle(WidgetPalette.ink3).padding(.top, 3)
        Spacer(minLength: 6)
        AverageLegend(text: averageLabel).padding(.bottom, 5)
        DailyBars(daily: daily, gap: 3, breakdown: breakdown, average: average).frame(height: 100)
        HStack {
          Text(format.monthDay(days[0]))
          Spacer()
          Text(todayLabel)
        }
        .font(.system(size: 10)).foregroundStyle(WidgetPalette.ink3).padding(.top, 4)
        Rectangle().fill(WidgetPalette.line).frame(height: 0.5).padding(.top, 10).padding(.bottom, 9)
        HStack(alignment: .firstTextBaseline, spacing: 6) {
          Text(format.s(snapshot.usage.scope == "local" ? "monthScopeLocal" : "monthScopeAll").components(separatedBy: " · ").first ?? "")
            .font(.system(size: 11)).foregroundStyle(WidgetPalette.ink3)
          Text(format.tokens(tokens)).font(WidgetNumFont.font(18)).foregroundStyle(WidgetPalette.ink)
          Text(format.s("tokenUnit")).font(.system(size: 11)).foregroundStyle(WidgetPalette.ink3)
          Spacer(minLength: 4)
          Text("\(WidgetText.text("valueBasis", locale: format.locale)) \(format.money(total)) · \(format.s("paid")) \(format.money(paid))")
            .font(.system(size: 11)).foregroundStyle(WidgetPalette.ink3).lineLimit(1)
        }
        BreakdownSplit(rows: breakdown.ranked(limit: 4) { key in daily.reduce(0) { $0 + breakdown.value($1, key) } },
                       total: tokens, breakdown: breakdown, format: format)
          .padding(.top, 8)
      }
      .padding(EdgeInsets(top: 16, leading: 16, bottom: 14, trailing: 16))
    default:
      VStack(spacing: 0) {
        HStack(alignment: .top, spacing: 14) {
          VStack(alignment: .leading, spacing: 0) {
            Text(todayLabel)
              .font(.system(size: 11)).foregroundStyle(WidgetPalette.ink3).lineLimit(1)
            TokenFigure(tokens: today.totalTokens, size: 36, format: format).padding(.top, 4)
            Text(todayValue)
              .font(.system(size: 11)).foregroundStyle(WidgetPalette.ink3).lineLimit(1)
            Spacer(minLength: 0)
            VStack(alignment: .leading, spacing: 4) {
              ForEach(breakdown.ranked(limit: 3) { breakdown.value(today, $0) }, id: \.key) { row in
                HStack(spacing: 5) {
                  BreakdownDot(color: breakdown.rowColor(row.key, accented: accented))
                  Text(breakdown.rowLabel(row.key, format: format)).font(.system(size: 10.5)).foregroundStyle(WidgetPalette.ink2)
                    .lineLimit(1).truncationMode(.tail)
                  Spacer(minLength: 2)
                  Text(breakdown.amount(row.value, format: format)).font(WidgetNumFont.font(14)).foregroundStyle(WidgetPalette.ink)
                    .fixedSize()
                }
              }
            }
          }
          .frame(width: 124)
          VStack(spacing: 0) {
            Spacer(minLength: 0)
            AverageLegend(text: averageLabel).padding(.bottom, 5)
            DailyBars(daily: Array(daily.suffix(14)), gap: 4, breakdown: breakdown, average: average).frame(height: 80)
            HStack {
              Text(format.monthDay(days[max(0, days.count - 14)]))
              Spacer()
              Text(todayLabel)
            }
            .font(.system(size: 10)).foregroundStyle(WidgetPalette.ink3).padding(.top, 4)
          }
        }
      }
      .padding(EdgeInsets(top: 15, leading: 16, bottom: 12, trailing: 16))
    }
  }
}

/// One thin bar, then the parts in two columns: dot, name and share, amount on the right.
struct BreakdownSplit: View {
  let rows: [(key: Int, value: Double)]
  let total: Double
  let breakdown: UsageBreakdown
  let format: WidgetFormat
  @Environment(\.widgetRenderingMode) private var renderingMode

  var body: some View {
    let accented = renderingMode == .accented
    let sum = max(total, 0.0001)
    VStack(alignment: .leading, spacing: 8) {
      GeometryReader { geometry in
        let available = geometry.size.width - CGFloat(max(0, rows.count - 1)) * 2
        HStack(spacing: 2) {
          ForEach(rows, id: \.key) { row in
            Capsule()
              .fill(breakdown.rowColor(row.key, accented: accented))
              .frame(width: max(6, CGFloat(row.value / sum) * available))
          }
        }
      }
      .frame(height: 4)
      LazyVGrid(columns: [GridItem(.flexible(), spacing: 14), GridItem(.flexible(), spacing: 14)], alignment: .leading, spacing: 5) {
        ForEach(rows, id: \.key) { row in
          HStack(spacing: 5) {
            BreakdownDot(color: breakdown.rowColor(row.key, accented: accented))
            Text(breakdown.rowLabel(row.key, format: format)).foregroundStyle(WidgetPalette.ink2).lineLimit(1).truncationMode(.tail)
            Text("\(Int((row.value / sum * 100).rounded()))%").foregroundStyle(WidgetPalette.ink3).fixedSize()
            Spacer(minLength: 2)
            Text(breakdown.amount(row.value, format: format)).font(WidgetNumFont.font(14)).foregroundStyle(WidgetPalette.ink).fixedSize()
          }
          .font(.system(size: 10.5))
        }
      }
    }
  }
}
