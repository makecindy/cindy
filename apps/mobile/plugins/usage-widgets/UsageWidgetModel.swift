import Foundation

// Mirrors `UsageWidgetState` / `MobileUsageWidgetSnapshot` in the app (TypeScript). The app
// writes it into the shared App Group; this extension only reads and renders.

struct WidgetSource: Decodable, Identifiable {
  let id: String
  let kind: String
  let name: String
  let logo: String?
  let monogram: String
  let value: String?
  let unit: String?
  let label: String?
  let level: String
  let fill: Double
  let reserve: Bool
  let emphasized: Bool
  let when: String
  let resetsAtMs: Double?
  /// Last reading of a computer that is offline now; drawn faded, `when` says its age.
  var stale: Bool? = nil
  /// Will reset with quota unused at the current pace; the reset time colors as it nears.
  var unusedAtReset: Bool? = nil
  /// The panel's detail ring; drawn when the widget shows a single source.
  var detail: WidgetDetail? = nil
}

struct WidgetRing: Decodable {
  let fraction: Double
  let color: String
}

struct WidgetLegend: Decodable {
  let label: String
  let color: String
}

struct WidgetDetail: Decodable {
  let title: String
  let plan: String
  let rings: [WidgetRing]
  let bigValue: String
  let bigUnit: String?
  let bigColor: String?
  let bigCompact: Bool
  let bigCaption: String
  let legend: [WidgetLegend]
}

struct WidgetDay: Decodable {
  let money: [Double]
  let paid: Double
  let tokens: [Double]
  /// Value per `WidgetUsage.models` entry, then everything else.
  var models: [Double]? = nil
  /// Tokens per `WidgetUsage.models` entry, then everything else.
  var modelTokens: [Double]? = nil

  var total: Double { money.reduce(0, +) }
  var totalTokens: Double { tokens.reduce(0, +) }
}

struct WidgetModel: Decodable {
  let name: String
  let harness: String
}

struct WidgetUsage: Decodable {
  let scope: String
  let days: [String]
  let daily: [WidgetDay]
  /// Busiest models of the window, in color order; absent from older computers.
  var models: [WidgetModel]? = nil
}

struct WidgetSnapshot: Decodable {
  let version: Int
  let generatedAtMs: Double
  let updatedAtMs: Double?
  let locale: String
  let moneySymbol: String
  let sources: [WidgetSource]
  let usage: WidgetUsage
  let strings: [String: String]
}

enum WidgetState: Decodable {
  case snapshot(receivedAtMs: Double, deviceName: String, snapshot: WidgetSnapshot)
  case updateDesktop
  case empty

  private enum Keys: String, CodingKey { case kind, receivedAtMs, deviceName, snapshot }

  init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: Keys.self)
    switch try container.decode(String.self, forKey: .kind) {
    case "snapshot":
      self = .snapshot(
        receivedAtMs: try container.decode(Double.self, forKey: .receivedAtMs),
        deviceName: try container.decode(String.self, forKey: .deviceName),
        snapshot: try container.decode(WidgetSnapshot.self, forKey: .snapshot)
      )
    case "update-desktop":
      self = .updateDesktop
    default:
      self = .empty
    }
  }

  /// The state of the computer a widget is set to; nil or "auto" follows the app's choice.
  static func load(computer: String?) -> WidgetState {
    guard let store = WidgetStore.load() else { return .empty }
    let id = computer == nil || computer == ComputerEntity.autoID ? store.autoDeviceId : computer
    return id.flatMap { store.states[$0] } ?? .empty
  }

  var snapshot: WidgetSnapshot? {
    if case .snapshot(_, _, let snapshot) = self { return snapshot }
    return nil
  }
}

/// `UsageWidgetStore` in the app: every computer's latest state and the automatic choice.
struct WidgetStore: Decodable {
  struct Computer: Decodable {
    let id: String
    let name: String
  }

  let autoDeviceId: String?
  let computers: [Computer]
  let states: [String: WidgetState]

  static var group: String? {
    Bundle.main.object(forInfoDictionaryKey: "CindyAppGroupId") as? String
  }

