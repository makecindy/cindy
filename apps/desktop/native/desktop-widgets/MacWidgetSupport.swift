import Foundation
import SwiftUI
import WidgetKit

// The Mac desktop widgets: the phone's subscription quota and daily usage widgets
// (`apps/mobile/plugins/usage-widgets`), fed by the Mac they run on. Everything that
// differs from the phone lives here; build.mjs compiles it with the shared sources.

@main
struct CindyDesktopWidgetsBundle: WidgetBundle {
  var body: some Widget {
    QuotaWidget()
    DailyUsageWidget()
  }
}

extension WidgetStore {
  /// The store the desktop app writes (`desktopWidgets.ts`): the same `UsageWidgetStore` shape
  /// the phone app keeps, with this Mac as its only computer. The extension's sandbox only
  /// opens this one folder, read-only, and the path inside it is home-relative.
  static var fileURL: URL? {
    guard let relative = Bundle.main.object(forInfoDictionaryKey: "CindyWidgetDataPath") as? String,
          let home = realHomeDirectory()
    else { return nil }
    return home.appendingPathComponent(relative).appendingPathComponent("usage-widget-snapshot.json")
  }

  /// A sandboxed process's home is its container; the exception is relative to the real one.
  private static func realHomeDirectory() -> URL? {
    guard let entry = getpwuid(getuid()), let dir = entry.pointee.pw_dir else { return nil }
    return URL(fileURLWithPath: String(cString: dir), isDirectory: true)
  }
}

/// Mac wording where the phone's speaks of connecting to a computer.
enum MacWidgetText {
  private static let table: [String: [String: String]] = [
    "zh-Hans": [
      "emptyBody": "登录 Cindy 后，这里会显示每个订阅还剩多少、什么时候回满。",
      "emptyUsageBody": "登录 Cindy 后，这里会显示每天的用量。",
    ],
    "zh-Hant": [
      "emptyBody": "登入 Cindy 後，這裡會顯示每個訂閱還剩多少、什麼時候回滿。",
      "emptyUsageBody": "登入 Cindy 後，這裡會顯示每天的用量。",
    ],
    "ja": [
      "emptyBody": "Cindy にサインインすると、各サブスクリプションの残りとリセット時刻がここに表示されます。",
      "emptyUsageBody": "Cindy にサインインすると、毎日の使用量がここに表示されます。",
    ],
    "ko": [
      "emptyBody": "Cindy에 로그인하면 구독마다 얼마나 남았는지, 언제 다시 채워지는지 여기에 표시돼요.",
      "emptyUsageBody": "Cindy에 로그인하면 일일 사용량이 여기에 표시돼요.",
    ],
    "de": [
      "emptyBody": "Melde dich bei Cindy an, dann siehst du hier, wie viel jedes Abo noch hat und wann es sich auffüllt.",
      "emptyUsageBody": "Melde dich bei Cindy an, dann siehst du hier deine tägliche Nutzung.",
    ],
    "es": [
      "emptyBody": "Inicia sesión en Cindy para ver aquí cuánto le queda a cada suscripción y cuándo se recarga.",
      "emptyUsageBody": "Inicia sesión en Cindy para ver aquí tu uso diario.",
    ],
    "fr": [
      "emptyBody": "Connectez-vous à Cindy pour voir ici ce qu'il reste à chaque abonnement et quand il se recharge.",
      "emptyUsageBody": "Connectez-vous à Cindy pour voir ici votre utilisation quotidienne.",
    ],
    "pt-BR": [
      "emptyBody": "Entre no Cindy para ver aqui quanto resta em cada assinatura e quando ela é renovada.",
      "emptyUsageBody": "Entre no Cindy para ver aqui seu uso diário.",
    ],
    "pt-PT": [
      "emptyBody": "Inicie sessão no Cindy para ver aqui quanto resta em cada subscrição e quando é renovada.",
      "emptyUsageBody": "Inicie sessão no Cindy para ver aqui a sua utilização diária.",
    ],
    "en": [
      "emptyBody": "Sign in to Cindy to see what each subscription has left and when it refills.",
      "emptyUsageBody": "Sign in to Cindy to see your daily usage.",
    ],
  ]

  static func text(_ key: String, language: String) -> String? {
    table[language]?[key] ?? (table["en"]?[key])
  }
}
