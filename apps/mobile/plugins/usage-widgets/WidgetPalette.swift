import SwiftUI
import UIKit
import WidgetKit

/// The macOS menu bar panel's palette (`apps/desktop/native/menubar`): every neutral is
/// Cindy's warm black (Light) or warm white (Dark) at an opacity; only state, brand and
/// harness colors are solid.
enum WidgetPalette {
  private static func rgb(_ value: UInt32, _ alpha: CGFloat = 1) -> UIColor {
    UIColor(red: CGFloat((value >> 16) & 0xFF) / 255, green: CGFloat((value >> 8) & 0xFF) / 255,
            blue: CGFloat(value & 0xFF) / 255, alpha: alpha)
  }

  private static func dynamic(_ light: UIColor, _ dark: UIColor) -> Color {
    Color(UIColor { $0.userInterfaceStyle == .dark ? dark : light })
  }

  private static let warmBlack: UInt32 = 0x26221C
  private static let warmWhite: UInt32 = 0xF2EFE9
  private static func neutral(_ light: CGFloat, _ dark: CGFloat) -> Color {
    dynamic(rgb(warmBlack, light), rgb(warmWhite, dark))
  }

  static let ink = neutral(0.92, 0.94)
  static let ink2 = neutral(0.60, 0.62)
  static let ink3 = neutral(0.42, 0.42)
  static let ink4 = neutral(0.14, 0.13)
  static let line = neutral(0.08, 0.07)
  static let tile = dynamic(UIColor(white: 1, alpha: 0.55), rgb(warmWhite, 0.05))
  static let liquid = neutral(0.46, 0.72)
  static let wellTop = dynamic(UIColor(white: 1, alpha: 0.75), rgb(warmWhite, 0.07))
  static let wellBottom = dynamic(UIColor(white: 1, alpha: 0.5), rgb(warmWhite, 0.025))
  static let wellShade = dynamic(UIColor(white: 0, alpha: 0.08), UIColor(white: 0, alpha: 0.5))
  static let background = dynamic(rgb(0xF7F5F0), rgb(0x1C1A18))
  static let glow = dynamic(rgb(0xEA6B17, 0.09), rgb(0xEA6B17, 0.12))
  static let glow2 = dynamic(UIColor(white: 1, alpha: 0.55), rgb(0xFFF4E4, 0.04))

  /// Old-data notices ("updated 7 hours ago"); not a quota state.
  static let warn = Color(rgb(0xEA6B17))
  /// Quota states, shared with the Mac panel and the apps (`@cindy/maker-shared/quota-level`):
  /// plenty left is teal, 30% or less is yellow, 10% or less is red.
  static let plenty = dynamic(rgb(0x14B8A6), rgb(0x2DD4BF))
  static let quotaWarn = Color(rgb(0xF3A115))
  static let error = Color(rgb(0xEF4444))
  static let claude = Color(rgb(0xD97757))
  static let codex = Color(rgb(0x7A9DFF))
  static let pi = dynamic(rgb(0x14B8A6), rgb(0x2DD4BF))

  static let ink5 = neutral(0.05, 0.05)
  /// Neutral ring arcs (a balance) share the liquid's tone, like the panel.
  static let fill = neutral(0.42, 0.80)
  static let claude2 = Color(rgb(0xE8A184))
  static let claude3 = Color(rgb(0xF2C9B6))

  /// Usage History model palette (`--usage-model-1…5`): teal, rose, violet, indigo, amber.
  private static let models: [Color] = [
    dynamic(rgb(0x14B8A6), rgb(0x2DD4BF)),
    dynamic(rgb(0xF43F5E), rgb(0xFB7185)),
    dynamic(rgb(0x8B5CF6), rgb(0xA78BFA)),
    dynamic(rgb(0x6366F1), rgb(0x818CF8)),
    dynamic(rgb(0xF59E0B), rgb(0xFBBF24)),
  ]
  static func model(_ rank: Int) -> Color { models[rank % models.count] }
  /// Everything beyond the named models.
  static let otherModel = neutral(0.24, 0.30)

  /// The panel's semantic color names (`MenubarColor`).
  static func named(_ name: String?) -> Color {
    switch name {
    case "ink2": return ink2
    case "ink3": return ink3
    case "fill": return fill
    case "warn": return quotaWarn
    case "error": return error
    case "claude": return claude
    case "claude2": return claude2
    case "claude3": return claude3
    case "codex": return codex
    case "pi": return pi
    default: return ink
    }
  }

  static func level(_ level: String) -> Color? {
    switch level {
    case "warn": return quotaWarn
    case "error": return error
    default: return nil
    }
  }

  /// Harness colors in stacking order index (0 claude-code, 1 codex, 2 pi).
  static func harness(_ index: Int) -> Color {
    switch index {
    case 0: return claude
    case 1: return codex
    default: return pi
    }
  }

  /// Tinted / clear home screens keep one hue, so harnesses step down in opacity instead.
  static func accentedOpacity(_ index: Int) -> Double {
    switch index {
    case 0: return 1
    case 1: return 0.58
    default: return 0.3
    }
  }
}

/// Barlow Condensed for pure numbers (shipped in the extension, OFL), like the Mac panel.
enum WidgetNumFont {
  static func font(_ size: CGFloat, _ weight: Font.Weight = .semibold) -> Font {
    let face: String
    switch weight {
    case .regular, .medium: face = "BarlowCondensed-Medium"
    default: face = "BarlowCondensed-SemiBold"
    }
    if UIFont(name: face, size: size) == nil { return .system(size: (size * 0.8).rounded(), weight: weight) }
    return .custom(face, fixedSize: size)
  }
}

/// Warm tint with the panel's faint Heart Orange glow in the top-left corner.
struct WidgetBackdrop: View {
  var body: some View {
    ZStack {
      WidgetPalette.background
      RadialGradient(colors: [WidgetPalette.glow, .clear], center: .topLeading, startRadius: 0, endRadius: 240)
      RadialGradient(colors: [WidgetPalette.glow2, .clear], center: UnitPoint(x: 1, y: 0.18), startRadius: 0, endRadius: 220)
    }
  }
}

struct LogoMark: View {
  let source: WidgetSource
  var size: CGFloat = 12

  var body: some View {
    if let logo = source.logo {
      Image("logo-\(logo)")
        .renderingMode(.template)
        .resizable()
        .scaledToFit()
        .frame(width: size, height: size)
    } else {
      Text(source.monogram)
        .font(.system(size: size * 0.7, weight: .bold))
        .frame(width: size, height: size)
        .background(RoundedRectangle(cornerRadius: size * 0.25).stroke(lineWidth: 1))
    }
  }
}