  /// Same file name as `CindyUsageWidgetsModule` in the app.
  static func load() -> WidgetStore? {
    guard let group, let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group),
          let data = try? Data(contentsOf: container.appendingPathComponent("usage-widget-snapshot.json"))
    else { return nil }
    return try? JSONDecoder().decode(WidgetStore.self, from: data)
  }

  /// Tells the app this computer has a widget, so it asks it on each refresh
  /// (`readPinnedDeviceIds` in `CindyUsageWidgetsModule`).
  static func recordPin(_ id: String) {
    guard let group, let defaults = UserDefaults(suiteName: group) else { return }
    let now = Date().timeIntervalSince1970
    var pins = (defaults.dictionary(forKey: "usageWidgetPins") as? [String: Double] ?? [:])
      .filter { now - $0.value < 2 * 24 * 3600 }
    pins[id] = now
    defaults.set(pins, forKey: "usageWidgetPins")
  }
}

/// Formatting shared by both widgets. Templates come from the computer's menu bar strings;
/// the few widget-only sentences live in `WidgetText`.
struct WidgetFormat {
  let snapshot: WidgetSnapshot?
  let now: Date

  var locale: Locale { Locale(identifier: snapshot?.locale ?? Locale.preferredLanguages.first ?? "en") }

  func s(_ key: String, _ values: [String: String] = [:]) -> String {
    var text = snapshot?.strings[key] ?? WidgetText.fallback(key, locale: locale)
    for (name, value) in values { text = text.replacingOccurrences(of: "{{\(name)}}", with: value) }
    return text
  }

  func money(_ value: Double) -> String {
    let symbol = snapshot?.moneySymbol ?? "$"
    if value >= 10_000 { return symbol + String(format: "%.1fk", value / 1000) }
    if value >= 100 {
      let formatter = NumberFormatter()
      formatter.numberStyle = .decimal
      formatter.locale = Locale(identifier: "en_US")
      formatter.maximumFractionDigits = 0
      return symbol + (formatter.string(from: NSNumber(value: value.rounded())) ?? String(Int(value)))
    }
    return symbol + String(format: "%.2f", value)
  }

  func tokens(_ value: Double) -> String {
    let millions = value / 1_000_000
    if millions >= 1000 { return String(format: "%.1fB", millions / 1000) }
    if millions >= 1 { return "\(Int(millions.rounded()))M" }
    if value >= 1000 { return "\(Int((value / 1000).rounded()))K" }
    return "\(Int(max(0, value).rounded()))"
  }

  /// "5天9时" from the reset time, so the countdown stays right between refreshes.
  /// `coarse` keeps only the largest unit for the narrow small widget.
  func when(_ source: WidgetSource, coarse: Bool = false) -> String {
    guard let resetsAtMs = source.resetsAtMs else { return source.when }
    let ms = resetsAtMs - now.timeIntervalSince1970 * 1000
    if ms <= 0 { return WidgetText.text("reset", locale: locale) }
    let minutes = max(1, Int(ms / 60_000))
    let d = minutes / 1440, h = (minutes % 1440) / 60, m = minutes % 60
    if d > 0 { return h > 0 && !coarse ? s("durationShort.daysHours", ["d": "\(d)", "h": "\(h)"]) : s("durationShort.days", ["d": "\(d)"]) }
    if h > 0 { return m > 0 && !coarse ? s("durationShort.hoursMinutes", ["h": "\(h)", "m": "\(m)"]) : s("durationShort.hours", ["h": "\(h)"]) }
    return s("durationShort.minutes", ["m": "\(m)"])
  }

  /// Reset-time color (`resetTimeLevel` in `@cindy/maker-shared/quota-level`): only for quota that
  /// will go unused, a day or less to go is yellow, six hours or less red. Counted from now, so a
  /// widget that has not been refreshed still turns red on time.
  func resetLevel(_ source: WidgetSource) -> String {
    guard source.unusedAtReset == true, let resetsAtMs = source.resetsAtMs else { return "normal" }
    let leftHours = (resetsAtMs - now.timeIntervalSince1970 * 1000) / 3_600_000
    if leftHours <= 0 { return "normal" }
    if leftHours <= 6 { return "error" }
    if leftHours <= 24 { return "warn" }
    return "normal"
  }

  /// Age of the quota readings; nil when fresh enough not to mention.
  func staleLabel(minimumHours: Double) -> String? {
    guard let updated = snapshot?.updatedAtMs ?? snapshot?.generatedAtMs else { return nil }
    let seconds = max(0, now.timeIntervalSince1970 - updated / 1000)
    guard seconds >= minimumHours * 3600 else { return nil }
    return updatedLabel(seconds)
  }

  func updatedLabel() -> String {
    guard let updated = snapshot?.updatedAtMs ?? snapshot?.generatedAtMs else { return "" }
    return updatedLabel(max(0, now.timeIntervalSince1970 - updated / 1000))
  }

  private func updatedLabel(_ seconds: Double) -> String {
    if seconds < 60 { return s("updatedJustNow") }
    if seconds < 3600 { return s("updatedMinutes", ["n": "\(Int(seconds / 60))"]) }
    if seconds < 86400 { return s("updatedHours", ["n": "\(Int(seconds / 3600))"]) }
    return s("updatedDays", ["n": "\(Int(seconds / 86400))"])
  }

  func date(_ iso: String) -> Date {
    let parts = iso.split(separator: "-").compactMap { Int($0) }
    var components = DateComponents()
    if parts.count == 3 { components.year = parts[0]; components.month = parts[1]; components.day = parts[2]; components.hour = 12 }
    return Calendar.current.date(from: components) ?? now
  }

  func isToday(_ iso: String) -> Bool {
    Calendar.current.isDate(date(iso), inSameDayAs: now)
  }

  func monthDay(_ iso: String) -> String {
    let formatter = DateFormatter()
    formatter.locale = locale
    formatter.setLocalizedDateFormatFromTemplate("MMMd")
    return formatter.string(from: date(iso))
  }

  func weekdayNarrow(_ iso: String) -> String {
    let formatter = DateFormatter()
    formatter.locale = locale
    formatter.setLocalizedDateFormatFromTemplate("EEEEE")
    return formatter.string(from: date(iso))
  }

  func weekday(_ iso: String) -> String {
    let formatter = DateFormatter()
    formatter.locale = locale
    formatter.setLocalizedDateFormatFromTemplate("EEE")
    return formatter.string(from: date(iso))
  }
}

/// Sentences the computer does not send: empty states and the widget gallery.
enum WidgetText {
  private static let table: [String: [String: String]] = [
    "zh-Hans": [
      "quotaName": "订阅余量", "quotaDescription": "每个订阅还剩多少、什么时候回满。",
      "usageName": "每日用量", "usageDescription": "今天用了多少，和最近每天的走势。",
      "emptyTitle": "还没读到余量", "emptyBody": "打开 Cindy 连上一台电脑，这里就会显示每个订阅还剩多少、什么时候回满。",
      "emptyUsageTitle": "还没读到用量", "emptyUsageBody": "打开 Cindy 连上一台电脑，这里就会显示每天的用量。",
      "updateTitle": "电脑上的 Cindy 需要更新", "updateBody": "更新后这里会显示余量和每天的用量。",
      "noSources": "还没有带余量的账号", "valueBasis": "订阅等值", "valueBasisLong": "订阅等值估算", "reset": "已重置",
      "todayNone": "今天还没有用量", "resetsIn": "{{duration}}后重置", "other": "其他",
    ],
    "zh-Hant": [
      "quotaName": "訂閱餘量", "quotaDescription": "每個訂閱還剩多少、什麼時候回滿。",
      "usageName": "每日用量", "usageDescription": "今天用了多少，和最近每天的走勢。",
      "emptyTitle": "還沒讀到餘量", "emptyBody": "打開 Cindy 連上一台電腦，這裡就會顯示每個訂閱還剩多少、什麼時候回滿。",
      "emptyUsageTitle": "還沒讀到用量", "emptyUsageBody": "打開 Cindy 連上一台電腦，這裡就會顯示每天的用量。",
      "updateTitle": "電腦上的 Cindy 需要更新", "updateBody": "更新後這裡會顯示餘量和每天的用量。",
      "noSources": "還沒有帶餘量的帳號", "valueBasis": "訂閱等值", "valueBasisLong": "訂閱等值估算", "reset": "已重置",
      "todayNone": "今天還沒有用量", "resetsIn": "{{duration}}後重置", "other": "其他",
    ],
    "ja": [
      "quotaName": "サブスクの残り", "quotaDescription": "各サブスクリプションの残りと、いつ満タンに戻るか。",
      "usageName": "毎日の使用量", "usageDescription": "今日の使用量と、最近の日ごとの推移。",
      "emptyTitle": "残りをまだ取得できていません", "emptyBody": "Cindy を開いてコンピュータに接続すると、各サブスクリプションの残りがここに表示されます。",
      "emptyUsageTitle": "使用量をまだ取得できていません", "emptyUsageBody": "Cindy を開いてコンピュータに接続すると、毎日の使用量がここに表示されます。",
      "updateTitle": "コンピュータの Cindy を更新してください", "updateBody": "更新すると、残りと毎日の使用量がここに表示されます。",
      "noSources": "残量を表示できるアカウントがまだありません", "valueBasis": "サブスク換算", "valueBasisLong": "サブスク換算（見積もり）",
      "reset": "リセット済み", "todayNone": "今日の使用量はまだありません", "resetsIn": "{{duration}}後にリセット", "other": "その他",
      "today": "今日", "dailyAverage": "1 日平均", "paid": "支払額", "tokenUnit": "token",
      "monthScopeAll": "直近 30 日 · すべてのデバイス", "monthScopeLocal": "直近 30 日 · このコンピュータ",
      "scopeAll": "すべてのデバイス", "scopeLocal": "このコンピュータ",
      "harness.claude-code": "Claude Code", "harness.codex": "Codex", "harness.pi": "Pi",
      "updatedJustNow": "たった今更新", "updatedMinutes": "{{n}} 分前に更新", "updatedHours": "{{n}} 時間前に更新",
      "updatedDays": "{{n}} 日前に更新",
      "durationShort.daysHours": "{{d}}日{{h}}時間", "durationShort.days": "{{d}}日", "durationShort.hoursMinutes": "{{h}}時間{{m}}分",
      "durationShort.hours": "{{h}}時間", "durationShort.minutes": "{{m}}分",
    ],
    "ko": [
      "quotaName": "구독 남은 양", "quotaDescription": "구독마다 얼마나 남았는지, 언제 다시 채워지는지.",
      "usageName": "일일 사용량", "usageDescription": "오늘 사용량과 최근 며칠의 추이.",
      "emptyTitle": "아직 남은 양을 읽지 못했어요", "emptyBody": "Cindy를 열고 컴퓨터에 연결하면 구독마다 얼마나 남았는지 여기에 표시돼요.",
      "emptyUsageTitle": "아직 사용량을 읽지 못했어요", "emptyUsageBody": "Cindy를 열고 컴퓨터에 연결하면 일일 사용량이 여기에 표시돼요.",
      "updateTitle": "컴퓨터의 Cindy를 업데이트해 주세요", "updateBody": "업데이트하면 남은 양과 일일 사용량이 여기에 표시돼요.",
      "noSources": "남은 양을 보여 줄 계정이 아직 없어요", "valueBasis": "구독 환산", "valueBasisLong": "구독 환산 추정",
      "reset": "초기화됨", "todayNone": "오늘 사용량이 아직 없어요", "resetsIn": "{{duration}} 후 초기화", "other": "기타",
      "today": "오늘", "dailyAverage": "하루 평균", "paid": "실제 결제", "tokenUnit": "token",
      "monthScopeAll": "최근 30일 · 모든 기기", "monthScopeLocal": "최근 30일 · 이 컴퓨터",
      "scopeAll": "모든 기기", "scopeLocal": "이 컴퓨터",
      "harness.claude-code": "Claude Code", "harness.codex": "Codex", "harness.pi": "Pi",
      "updatedJustNow": "방금 업데이트", "updatedMinutes": "{{n}}분 전 업데이트", "updatedHours": "{{n}}시간 전 업데이트",
      "updatedDays": "{{n}}일 전 업데이트",
      "durationShort.daysHours": "{{d}}일 {{h}}시간", "durationShort.days": "{{d}}일", "durationShort.hoursMinutes": "{{h}}시간 {{m}}분",
      "durationShort.hours": "{{h}}시간", "durationShort.minutes": "{{m}}분",
    ],
    "de": [
      "quotaName": "Abo-Kontingent",
      "quotaDescription": "Wie viel jedes Abo noch hat und wann es sich wieder auffüllt.",
      "usageName": "Tägliche Nutzung",
      "usageDescription": "Die heutige Nutzung und der Verlauf der letzten Tage.",
      "emptyTitle": "Kontingent noch nicht abgerufen",
      "emptyBody": "Öffne Cindy und verbinde einen Computer, dann siehst du hier, wie viel jedes Abo noch hat.",
      "emptyUsageTitle": "Nutzung noch nicht abgerufen",
      "emptyUsageBody": "Öffne Cindy und verbinde einen Computer, dann siehst du hier deine tägliche Nutzung.",
      "updateTitle": "Aktualisiere Cindy auf deinem Computer",
      "updateBody": "Nach dem Update erscheinen hier Kontingent und tägliche Nutzung.",
      "noSources": "Noch nichts mit Kontingent vorhanden",
      "valueBasis": "Abonnementwert",
      "valueBasisLong": "Abonnementwert (geschätzt)",
      "reset": "Zurückgesetzt",
      "todayNone": "Heute noch keine Nutzung",
      "resetsIn": "Zurücksetzung in {{duration}}",
      "other": "Sonstige",
      "today": "Heute",
      "dailyAverage": "Tagesdurchschnitt",
      "paid": "Bezahlt",
      "monthScopeAll": "Letzte 30 Tage · Alle Geräte",
      "monthScopeLocal": "Letzte 30 Tage · Dieser Computer",
      "scopeAll": "Alle Geräte",
      "scopeLocal": "Dieser Computer",
      "updatedJustNow": "Gerade aktualisiert",
      "updatedMinutes": "Vor {{n}} Min. aktualisiert",
      "updatedHours": "Vor {{n}} Std. aktualisiert",
      "updatedDays": "Vor {{n}} Tagen aktualisiert",
      "tokenUnit": "token",
      "harness.claude-code": "Claude Code",
      "harness.codex": "Codex",
      "harness.pi": "Pi",
      "durationShort.daysHours": "{{d}} T. {{h}} Std.",
      "durationShort.days": "{{d}} T.",
      "durationShort.hoursMinutes": "{{h}} Std. {{m}} Min.",
      "durationShort.hours": "{{h}} Std.",
      "durationShort.minutes": "{{m}} Min.",
    ],
    "es": [
      "quotaName": "Cuota de suscripciones",
      "quotaDescription": "Cuánto le queda a cada suscripción y cuándo se recarga.",
      "usageName": "Uso diario",
      "usageDescription": "El uso de hoy y la tendencia de los últimos días.",
      "emptyTitle": "Cuota no leída aún",
      "emptyBody": "Abre Cindy y conecta una computadora para ver cuánto le queda a cada suscripción.",
      "emptyUsageTitle": "Uso no leído aún",
      "emptyUsageBody": "Abre Cindy y conecta una computadora para ver tu uso diario.",
      "updateTitle": "Actualiza Cindy en tu computadora",
      "updateBody": "Tras actualizar, aquí verás la cuota y el uso diario.",
      "noSources": "Nada con cuota todavía",
      "valueBasis": "Valor de suscripción",
      "valueBasisLong": "Valor de suscripción estimado",
      "reset": "Reiniciado",
      "todayNone": "Sin uso hoy",
      "resetsIn": "Se reinicia en {{duration}}",
      "other": "Otros",
      "today": "Hoy",
      "dailyAverage": "Promedio diario",
      "paid": "De pago",
      "monthScopeAll": "Últimos 30 días · Todos los dispositivos",
      "monthScopeLocal": "Últimos 30 días · Esta computadora",
      "scopeAll": "Todos los dispositivos",
      "scopeLocal": "Esta computadora",
      "updatedJustNow": "Actualizado hace un momento",
      "updatedMinutes": "Actualizado hace {{n}} min",
      "updatedHours": "Actualizado hace {{n}} h",
      "updatedDays": "Actualizado hace {{n}} días",
      "tokenUnit": "token",
      "harness.claude-code": "Claude Code",
      "harness.codex": "Codex",
      "harness.pi": "Pi",
      "durationShort.daysHours": "{{d}}d {{h}}h",
      "durationShort.days": "{{d}}d",
      "durationShort.hoursMinutes": "{{h}}h {{m}}m",
      "durationShort.hours": "{{h}}h",
      "durationShort.minutes": "{{m}}m",
    ],
    "fr": [
      "quotaName": "Quota des abonnements",
      "quotaDescription": "Ce qu'il reste à chaque abonnement et quand il se recharge.",
      "usageName": "Usage quotidien",
      "usageDescription": "L'usage d'aujourd'hui et la tendance des derniers jours.",
      "emptyTitle": "Quota pas encore lu",
      "emptyBody": "Ouvrez Cindy et connectez un ordinateur pour voir ce qu'il reste à chaque abonnement.",
      "emptyUsageTitle": "Usage pas encore lu",
      "emptyUsageBody": "Ouvrez Cindy et connectez un ordinateur pour voir votre usage quotidien.",
      "updateTitle": "Mettez à jour Cindy sur votre ordinateur",
      "updateBody": "Après la mise à jour, le quota et l'usage quotidien s'afficheront ici.",
      "noSources": "Aucune source avec quota pour l'instant",
      "valueBasis": "Valeur de l'abonnement",
      "valueBasisLong": "Valeur de l'abonnement (estimation)",
      "reset": "Réinitialisé",
      "todayNone": "Aucun usage aujourd'hui",
      "resetsIn": "Réinitialisation dans {{duration}}",
      "other": "Autres",
      "today": "Aujourd'hui",
      "dailyAverage": "Moy. quotidienne",
      "paid": "Payant",
      "monthScopeAll": "30 derniers jours · Tous les appareils",
      "monthScopeLocal": "30 derniers jours · Cet ordinateur",
      "scopeAll": "Tous les appareils",
      "scopeLocal": "Cet ordinateur",
      "updatedJustNow": "Mis à jour à l'instant",
      "updatedMinutes": "Mis à jour il y a {{n}} min",
      "updatedHours": "Mis à jour il y a {{n}} h",
      "updatedDays": "Mis à jour il y a {{n}} jours",
      "tokenUnit": "token",
      "harness.claude-code": "Claude Code",
      "harness.codex": "Codex",
      "harness.pi": "Pi",
      "durationShort.daysHours": "{{d}} j {{h}} h",
      "durationShort.days": "{{d}} j",
      "durationShort.hoursMinutes": "{{h}} h {{m}} min",
      "durationShort.hours": "{{h}} h",
      "durationShort.minutes": "{{m}} min",
    ],
    "pt-BR": [
      "quotaName": "Cota das assinaturas",
      "quotaDescription": "Quanto resta em cada assinatura e quando ela renova.",
      "usageName": "Uso diário",
      "usageDescription": "O uso de hoje e a tendência dos últimos dias.",
      "emptyTitle": "Cota ainda não consultada",
      "emptyBody": "Abra o Cindy e conecte um computador para ver quanto resta em cada assinatura.",
      "emptyUsageTitle": "Uso ainda não consultado",
      "emptyUsageBody": "Abra o Cindy e conecte um computador para ver seu uso diário.",
      "updateTitle": "Atualize o Cindy no seu computador",
      "updateBody": "Depois da atualização, a cota e o uso diário aparecem aqui.",
      "noSources": "Ainda não há fontes com cota",
      "valueBasis": "Valor da assinatura",
      "valueBasisLong": "Valor da assinatura (estimativa)",
      "reset": "Renovada",
      "todayNone": "Nenhum uso hoje",
      "resetsIn": "Renova em {{duration}}",
      "other": "Outros",
      "today": "Hoje",
      "dailyAverage": "Média diária",
      "paid": "Pago",
      "monthScopeAll": "Últimos 30 dias · Todos os dispositivos",
      "monthScopeLocal": "Últimos 30 dias · Este computador",
      "scopeAll": "Todos os dispositivos",
      "scopeLocal": "Este computador",
      "updatedJustNow": "Atualizado agora",
      "updatedMinutes": "Atualizado há {{n}} min",
      "updatedHours": "Atualizado há {{n}} h",
      "updatedDays": "Atualizado há {{n}} dias",
      "tokenUnit": "token",
      "harness.claude-code": "Claude Code",
      "harness.codex": "Codex",
      "harness.pi": "Pi",
      "durationShort.daysHours": "{{d}}d {{h}}h",
      "durationShort.days": "{{d}}d",
      "durationShort.hoursMinutes": "{{h}}h {{m}}m",
      "durationShort.hours": "{{h}}h",
      "durationShort.minutes": "{{m}}m",
    ],
    "pt-PT": [
      "quotaName": "Quota das subscrições",
      "quotaDescription": "Quanto resta em cada subscrição e quando volta a encher.",
      "usageName": "Utilização diária",
      "usageDescription": "A utilização de hoje e a tendência dos últimos dias.",
      "emptyTitle": "Quota ainda não consultada",
      "emptyBody": "Abra o Cindy e ligue um computador para ver quanto resta em cada subscrição.",
      "emptyUsageTitle": "Utilização ainda não consultada",
      "emptyUsageBody": "Abra o Cindy e ligue um computador para ver a sua utilização diária.",
      "updateTitle": "Atualize o Cindy no seu computador",
      "updateBody": "Depois da atualização, a quota e a utilização diária aparecem aqui.",
      "noSources": "Ainda não há fontes com quota",
      "valueBasis": "Valor da subscrição",
      "valueBasisLong": "Valor da subscrição (estimativa)",
      "reset": "Reposta",
      "todayNone": "Sem utilização hoje",
      "resetsIn": "Reposição dentro de {{duration}}",
      "other": "Outros",
      "today": "Hoje",
      "dailyAverage": "Média diária",
      "paid": "Pago",
      "monthScopeAll": "Últimos 30 dias · Todos os dispositivos",
      "monthScopeLocal": "Últimos 30 dias · Este computador",
      "scopeAll": "Todos os dispositivos",
      "scopeLocal": "Este computador",
      "updatedJustNow": "Atualizado agora mesmo",
      "updatedMinutes": "Atualizado há {{n}} min",
      "updatedHours": "Atualizado há {{n}} h",
      "updatedDays": "Atualizado há {{n}} dias",
      "tokenUnit": "token",
      "harness.claude-code": "Claude Code",
      "harness.codex": "Codex",
      "harness.pi": "Pi",
      "durationShort.daysHours": "{{d}}d {{h}}h",
      "durationShort.days": "{{d}}d",
      "durationShort.hoursMinutes": "{{h}}h {{m}}m",
      "durationShort.hours": "{{h}}h",
      "durationShort.minutes": "{{m}}m",
    ],
    "en": [
      "quotaName": "Subscription quota", "quotaDescription": "What each subscription has left and when it refills.",
      "usageName": "Daily usage", "usageDescription": "Today's usage and the trend of recent days.",
      "emptyTitle": "No quota yet", "emptyBody": "Open Cindy and connect a computer to see what each subscription has left.",
      "emptyUsageTitle": "No usage yet", "emptyUsageBody": "Open Cindy and connect a computer to see your daily usage.",
      "updateTitle": "Update Cindy on your computer", "updateBody": "Quota and daily usage appear here after the update.",
      "noSources": "No accounts with quota yet", "valueBasis": "Subscription value", "valueBasisLong": "Subscription value estimate",
      "reset": "Reset", "todayNone": "No usage today", "resetsIn": "Resets in {{duration}}", "other": "Other",
      "today": "Today", "dailyAverage": "Daily avg", "paid": "Paid", "tokenUnit": "tokens",
      "monthScopeAll": "Last 30 days · All devices", "monthScopeLocal": "Last 30 days · This computer",
      "scopeAll": "All devices", "scopeLocal": "This computer",
      "harness.claude-code": "Claude Code", "harness.codex": "Codex", "harness.pi": "Pi",
      "updatedJustNow": "Updated just now", "updatedMinutes": "Updated {{n}}m ago", "updatedHours": "Updated {{n}}h ago",
      "updatedDays": "Updated {{n}}d ago",
      "durationShort.daysHours": "{{d}}d {{h}}h", "durationShort.days": "{{d}}d", "durationShort.hoursMinutes": "{{h}}h {{m}}m",
      "durationShort.hours": "{{h}}h", "durationShort.minutes": "{{m}}m",
    ],
  ]

  private static func language(_ locale: Locale) -> String {
    let id = locale.identifier
    if id.hasPrefix("zh") { return id.contains("Hant") || id.contains("TW") || id.contains("HK") ? "zh-Hant" : "zh-Hans" }
    if id.hasPrefix("ja") { return "ja" }
    if id.hasPrefix("ko") { return "ko" }
    if id.hasPrefix("de") { return "de" }
    if id.hasPrefix("es") { return "es" }
    if id.hasPrefix("fr") { return "fr" }
    if id.hasPrefix("pt") { return id.contains("PT") ? "pt-PT" : "pt-BR" }
    return "en"
  }

  static func text(_ key: String, locale: Locale = Locale(identifier: Locale.preferredLanguages.first ?? "en")) -> String {
    table[language(locale)]?[key] ?? table["en"]?[key] ?? key
  }

  /// Strings normally sent by the computer, for snapshots that lack them and for placeholders.
  static func fallback(_ key: String, locale: Locale) -> String {
    if let value = table[language(locale)]?[key] { return value }
    return table["en"]?[key] ?? key
  }
}
