// Cindy menu bar quota helper (macOS).
//
// Main (TypeScript) owns data, product wording and settings; it sends a complete view
// model as newline-delimited JSON on stdin. This process owns the NSStatusItem, the panel
// window and the SwiftUI pages, and reports user intent back on stdout.
//
// Built with `-parse-as-library` so SwiftUI state behaves normally (the top-level script
// mode used by the Agent Island helper drops `@State` initial values).

import AppKit
import Charts
import Combine
import CoreText
import SwiftUI

// MARK: - Protocol

struct MBSettings: Codable, Equatable {
  var enabled: Bool
  var order: [String]
  var hidden: [String]
  var shown: [String]
  var statusText: String
  var lowAlert: Bool
  var privacy: Bool
  var scope: String
}

struct MBCell: Decodable, Identifiable, Equatable {
  let id: String
  let kind: String
  let logoSvg: String
  let name: String
  let value: String?
  let valueUnit: String?
  let valueLabel: String?
  let level: String
  let fill: Double?
  let reserve: Bool
  let emphasized: Bool
  /// A running task is drawing on this source; its liquid ripples. Optional for older main.
  let active: Bool?
  let when: String
  let whenLevel: String
  let accessibilityLabel: String
}

struct MBRing: Decodable, Equatable {
  let fraction: Double
  let color: String
}

struct MBFact: Decodable, Equatable, Hashable {
  let label: String
  let value: String
  let sub: String
}

struct MBAction: Decodable, Equatable {
  let kind: String
  let providerId: String?
}

struct MBLegend: Decodable, Equatable, Hashable {
  let label: String
  let color: String
}

struct MBDetail: Decodable, Equatable {
  let id: String
  let logoSvg: String
  let title: String
  let plan: String
  let rings: [MBRing]
  let bigValue: String
  let bigUnit: String?
  let bigColor: String?
  let bigCompact: Bool
  let bigCaption: String
  let legend: [MBLegend]
  let sayPrimary: String
  let saySecondary: String?
  let facts: [MBFact]
  let actionLabel: String
  let action: MBAction
}

struct MBTask: Decodable, Identifiable, Equatable {
  var id: String { sessionId }
  let sessionId: String
  let title: String
  let harness: String
  let logoSvg: String
  let value: Double
  let tokens: Double
  let running: Bool
  let startedAtMs: Double?
  let idleStatus: String
  let meta: String
}

struct MBModelUsage: Decodable, Equatable {
  let name: String
  let harness: String
  let money: Double
  let tokens: Double
}

struct MBDaily: Decodable, Equatable {
  let money: [Double]
  let paid: Double
  let tokens: [Double]
}

struct MBScopeData: Decodable, Equatable {
  let daily: [MBDaily]
  let models: [String: [MBModelUsage]]
  let note: String
}

struct MBUsage: Decodable, Equatable {
  let days: [String]
  let scopes: [String: MBScopeData]
}

struct MBManageRow: Decodable, Identifiable, Equatable {
  let id: String
  let logoSvg: String
  let title: String
  let subtitle: String
  let value: String
  let hidden: Bool
}

struct MBView: Decodable, Equatable {
  let locale: String
  let moneySymbol: String
  let strings: [String: String]
  let statusTextByMode: [String: String?]
  let attentionCount: Int?
  let remotelyControlled: Bool?
  let remoteControllerNames: [String]?
  let updatedAtMs: Double?
  let headlinePrimary: String
  let headlineSecondary: String?
  /// The second line warns about sources running low; it gets the warning dot.
  let headlineAlert: Bool?
  let sources: [MBCell]
  let details: [String: MBDetail]
  let taskSummary: String
  let tasks: [MBTask]
  let usage: MBUsage
  let manage: [MBManageRow]
  let settings: MBSettings
  /// "sign-in" until the user signs in or skips sign-in; nothing was read.
  let gate: String?

  /// The real item and its settings preview always use the same text.
  var statusTitle: String {
    guard gate == nil else { return "" }
    let usage = (statusTextByMode[settings.statusText] ?? nil) ?? ""
    guard let count = attentionCount, count > 0 else { return usage }
    return usage.isEmpty ? String(count) : "\(count) · \(usage)"
  }
}

struct MBIncoming: Decodable {
  let type: String
  let view: MBView?
}

enum Bridge {
  private static let lock = NSLock()

  static func emit(_ payload: [String: Any]) {
    lock.lock()
    defer { lock.unlock() }
    guard let data = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]) else {
      FileHandle.standardError.write(Data("menubar: could not encode event\n".utf8))
      return
    }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([0x0a]))
  }

  static func emitSettings(_ patch: [String: Any]) {
    emit(["type": "settings", "patch": patch])
  }
}

// MARK: - Palette

enum Palette {
  private static func hex(_ value: UInt32, _ alpha: CGFloat = 1) -> NSColor {
    NSColor(
      srgbRed: CGFloat((value >> 16) & 0xFF) / 255,
      green: CGFloat((value >> 8) & 0xFF) / 255,
      blue: CGFloat(value & 0xFF) / 255,
      alpha: alpha
    )
  }

  private static func dynamic(_ light: NSColor, _ dark: NSColor) -> Color {
    Color(nsColor: NSColor(name: nil) { appearance in
      appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? dark : light
    })
  }

  // Every neutral is Cindy's warm black (Light) or warm white (Dark) at an opacity, never a
  // fixed gray: the panel is translucent, so a fixed gray's contrast drifts with whatever
  // shows through, while an opacity darkens or lightens what is behind it and keeps the
  // relationship steady. Only state, brand and harness colors stay solid.
  private static let warmBlack: UInt32 = 0x26221C
  private static let warmWhite: UInt32 = 0xF2EFE9
  private static func neutral(_ light: CGFloat, _ dark: CGFloat) -> Color {
    dynamic(hex(warmBlack, light), hex(warmWhite, dark))
  }
  /// Titles and values: nearly opaque so they stay crisp.
  static let ink = neutral(0.92, 0.94)
  static let ink2 = neutral(0.60, 0.62)
  /// Times, units and captions.
  static let ink3 = neutral(0.42, 0.42)
  /// Outlines and tube borders.
  static let ink4 = neutral(0.14, 0.13)
  /// Faint fills: hover, ring tracks.
  static let ink5 = neutral(0.05, 0.05)
  static let line = neutral(0.08, 0.07)
  static let tile = dynamic(NSColor(white: 1, alpha: 0.45), hex(warmWhite, 0.05))
  static let edge = dynamic(NSColor(white: 1, alpha: 0.8), hex(warmWhite, 0.09))
  /// Solid fill for the primary pill: it is the one control that must read at full contrast.
  static let cta = dynamic(hex(0x1F1E1C), hex(warmWhite))
  // The liquid is the ink color at partial opacity, not a flat gray: the glass well shows
  // through, so it reads as water instead of paint, and it stays softer than text so seven
  // full tubes do not read as hard black or white bars.
  /// One flat tone, no gradient: warm black (Light) or warm white (Dark) at an opacity.
  static let liquid = neutral(0.46, 0.72)
  /// Neutral ring arcs (Grok, a balance) share the liquid's color.
  static let fill = neutral(0.42, 0.80)
  /// Text on an `ink` pill.
  static let onInk = dynamic(hex(0xFFFFFF), hex(0x0E0E0D))
  /// Warm tint and glows laid over the popover material.
  static let panelTint = dynamic(hex(0xF8F7F3, 0.5), hex(0x1A1918, 0.54))
  static let panelGlow = dynamic(hex(0xEA6B17, 0.09), hex(0xEA6B17, 0.12))
  static let panelGlow2 = dynamic(NSColor(white: 1, alpha: 0.55), hex(0xFFF4E4, 0.04))
  /// Glass well behind the liquid.
  static let wellTop = dynamic(NSColor(white: 1, alpha: 0.7), hex(warmWhite, 0.07))
  static let wellBottom = dynamic(NSColor(white: 1, alpha: 0.5), hex(warmWhite, 0.025))
  static let wellShade = dynamic(NSColor(white: 0, alpha: 0.08), NSColor(white: 0, alpha: 0.5))
  /// Red of the Cindy logo's ">" mark (the logo red, not a state color).
  static let brand = Color(nsColor: hex(0xF70121))
  static let warn = Color(nsColor: hex(0xEA6B17))
  /// Shared by the menu-bar dot and its explanation inside the panel.
  private static let remoteControlValue: UInt32 = 0xFF9F0A
  static let remoteControlHex = String(format: "#%06X", remoteControlValue)
  static let remoteControl = Color(nsColor: hex(remoteControlValue))
  static let error = Color(nsColor: hex(0xD91F37))
  static let focus = Color(nsColor: hex(0x417CDD))
  static let claude = Color(nsColor: hex(0xD97757))
  static let claude2 = Color(nsColor: hex(0xE8A184))
  static let claude3 = Color(nsColor: hex(0xF2C9B6))
  static let codex = Color(nsColor: hex(0x7A9DFF))
  static let pi = dynamic(hex(0x14B8A6), hex(0x2DD4BF))

  static func named(_ name: String?) -> Color {
    switch name {
    case "ink2": return ink2
    case "ink3": return ink3
    case "fill": return fill
    case "warn": return warn
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
    case "warn": return warn
    case "error": return error
    default: return nil
    }
  }

  static func harness(_ harness: String) -> Color {
    switch harness {
    case "claude-code": return claude
    case "pi": return pi
    default: return codex
    }
  }
}

/// The open/fill curve shared by tubes, rings, page slides and the panel width.
enum Motion {
  static let fill = Animation.timingCurve(0.22, 1, 0.36, 1, duration: 0.5)
  /// Tube liquid rises slower than the rings, like a liquid settling.
  static let liquid = Animation.timingCurve(0.22, 1, 0.36, 1, duration: 0.9)
  static let page = Animation.timingCurve(0.22, 1, 0.36, 1, duration: 0.5)
  static let quick = Animation.easeOut(duration: 0.2)
}

// MARK: - Formatting

enum Fmt {
  /// Currency symbol of the usage ledger ($ on Global, ¥ in mainland China); set by main.
  @MainActor static var symbol = "$"

  @MainActor static func money(_ value: Double) -> String {
    if value >= 10_000 { return symbol + String(format: "%.1fk", value / 1000) }
    if value >= 100 { return symbol + grouped(value.rounded()) }
    return symbol + String(format: "%.2f", value)
  }

  static func tokens(_ value: Double) -> String {
    let millions = value / 1_000_000
    if millions >= 1000 { return String(format: "%.1fB", millions / 1000) }
    if millions >= 1 { return "\(Int(millions.rounded()))M" }
    if value >= 1000 { return "\(Int((value / 1000).rounded()))K" }
    return "\(Int(max(0, value).rounded()))"
  }

  static func grouped(_ value: Double) -> String {
    let formatter = NumberFormatter()
    formatter.numberStyle = .decimal
    formatter.locale = Locale(identifier: "en_US")
    formatter.maximumFractionDigits = 0
    return formatter.string(from: NSNumber(value: value)) ?? String(Int(value))
  }

  static func clock(_ seconds: Double) -> String {
    let total = max(0, Int(seconds))
    return "\(total / 60):" + String(format: "%02d", total % 60)
  }

  static func template(_ template: String, _ values: [String: String]) -> String {
    var output = template
    for (key, value) in values {
      output = output.replacingOccurrences(of: "{{\(key)}}", with: value)
    }
    return output
  }

  private static var dayCache: [String: Date] = [:]

  static func day(_ iso: String) -> Date {
    if let cached = dayCache[iso] { return cached }
    var components = DateComponents()
    let parts = iso.split(separator: "-").compactMap { Int($0) }
    if parts.count == 3 {
      components.year = parts[0]
      components.month = parts[1]
      components.day = parts[2]
      components.hour = 12
    }
    let date = Calendar.current.date(from: components) ?? Date()
    dayCache[iso] = date
    return date
  }

  static func monthDay(_ date: Date, locale: String) -> String {
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: locale)
    formatter.setLocalizedDateFormatFromTemplate("MMMd")
    return formatter.string(from: date)
  }

  static func weekday(_ date: Date, locale: String) -> String {
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: locale)
    formatter.setLocalizedDateFormatFromTemplate("EEE")
    return formatter.string(from: date)
  }

  static func clockTime(_ date: Date, locale: String) -> String {
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: locale)
    formatter.setLocalizedDateFormatFromTemplate("EEE HH:mm")
    return formatter.string(from: date)
  }
}

// MARK: - Logos

enum Logos {
  private static var cache: [String: NSImage] = [:]

  /// Main sends this instead of the Cindy mark's long path; see `MENUBAR_CINDY_LOGO`.
  static let cindySentinel = "cindy:mark"

  static func image(_ svg: String) -> NSImage? {
    if let cached = cache[svg] { return cached }
    let source = svg == cindySentinel
      ? "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\"><path fill=\"#000\" fill-rule=\"evenodd\" d=\"\(cindyMarkPath)\"/></svg>"
      : svg
    guard let data = source.data(using: .utf8), let image = NSImage(data: data) else { return nil }
    image.isTemplate = true
    cache[svg] = image
    return image
  }

  /// Opaque silhouette with tonal, tapered strands and a larger, left-shifted earring.
  /// Fit the mark to the 18pt status canvas; other brand surfaces keep their original mark.
  static func statusIcon(dark: Bool, controlled: Bool = false) -> NSImage? {
    if controlled { return dark ? darkControlledStatusIcon : lightControlledStatusIcon }
    return dark ? darkStatusIcon : lightStatusIcon
  }

  private static let lightStatusIcon = makeStatusIcon(dark: false)
  private static let darkStatusIcon = makeStatusIcon(dark: true)
  private static let lightControlledStatusIcon = makeStatusIcon(dark: false, controlled: true)
  private static let darkControlledStatusIcon = makeStatusIcon(dark: true, controlled: true)

  private static func makeStatusIcon(dark: Bool, controlled: Bool = false) -> NSImage? {
    let silhouette = dark ? "#ffffff" : "#000000"
    let strand = dark ? "#686868" : "#bdbdbd"
    let earring = "M 10.22879,11.96118 L 13.40721,13.91787 L 13.40721,14.65125 L 10.22879,16.60782 L 10.22879,15.50708 L 12.30648,14.28390 L 10.22879,13.06192 L 10.22879,11.96118 Z"
    // Gray overlays sit on the opaque silhouette rather than cutting holes in it.
    let hairStrands = """
    <path fill="\(strand)" fill-opacity="0.58" d="
    M 17.700,4.600 L 17.423,4.473 L 17.142,4.366 L 16.861,4.275 L 16.578,4.200 L 16.295,4.139 L 16.012,4.094
    L 15.729,4.063 L 15.446,4.047 L 15.164,4.044 L 14.883,4.056 L 14.604,4.081 L 14.327,4.119 L 14.051,4.171
    L 13.779,4.235 L 13.509,4.311 L 13.243,4.399 L 12.980,4.498 L 12.721,4.609 L 12.466,4.730 L 12.216,4.862
    L 11.970,5.003 L 11.730,5.154 L 11.494,5.314 L 11.264,5.482 L 11.040,5.658 L 10.822,5.843 L 10.610,6.034
    L 10.404,6.233 L 10.205,6.438 L 10.012,6.649 L 9.826,6.865 L 9.647,7.087 L 9.476,7.313 L 9.312,7.544 L
    9.156,7.779 L 9.007,8.017 L 8.866,8.259 L 8.734,8.503 L 8.611,8.750 L 8.500,9.000 L 8.500,9.000 L
    8.651,8.772 L 8.805,8.546 L 8.965,8.321 L 9.129,8.100 L 9.300,7.882 L 9.475,7.668 L 9.656,7.458 L
    9.842,7.252 L 10.033,7.051 L 10.229,6.855 L 10.429,6.663 L 10.634,6.477 L 10.842,6.297 L 11.055,6.122 L
    11.272,5.954 L 11.493,5.792 L 11.717,5.636 L 11.944,5.488 L 12.175,5.347 L 12.409,5.213 L 12.647,5.088 L
    12.887,4.970 L 13.130,4.860 L 13.377,4.760 L 13.626,4.668 L 13.878,4.585 L 14.132,4.512 L 14.390,4.449 L
    14.650,4.396 L 14.914,4.353 L 15.180,4.322 L 15.448,4.302 L 15.720,4.294 L 15.994,4.298 L 16.271,4.315 L
    16.551,4.345 L 16.834,4.389 L 17.120,4.446 L 17.408,4.517 L 17.700,4.600 Z
    "/>
    <path fill="\(strand)" fill-opacity="0.48" d="
    M 7.600,10.600 L 7.481,10.754 L 7.369,10.910 L 7.262,11.064 L 7.160,11.219 L 7.063,11.372 L 6.971,11.525
    L 6.883,11.677 L 6.800,11.829 L 6.722,11.980 L 6.649,12.130 L 6.581,12.280 L 6.519,12.429 L 6.461,12.577
    L 6.409,12.724 L 6.362,12.871 L 6.321,13.018 L 6.285,13.163 L 6.255,13.308 L 6.230,13.452 L 6.212,13.595
    L 6.199,13.737 L 6.192,13.877 L 6.192,14.017 L 6.197,14.155 L 6.209,14.292 L 6.226,14.428 L 6.250,14.561
    L 6.280,14.693 L 6.316,14.823 L 6.357,14.951 L 6.405,15.077 L 6.459,15.200 L 6.519,15.322 L 6.584,15.441
    L 6.655,15.557 L 6.732,15.671 L 6.815,15.783 L 6.903,15.892 L 6.998,15.998 L 7.100,16.100 L 7.100,16.100
    L 7.028,15.976 L 6.959,15.854 L 6.895,15.732 L 6.837,15.611 L 6.784,15.489 L 6.736,15.368 L 6.693,15.247
    L 6.655,15.126 L 6.621,15.005 L 6.593,14.883 L 6.568,14.762 L 6.549,14.640 L 6.533,14.517 L 6.522,14.393
    L 6.515,14.269 L 6.512,14.144 L 6.512,14.018 L 6.517,13.890 L 6.526,13.761 L 6.538,13.630 L 6.555,13.498
    L 6.575,13.364 L 6.599,13.229 L 6.627,13.091 L 6.658,12.952 L 6.694,12.810 L 6.734,12.667 L 6.777,12.521
    L 6.824,12.373 L 6.876,12.223 L 6.931,12.071 L 6.990,11.917 L 7.053,11.760 L 7.120,11.601 L 7.191,11.441
    L 7.266,11.277 L 7.345,11.112 L 7.427,10.944 L 7.513,10.774 L 7.600,10.600 Z
    "/>
    <path fill="\(strand)" fill-opacity="0.36" d="
    M 9.500,12.300 L 9.421,12.437 L 9.350,12.576 L 9.284,12.718 L 9.224,12.860 L 9.168,13.003 L 9.118,13.147
    L 9.072,13.292 L 9.032,13.438 L 8.996,13.584 L 8.965,13.730 L 8.939,13.876 L 8.919,14.022 L 8.902,14.168
    L 8.891,14.313 L 8.885,14.458 L 8.883,14.602 L 8.886,14.745 L 8.894,14.887 L 8.906,15.028 L 8.923,15.168
    L 8.945,15.305 L 8.971,15.441 L 9.001,15.576 L 9.036,15.708 L 9.075,15.837 L 9.118,15.965 L 9.165,16.089
    L 9.216,16.211 L 9.271,16.331 L 9.329,16.447 L 9.392,16.559 L 9.457,16.669 L 9.527,16.775 L 9.599,16.877
    L 9.675,16.975 L 9.754,17.069 L 9.836,17.159 L 9.920,17.245 L 10.008,17.326 L 10.100,17.400 L
    10.100,17.400 L 10.030,17.306 L 9.960,17.210 L 9.894,17.113 L 9.829,17.013 L 9.768,16.911 L 9.709,16.806
    L 9.653,16.700 L 9.600,16.591 L 9.550,16.479 L 9.502,16.366 L 9.457,16.251 L 9.414,16.133 L 9.375,16.014
    L 9.338,15.893 L 9.304,15.770 L 9.273,15.646 L 9.244,15.520 L 9.219,15.392 L 9.196,15.263 L 9.177,15.132
    L 9.160,15.000 L 9.146,14.867 L 9.135,14.732 L 9.128,14.596 L 9.124,14.459 L 9.123,14.321 L 9.125,14.182
    L 9.131,14.041 L 9.140,13.900 L 9.153,13.758 L 9.170,13.615 L 9.191,13.471 L 9.215,13.327 L 9.244,13.182
    L 9.276,13.036 L 9.313,12.890 L 9.354,12.743 L 9.399,12.596 L 9.448,12.449 L 9.500,12.300 Z
    "/>
    <path fill="\(strand)" fill-opacity="0.52" d="
    M 18.000,7.700 L 17.877,7.640 L 17.751,7.591 L 17.621,7.550 L 17.489,7.517 L 17.355,7.493 L 17.220,7.476
    L 17.082,7.467 L 16.944,7.465 L 16.805,7.471 L 16.665,7.484 L 16.524,7.504 L 16.384,7.530 L 16.244,7.564
    L 16.105,7.603 L 15.966,7.649 L 15.828,7.701 L 15.691,7.758 L 15.555,7.821 L 15.421,7.889 L 15.289,7.962
    L 15.158,8.040 L 15.029,8.122 L 14.903,8.209 L 14.779,8.299 L 14.657,8.394 L 14.537,8.491 L 14.420,8.593
    L 14.306,8.697 L 14.195,8.804 L 14.087,8.913 L 13.982,9.025 L 13.880,9.139 L 13.782,9.255 L 13.687,9.372
    L 13.595,9.491 L 13.507,9.611 L 13.423,9.731 L 13.344,9.853 L 13.268,9.975 L 13.200,10.100 L
    13.200,10.100 L 13.300,10.000 L 13.400,9.898 L 13.501,9.795 L 13.604,9.694 L 13.710,9.593 L 13.817,9.492
    L 13.926,9.393 L 14.037,9.295 L 14.149,9.198 L 14.263,9.102 L 14.378,9.009 L 14.495,8.917 L 14.613,8.827
    L 14.731,8.739 L 14.851,8.653 L 14.972,8.570 L 15.093,8.489 L 15.215,8.411 L 15.338,8.335 L 15.461,8.263
    L 15.585,8.194 L 15.709,8.128 L 15.833,8.065 L 15.958,8.006 L 16.083,7.951 L 16.208,7.900 L 16.333,7.853
    L 16.459,7.810 L 16.584,7.772 L 16.710,7.738 L 16.837,7.709 L 16.963,7.685 L 17.090,7.666 L 17.218,7.653
    L 17.346,7.646 L 17.475,7.644 L 17.604,7.649 L 17.735,7.660 L 17.866,7.678 L 18.000,7.700 Z
    "/>
    """
    // Brighter orange for this small menu-bar indicator. The clear rim lets
    // wallpaper show through and keeps the 5pt dot distinct from the silhouette.
    let svg = """
    <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 18 18">
      <defs><mask id="control-dot-cutout"><rect width="18" height="18" fill="white"/>
        \(controlled ? "<circle cx=\"4.5\" cy=\"4.5\" r=\"3.25\" fill=\"black\"/>" : "")
      </mask></defs>
      <g mask="url(#control-dot-cutout)">
      <g transform="translate(-0.765 -0.445) scale(0.8157)">
        <path fill="\(silhouette)" fill-rule="evenodd" d="\(cindySilhouettePath) \(earring)"/>
        \(hairStrands)
      </g>
      </g>
      \(controlled ? "<circle cx=\"4.5\" cy=\"4.5\" r=\"2.5\" fill=\"\(Palette.remoteControlHex)\"/>" : "")
    </svg>
    """
    guard let data = svg.data(using: .utf8), let image = NSImage(data: data) else { return nil }
    image.isTemplate = false
    image.size = NSSize(width: 18, height: 18)
    image.accessibilityDescription = "Cindy"
    return image
  }
}

struct LogoView: View {
  let svg: String
  var size: CGFloat = 13
  var color: Color = Palette.ink

  var body: some View {
    if let image = Logos.image(svg) {
      Image(nsImage: image)
        .renderingMode(.template)
        .resizable()
        .interpolation(.high)
        .aspectRatio(contentMode: .fit)
        .frame(width: size, height: size)
        .foregroundStyle(color)
    } else {
      Color.clear.frame(width: size, height: size)
    }
  }
}

// MARK: - Store

enum Page: Equatable {
  case main
  case detail(String)
  case usage
  case manage
}

enum UsageList: String {
  case models
  case tasks
}

@MainActor
final class MenubarStore: ObservableObject {
  @Published var view: MBView?
  @Published var page: Page = .main
  /// Bumped every time the panel opens; tubes and rings replay their fill from zero.
  @Published var fillToken = 0
  @Published var refreshing = false
  @Published var usageRange = 30
  @Published var usageList: UsageList = .models
  /// Manage list order while the user drags, before main echoes the saved settings back.
  @Published var draftOrder: [String]?
  @Published var mainContentHeight: CGFloat = 0
  /// Width of the narrow pages; follows the number of tubes so a few don't sit in a wide panel.
  @Published var narrowWidth: CGFloat = StatusController.narrowWidth
  /// Natural height of the open detail page; the panel grows to fit it when main is shorter.
  @Published var detailContentHeight: CGFloat = 0
  /// Natural height of the usage page; the panel takes it instead of the main page's height.
  @Published var usageContentHeight: CGFloat = 0
  /// Natural height of the manage page; the panel takes it instead of the main page's height.
  @Published var manageContentHeight: CGFloat = 0
  @Published var shakeId: String?
  /// Set when the panel opens on a short screen (13–14" laptops at default scaling): tubes,
  /// rings and the task list tighten so the main page stays well clear of the Dock.
  @Published var short = false
  /// True from `open` until the closing fade has ordered the panel out. While false the pages
  /// are not rendered, so their clocks and repeating animations stop instead of running in a
  /// hidden window.
  @Published var panelVisible = false

  var strings: [String: String] { view?.strings ?? [:] }

  func s(_ key: String) -> String { strings[key] ?? key }

  /// Fills `{{name}}` placeholders. A count in `n` picks the `_one` / `_other` variant when
  /// main sent one, so languages with singular forms read naturally.
  func s(_ key: String, _ values: [String: String]) -> String {
    var resolved = key
    if let n = values["n"], let count = Int(n) {
      let variant = "\(key)_\(count == 1 ? "one" : "other")"
      if strings[variant] != nil { resolved = variant }
    }
    return Fmt.template(s(resolved), values)
  }

  var locale: String { view?.locale ?? "en" }

  func apply(_ next: MBView) {
    Fmt.symbol = next.moneySymbol
    view = next
    if refreshing { refreshing = false }
    if let draft = draftOrder, draft == next.settings.order || draftMatches(next) {
      draftOrder = nil
    }
    if case .detail(let id) = page, next.details[id] == nil { page = .main }
    if next.gate != nil, page == .usage { page = .main }
    let width = Self.narrowWidth(tubes: next.gate == nil ? next.sources.filter { $0.fill != nil }.count : 0)
    if width != narrowWidth { narrowWidth = width }
  }

  /// Five or more tubes use the full 368pt; fewer give width back, down to 320pt, which still
  /// fits the captions, task rows and the month card in every language.
  static func narrowWidth(tubes: Int) -> CGFloat {
    switch tubes {
    case ...2: return 320
    case 3: return 332
    case 4: return 350
    default: return StatusController.narrowWidth
    }
  }

  private func draftMatches(_ next: MBView) -> Bool {
    guard let draft = draftOrder else { return false }
    return next.manage.map(\.id) == draft
  }

  func go(_ next: Page) {
    withAnimation(Motion.page) { page = next }
  }

  func refresh() {
    guard !refreshing else { return }
    refreshing = true
    Bridge.emit(["type": "refresh"])
    DispatchQueue.main.asyncAfter(deadline: .now() + 4) { [weak self] in
      self?.refreshing = false
    }
  }

  var manageRows: [MBManageRow] {
    guard let view else { return [] }
    guard let draft = draftOrder else { return view.manage }
    let byId = Dictionary(uniqueKeysWithValues: view.manage.map { ($0.id, $0) })
    return draft.compactMap { byId[$0] }
  }

  /// Live reorder while dragging: the dragged row takes the slot of the row it enters, so
  /// entering the next row down moves it down by one (and up likewise).
  func move(_ id: String, into target: String) {
    var order = manageRows.map(\.id)
    guard let from = order.firstIndex(of: id), let to = order.firstIndex(of: target), from != to else { return }
    order.remove(at: from)
    order.insert(id, at: to)
    withAnimation(.spring(response: 0.3, dampingFraction: 0.86)) { draftOrder = order }
  }

  func moveBy(_ id: String, offset: Int) {
    var order = manageRows.map(\.id)
    guard let from = order.firstIndex(of: id) else { return }
    let to = from + offset
    guard to >= 0, to < order.count else { return }
    order.swapAt(from, to)
    withAnimation(.spring(response: 0.3, dampingFraction: 0.86)) { draftOrder = order }
    commitOrder()
  }

  func commitOrder() {
    guard let draft = draftOrder else { return }
    Bridge.emitSettings(["order": draft])
  }

  func toggleHidden(_ row: MBManageRow) {
    guard let view else { return }
    var hidden = Set(view.settings.hidden)
    var shown = Set(view.settings.shown)
    if row.hidden {
      hidden.remove(row.id)
      shown.insert(row.id)
    } else {
      let visibleCount = view.manage.filter { !$0.hidden }.count
      if visibleCount <= 1 {
        shakeId = row.id
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in self?.shakeId = nil }
        return
      }
      hidden.insert(row.id)
      shown.remove(row.id)
    }
    Bridge.emitSettings(["hidden": Array(hidden).sorted(), "shown": Array(shown).sorted()])
  }
}

// MARK: - Panel window

final class MenubarPanel: NSPanel {
  override var canBecomeKey: Bool { true }
  override var canBecomeMain: Bool { false }
}

/// Rounded, frosted backing for the panel. Uses the system popover material so the panel
/// reads like other menu bar extras in both appearances.
final class PanelBackgroundView: NSVisualEffectView {
  static let radius: CGFloat = 20

  override init(frame frameRect: NSRect) {
    super.init(frame: frameRect)
    material = .popover
    blendingMode = .behindWindow
    state = .active
    maskImage = PanelBackgroundView.mask(radius: PanelBackgroundView.radius)
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) is unavailable") }

  static func mask(radius: CGFloat) -> NSImage {
    let edge = radius * 2 + 1
    let image = NSImage(size: NSSize(width: edge, height: edge), flipped: false) { rect in
      NSColor.black.setFill()
      NSBezierPath(roundedRect: rect, xRadius: radius, yRadius: radius).fill()
      return true
    }
    image.capInsets = NSEdgeInsets(top: radius, left: radius, bottom: radius, right: radius)
    image.resizingMode = .stretch
    return image
  }
}

@MainActor
final class StatusController: NSObject, NSWindowDelegate {
  static let narrowWidth: CGFloat = 368
  private static let screenGap: CGFloat = 6
  private static let sideMargin: CGFloat = 12
  /// Screens with less visible height than this get the short layout.
  private static let shortScreenHeight: CGFloat = 1000
  /// The panel never takes more than this share of the visible height, so it reads as a
  /// menu and not a window; anything longer scrolls between the fixed header and footer.
  private static let heightShare: CGFloat = 0.86
  /// Preview mode only: forces the short layout regardless of the screen.
  var forceShort = false
  /// Preview mode only: focus moving to another app must not close the panel mid-snapshot.
  var pinned = false

  let store: MenubarStore
  private let statusItem: NSStatusItem
  private var statusAppearanceObservation: NSKeyValueObservation?
  private var panel: MenubarPanel?
  private var hosting: NSHostingView<PanelRoot>?
  private var outsideMonitor: Any?
  private var keyMonitor: Any?
  private var cancellables = Set<AnyCancellable>()
  private(set) var isOpen = false
  private var closing = false
  private var openRetries = 0
  /** True while the open animation runs; a frame set directly then would be overwritten. */
  private var openAnimating = false
  /** When a press on the status item closed the panel; that click's own action is then ignored. */
  private var closedByStatusPressAt: TimeInterval?

  init(store: MenubarStore) {
    self.store = store
    statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    super.init()
    if let button = statusItem.button {
      // Wallpaper can give the menu bar a different appearance from the app.
      statusAppearanceObservation = button.observe(\.effectiveAppearance, options: [.initial, .new]) { [weak self] _, _ in
        MainActor.assumeIsolated {
          self?.updateStatusIcon()
        }
      }
      button.imagePosition = .imageLeading
      button.target = self
      button.action = #selector(toggle)
      button.sendAction(on: [.leftMouseUp, .rightMouseUp])
      button.setAccessibilityLabel("Cindy")
    }
    store.$view
      .receive(on: RunLoop.main)
      .sink { [weak self] _ in self?.updateStatusTitle() }
      .store(in: &cancellables)
    store.$page
      .removeDuplicates()
      .receive(on: RunLoop.main)
      .sink { [weak self] page in self?.layoutPanel(for: page, animated: true) }
      .store(in: &cancellables)
    store.$mainContentHeight
      .removeDuplicates()
      .receive(on: RunLoop.main)
      .sink { [weak self] _ in
        guard let self, self.isOpen else { return }
        self.layoutPanel(for: self.store.page, animated: false)
      }
      .store(in: &cancellables)
    store.$narrowWidth
      .removeDuplicates()
      .dropFirst()
      .receive(on: RunLoop.main)
      .sink { [weak self] _ in
        guard let self, self.isOpen else { return }
        self.layoutPanel(for: self.store.page, animated: true)
      }
      .store(in: &cancellables)
    store.$manageContentHeight
      .removeDuplicates()
      .receive(on: RunLoop.main)
      .sink { [weak self] _ in
        guard let self, self.isOpen, self.store.page == .manage else { return }
        self.layoutPanel(for: .manage, animated: true)
      }
      .store(in: &cancellables)
    store.$detailContentHeight
      .removeDuplicates()
      .receive(on: RunLoop.main)
      .sink { [weak self] _ in
        guard let self, self.isOpen, case .detail = self.store.page else { return }
        self.layoutPanel(for: self.store.page, animated: true)
      }
      .store(in: &cancellables)
    store.$usageContentHeight
      .removeDuplicates()
      .receive(on: RunLoop.main)
      .sink { [weak self] _ in
        guard let self, self.isOpen, self.store.page == .usage else { return }
        self.layoutPanel(for: .usage, animated: true)
      }
      .store(in: &cancellables)
  }

  private func updateStatusTitle() {
    guard let button = statusItem.button else { return }
    updateStatusIcon()
    let text = store.view?.statusTitle ?? ""
    if text.isEmpty {
      button.attributedTitle = NSAttributedString(string: "")
      button.imagePosition = .imageOnly
    } else {
      button.imagePosition = .imageLeading
      button.attributedTitle = NSAttributedString(
        string: "\u{2009}" + text,
        attributes: [
          .font: NSFont.monospacedDigitSystemFont(ofSize: 13, weight: .regular),
          .baselineOffset: 0,
        ]
      )
    }
    if let view = store.view {
      button.setAccessibilityLabel(text.isEmpty ? "Cindy" : "Cindy, \(text)")
      button.toolTip = view.headlinePrimary
    }
  }

  private func updateStatusIcon() {
    guard let button = statusItem.button else { return }
    let dark = button.effectiveAppearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
    let controlled = store.view?.remotelyControlled == true
    button.image = Logos.statusIcon(dark: dark, controlled: controlled)
  }

  @objc func toggle() {
    if let at = closedByStatusPressAt {
      closedByStatusPressAt = nil
      if ProcessInfo.processInfo.systemUptime - at < 0.6 { return }
    }
    isOpen ? close() : open()
  }

  func open() {
    guard !isOpen else { return }
    // Right after launch the status item may not be placed in the menu bar yet; its rect is
    // then empty or off every screen. Wait a few runloop turns before falling back.
    if statusAnchor() == nil && openRetries < 20 {
      openRetries += 1
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { [weak self] in self?.open() }
      return
    }
    openRetries = 0
    isOpen = true
    closing = false
    store.panelVisible = true
    let panel = ensurePanel()
    let screen = statusAnchor()?.screen ?? NSScreen.main ?? NSScreen.screens.first
    let short = forceShort || (screen.map { $0.visibleFrame.height < Self.shortScreenHeight } ?? false)
    if store.short != short { store.short = short }
    store.page = .main
    store.fillToken += 1
    layoutPanel(for: .main, animated: false)
    let target = panel.frame
    panel.setFrame(target.offsetBy(dx: 0, dy: 6), display: false)
    panel.alphaValue = 0
    panel.makeKeyAndOrderFront(nil)
    openAnimating = true
    NSAnimationContext.runAnimationGroup({ context in
      context.duration = 0.22
      context.timingFunction = CAMediaTimingFunction(controlPoints: 0.22, 1, 0.36, 1)
      panel.animator().alphaValue = 1
      panel.animator().setFrame(target, display: true)
    }, completionHandler: { [weak self] in
      Task { @MainActor in
        guard let self else { return }
        self.openAnimating = false
        // Opening asks main for fresh data, which often lands mid-animation and changes the
        // content height; settle on the latest frame once the animation is done.
        if self.isOpen { self.layoutPanel(for: self.store.page, animated: false) }
      }
    })
    statusItem.button?.highlight(true)
    installMonitors()
    Bridge.emit(["type": "panel", "open": true])
  }

  func close() {
    guard isOpen, let panel else { return }
    isOpen = false
    closing = true
    removeMonitors()
    statusItem.button?.highlight(false)
    NSAnimationContext.runAnimationGroup({ context in
      context.duration = 0.16
      context.timingFunction = CAMediaTimingFunction(name: .easeIn)
      panel.animator().alphaValue = 0
    }, completionHandler: { [weak self] in
      Task { @MainActor in
        guard let self, self.closing else { return }
        panel.orderOut(nil)
        self.closing = false
        self.store.panelVisible = false
        self.store.page = .main
        self.store.draftOrder = nil
      }
    })
    Bridge.emit(["type": "panel", "open": false])
  }

  private func ensurePanel() -> MenubarPanel {
    if let panel { return panel }
    let panel = MenubarPanel(
      contentRect: NSRect(x: 0, y: 0, width: Self.narrowWidth, height: 600),
      styleMask: [.borderless, .nonactivatingPanel, .fullSizeContentView],
      backing: .buffered,
      defer: false
    )
    panel.isFloatingPanel = true
    panel.level = .popUpMenu
    panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .transient, .ignoresCycle]
    panel.isOpaque = false
    panel.backgroundColor = .clear
    panel.hasShadow = true
    panel.hidesOnDeactivate = false
    panel.isMovable = false
    panel.animationBehavior = .none
    panel.delegate = self

    let background = PanelBackgroundView(frame: panel.contentLayoutRect)
    background.autoresizingMask = [.width, .height]
    let hosting = NSHostingView(rootView: PanelRoot(store: store, controller: self))
    hosting.translatesAutoresizingMaskIntoConstraints = true
    hosting.autoresizingMask = [.width, .height]
    hosting.frame = background.bounds
    hosting.sizingOptions = []
    background.addSubview(hosting)
    panel.contentView = background
    self.hosting = hosting
    self.panel = panel
    return panel
  }

  /// The status button's rect on screen, or nil while the item is not placed yet.
  private func statusAnchor() -> (rect: NSRect, screen: NSScreen)? {
    guard let button = statusItem.button, let buttonWindow = button.window else { return nil }
    let rect = buttonWindow.convertToScreen(button.convert(button.bounds, to: nil))
    guard rect.width > 0, rect.height > 0 else { return nil }
    let center = NSPoint(x: rect.midX, y: rect.midY)
    guard let screen = NSScreen.screens.first(where: { $0.frame.contains(center) }) else { return nil }
    return (rect, screen)
  }

  /// Keeps the panel's right edge under the status item (inside the screen) and its top just
  /// below the menu bar. Every page shares the narrow width; a detail page may grow the
  /// panel, and the usage and manage pages take their own height.
  private func targetFrame(for page: Page) -> NSRect? {
    let buttonRect: NSRect
    let screen: NSScreen
    if let anchor = statusAnchor() {
      buttonRect = anchor.rect
      screen = anchor.screen
    } else {
      // Not placed: anchor to the top-right of the main screen, where status items live.
      guard let main = NSScreen.main ?? NSScreen.screens.first else { return nil }
      screen = main
      let frame = main.frame
      buttonRect = NSRect(x: frame.maxX - store.narrowWidth / 2 - Self.sideMargin, y: main.visibleFrame.maxY, width: 0, height: 0)
    }
    let visible = screen.visibleFrame
    let top = min(buttonRect.minY, visible.maxY) - Self.screenGap
    let maxHeight = max(320, min(top - visible.minY - Self.sideMargin, (visible.height * Self.heightShare).rounded(.down)))
    let width = min(store.narrowWidth, visible.width - Self.sideMargin * 2)
    let right = min(visible.maxX - Self.sideMargin, buttonRect.midX + store.narrowWidth / 2)
    let x = max(visible.minX + Self.sideMargin, right - width)
    var natural = store.mainContentHeight > 0 ? store.mainContentHeight : 640
    if case .detail = page { natural = max(natural, store.detailContentHeight) }
    if page == .usage, store.usageContentHeight > 0 { natural = store.usageContentHeight }
    if page == .manage, store.manageContentHeight > 0 { natural = store.manageContentHeight }
    let height = min(maxHeight, natural)
    return NSRect(x: x, y: top - height, width: width, height: height)
  }

  func layoutPanel(for page: Page, animated: Bool) {
    guard let panel, isOpen, let target = targetFrame(for: page) else { return }
    if panel.frame.equalTo(target) { return }
    if openAnimating {
      // Retarget the running open animation instead of being overwritten by it.
      NSAnimationContext.runAnimationGroup { context in
        context.duration = 0.18
        context.timingFunction = CAMediaTimingFunction(controlPoints: 0.22, 1, 0.36, 1)
        panel.animator().setFrame(target, display: true)
      }
      return
    }
    let widthChanged = abs(panel.frame.width - target.width) > 0.5
    let heightChanged = abs(panel.frame.height - target.height) > 0.5
    if animated && (widthChanged || heightChanged) && !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion {
      NSAnimationContext.runAnimationGroup { context in
        // Width changes slide with the page; a height-only change just settles the bottom edge.
        context.duration = widthChanged ? 0.55 : 0.25
        context.timingFunction = CAMediaTimingFunction(controlPoints: 0.22, 1, 0.36, 1)
        context.allowsImplicitAnimation = true
        panel.animator().setFrame(target, display: true)
      }
    } else {
      panel.setFrame(target, display: true)
    }
  }

  private func installMonitors() {
    removeMonitors()
    outsideMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { [weak self] _ in
      Task { @MainActor in
        guard let self, !self.pinned else { return }
        // The menu bar reports a press on our own status item here too, and a quick tap may
        // never reach the item's action. Close on the press and let `toggle` skip that click.
        if self.statusAnchor()?.rect.contains(NSEvent.mouseLocation) == true {
          guard self.isOpen else { return }
          self.close()
          self.closedByStatusPressAt = ProcessInfo.processInfo.systemUptime
          return
        }
        self.close()
      }
    }
    keyMonitor = NSEvent.addLocalMonitorForEvents(matching: [.keyDown]) { [weak self] event in
      guard let self, self.isOpen else { return event }
      return self.handleKey(event) ? nil : event
    }
  }

  private func removeMonitors() {
    if let outsideMonitor { NSEvent.removeMonitor(outsideMonitor) }
    if let keyMonitor { NSEvent.removeMonitor(keyMonitor) }
    outsideMonitor = nil
    keyMonitor = nil
  }

  private func handleKey(_ event: NSEvent) -> Bool {
    let command = event.modifierFlags.contains(.command)
    let key = event.charactersIgnoringModifiers?.lowercased() ?? ""
    if event.keyCode == 53 {
      if store.page == .main { close() } else { store.go(.main) }
      return true
    }
    guard command else { return false }
    switch key {
    case "r":
      store.refresh()
    case "o":
      openApp()
    case ",":
      store.go(.manage)
    case "w":
      close()
    default:
      return false
    }
    return true
  }

  func openApp() {
    Bridge.emit(["type": "open-app"])
    close()
  }

  func emitAndClose(_ payload: [String: Any]) {
    Bridge.emit(payload)
    close()
  }

  func windowDidResignKey(_ notification: Notification) {
    // A press on our own status item takes focus first; its click then toggles the panel
    // closed. Closing here too would let that click reopen it.
    if let event = NSApp.currentEvent,
       event.type == .leftMouseDown || event.type == .rightMouseDown,
       let buttonWindow = statusItem.button?.window,
       event.window === buttonWindow {
      return
    }
    // Clicking another app: behave like a menu.
    if isOpen && !pinned { close() }
  }

  /// Preview mode only: open without a click so screenshots show the panel.
  /// `ready` runs once the requested page is showing, so a snapshot timed from it never
  /// captures the main page instead.
  func openForPreview(page: Page, ready: @escaping () -> Void) {
    pinned = true
    open()
    // `open` may retry until the status item is placed and then shows the main page; switch
    // pages only after it has settled.
    DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { [weak self] in
      guard let self else { return }
      self.store.page = page
      self.layoutPanel(for: page, animated: false)
      ready()
    }
  }
}

// MARK: - Root

struct PanelRoot: View {
  @ObservedObject var store: MenubarStore
  let controller: StatusController

  var body: some View {
    ZStack(alignment: .topTrailing) {
      if !store.panelVisible {
        // Ordered out: render nothing, so no clock or repeating animation keeps running.
      } else if let view = store.view {
        pages(view)
      } else {
        ProgressView().controlSize(.small).frame(maxWidth: .infinity, maxHeight: .infinity)
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topTrailing)
    .background { PanelBackdrop() }
    .overlay(
      RoundedRectangle(cornerRadius: PanelBackgroundView.radius, style: .circular)
        .strokeBorder(Palette.edge, lineWidth: 0.5)
        .allowsHitTesting(false)
    )
    .clipShape(RoundedRectangle(cornerRadius: PanelBackgroundView.radius, style: .circular))
    .foregroundStyle(Palette.ink)
    .environment(\.locale, Locale(identifier: store.locale))
  }

  @ViewBuilder
  private func pages(_ view: MBView) -> some View {
    ZStack(alignment: .topTrailing) {
      if store.page == .main, view.gate != nil {
        GatePage(store: store, controller: controller)
          .frame(width: store.narrowWidth)
          .transition(.asymmetric(
            insertion: .offset(x: -store.narrowWidth * 0.3).combined(with: .opacity),
            removal: .offset(x: -store.narrowWidth * 0.3).combined(with: .opacity)
          ))
      } else if store.page == .main {
        MainPage(store: store, view: view, controller: controller)
          .frame(width: store.narrowWidth)
          .transition(.asymmetric(
            insertion: .offset(x: -store.narrowWidth * 0.3).combined(with: .opacity),
            removal: .offset(x: -store.narrowWidth * 0.3).combined(with: .opacity)
          ))
      }
      if case .detail(let id) = store.page, let detail = view.details[id] {
        DetailPage(store: store, detail: detail, controller: controller)
          .frame(width: store.narrowWidth)
          .transition(.move(edge: .trailing).combined(with: .opacity))
      }
      if store.page == .manage {
        ManagePage(store: store, view: view, controller: controller)
          .frame(width: store.narrowWidth)
          .transition(.move(edge: .trailing).combined(with: .opacity))
      }
      if store.page == .usage {
        UsagePage(store: store, view: view, controller: controller)
          .frame(width: store.narrowWidth)
          .transition(.move(edge: .trailing).combined(with: .opacity))
      }
    }
  }
}

/// Warm tint over the popover material with a faint Heart Orange glow in the top-left corner.
struct PanelBackdrop: View {
  var body: some View {
    ZStack {
      Palette.panelTint
      RadialGradient(colors: [Palette.panelGlow, .clear], center: .topLeading, startRadius: 0, endRadius: 240)
      RadialGradient(colors: [Palette.panelGlow2, .clear], center: UnitPoint(x: 1, y: 0.18), startRadius: 0, endRadius: 220)
    }
    .allowsHitTesting(false)
  }
}

// MARK: - Shared pieces

struct IconButton: View {
  let systemName: String
  let label: String
  var help: String? = nil
  var rotation: Double = 0
  let action: () -> Void
  @State private var hovering = false

  var body: some View {
    Button(action: action) {
      Image(systemName: systemName)
        .font(.system(size: 12, weight: .medium))
        .rotationEffect(.degrees(rotation))
        .frame(width: 28, height: 28)
        .foregroundStyle(hovering ? Palette.ink : Palette.ink2)
        .background(Circle().fill(hovering ? Palette.ink5 : .clear))
        .contentShape(Circle())
    }
    .buttonStyle(.plain)
    .onHover { hovering in withAnimation(Motion.quick) { self.hovering = hovering } }
    .help(help ?? label)
    .accessibilityLabel(label)
  }
}

struct InkPillButton: View {
  let title: String
  var shortcut: String? = nil
  var height: CGFloat = 30
  var fullWidth = false
  var disabled = false
  /// Opening Cindy itself: the logo's red ">" leads the title, slides in when the panel opens,
  /// leans forward on hover and pushes on press.
  var brandMark = false
  var replayToken = 0
  let action: () -> Void
  @State private var hovering = false

  var body: some View {
    // The style draws the pill itself; the label only names the button for VoiceOver.
    Button(action: action) { Text(title) }
      .buttonStyle(InkPillStyle(title: title, shortcut: shortcut, height: height, fullWidth: fullWidth,
                                brandMark: brandMark, hovering: hovering, replayToken: replayToken))
      .disabled(disabled)
      .opacity(disabled ? 0.4 : 1)
      .onHover { hovering in withAnimation(Motion.quick) { self.hovering = hovering } }
  }
}

private struct InkPillStyle: ButtonStyle {
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  let title: String
  let shortcut: String?
  let height: CGFloat
  let fullWidth: Bool
  let brandMark: Bool
  let hovering: Bool
  let replayToken: Int

  func makeBody(configuration: Configuration) -> some View {
    HStack(spacing: 8) {
      if brandMark {
        BrandPromptMark(replayToken: replayToken)
          .offset(x: reduceMotion ? 0 : configuration.isPressed ? 4 : hovering ? 2 : 0)
          .scaleEffect(x: !reduceMotion && configuration.isPressed ? 0.8 : 1, anchor: .trailing)
          .animation(configuration.isPressed ? .easeOut(duration: 0.12) : .spring(response: 0.35, dampingFraction: 0.6), value: configuration.isPressed)
          .animation(.spring(response: 0.35, dampingFraction: 0.6), value: hovering)
          .padding(.trailing, -2)
      }
      Text(title).font(.system(size: 12, weight: .semibold)).lineLimit(1)
      if let shortcut {
        Text(shortcut).font(.system(size: 12, weight: .medium)).opacity(0.55)
      }
    }
    .padding(.leading, brandMark ? 12 : 14)
    .padding(.trailing, 14)
    .frame(height: height)
    .frame(maxWidth: fullWidth ? .infinity : nil)
    .foregroundStyle(Palette.onInk)
    .background(Capsule().fill(Palette.cta))
    .contentShape(Capsule())
    .scaleEffect(configuration.isPressed ? 0.97 : 1)
    .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
  }
}

/// The ">" from the Cindy logo, traced from `cindy-wordmark-*.svg` (normalized to its box).
struct BrandPrompt: Shape {
  func path(in rect: CGRect) -> Path {
    let points: [(CGFloat, CGFloat)] = [
      (0, 0), (1, 0.4354), (1, 0.5636), (0, 1), (0, 0.6551), (0.352, 0.4995), (0, 0.3442),
    ]
    var path = Path()
    for (index, point) in points.enumerated() {
      let p = CGPoint(x: rect.minX + point.0 * rect.width, y: rect.minY + point.1 * rect.height)
      if index == 0 { path.move(to: p) } else { path.addLine(to: p) }
    }
    path.closeSubpath()
    return path
  }
}

struct BrandPromptMark: View {
  let replayToken: Int
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var shown = true

  var body: some View {
    BrandPrompt()
      .fill(Palette.brand)
      .frame(width: 7, height: 11)
      .opacity(shown ? 1 : 0)
      .offset(x: shown ? 0 : -5)
      .accessibilityHidden(true)
      .onAppear { replay() }
      .onChange(of: replayToken) { replay() }
  }

  private func replay() {
    guard !reduceMotion else { shown = true; return }
    var transaction = Transaction()
    transaction.disablesAnimations = true
    withTransaction(transaction) { shown = false }
    DispatchQueue.main.async {
      withAnimation(.timingCurve(0.22, 1, 0.36, 1, duration: 0.7).delay(0.45)) { shown = true }
    }
  }
}

struct PressScaleStyle: ButtonStyle {
  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .scaleEffect(configuration.isPressed ? 0.97 : 1)
      .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
  }
}

struct Tile<Content: View>: View {
  var radius: CGFloat = 14
  @ViewBuilder let content: Content

  var body: some View {
    content
      .background(RoundedRectangle(cornerRadius: radius, style: .circular).fill(Palette.tile))
      .overlay(RoundedRectangle(cornerRadius: radius, style: .circular).strokeBorder(Palette.line, lineWidth: 0.5))
  }
}

/// The one hairline of the panel: 0.5pt in the soft `line` color. (A system `Divider` draws its
/// own darker separator, so an overlay on it only made lines heavier.)
struct Hairline: View {
  var body: some View {
    Rectangle().fill(Palette.line).frame(height: 0.5)
  }
}

/// Fixed bar above or below a scroll area; shows a hairline only while content runs under it.
struct EdgeLine: View {
  let visible: Bool
  var body: some View {
    Rectangle().fill(Palette.line).frame(height: 0.5).opacity(visible ? 1 : 0)
      .animation(Motion.quick, value: visible)
  }
}

private struct ScrollOffsetKey: PreferenceKey {
  static var defaultValue: CGFloat = 0
  static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = nextValue() }
}

private struct ContentHeightKey: PreferenceKey {
  static var defaultValue: CGFloat = 0
  static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = max(value, nextValue()) }
}

/// Scroll view that reports how far it is scrolled and how tall its content is.
struct TrackedScroll<Content: View>: View {
  @Binding var offset: CGFloat
  @Binding var contentHeight: CGFloat
  @ViewBuilder let content: Content
  private let space = UUID().uuidString

  var body: some View {
    GeometryReader { outer in
      ScrollView(.vertical, showsIndicators: false) {
        content
          .background(GeometryReader { inner in
            Color.clear
              .preference(key: ScrollOffsetKey.self, value: -inner.frame(in: .named(space)).minY)
              .preference(key: ContentHeightKey.self, value: inner.size.height)
          })
      }
      .coordinateSpace(name: space)
      .onPreferenceChange(ScrollOffsetKey.self) { offset = $0 }
      .onPreferenceChange(ContentHeightKey.self) { contentHeight = $0 }
      .frame(height: outer.size.height)
    }
  }
}

// MARK: - Tube

struct TubeView: View {
  let fill: Double?
  let level: String
  let reserve: Bool
  let emphasized: Bool
  /// A running task is drawing on this source: the liquid surface ripples gently.
  var active = false
  /// The pointer just came onto the tube: the liquid gives a small nudge, then settles.
  var hovered = false
  let index: Int
  let fillToken: Int
  var height: CGFloat = 104
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var shown = true
  /// Set while the opening slosh plays; the wave clock runs for every tube meanwhile.
  @State private var openedAt: Date?
  // The standing ripple of a source in use eases between levels on the wave clock itself
  // (not through SwiftUI's animator, which a per-frame clock would fight and make pop).
  @State private var rippleFrom: CGFloat = 0
  @State private var rippleGoal: CGFloat = 0
  @State private var rippleChangedAt: Date = .distantPast
  /// Keeps the clock alive while a ripple change eases in or out.
  @State private var rippleEasing = false
  /// Drawn anew every time the panel opens, so no two openings slosh the same way.
  @State private var slosh = SloshProfile.random()
  @State private var nudgedAt: Date?
  @State private var nudgeDirection: CGFloat = 1

  private static let inset: CGFloat = 3
  private static let outerRadius: CGFloat = 13
  /// Peak height of the ripple; small enough that the level still reads exactly.
  private static let rippleAmplitude: CGFloat = 1.5

  // Opening slosh. While the liquid rushes up it stays nearly flat; when it stops, inertia
  // tips the surface from side to side like a damped pendulum (first mode, one side up while
  // the other is down) with a faster, smaller second mode on top, and both decay to still.
  /// Seconds after a tube's own start at which the rising liquid has all but arrived.
  private static let arrival: Double = 0.5
  /// Edge height of the first tilt, in points, for a full tube (less when the tube is lower).
  private static let sloshTilt: CGFloat = 5.0
  /// While rising the surface only shivers this much…
  private static let riseShiver: CGFloat = 0.3
  /// …and rocks a little, quicker and far smaller than the slosh after it stops.
  private static let riseRock: CGFloat = 1.1
  private static let riseRockPeriod: Double = 0.34
  private static let sloshDuration: Double = 4.6
  /// Hover nudge: a small, short sway, a third of the opening slosh.
  private static let nudgeTilt: CGFloat = 1.7
  private static let nudgePeriod: Double = 0.72
  private static let nudgeDecay: Double = 0.5
  private static let nudgeDuration: Double = 2.2

  var body: some View {
    let wellHeight = height - Self.inset * 2
    let fraction = max(0, min(1, fill ?? 0))
    let liquid = fraction > 0 ? max(3, fraction * wellHeight) : 0
    let warn = Palette.level(level)
    ZStack {
      if fill == nil {
        RoundedRectangle(cornerRadius: Self.outerRadius, style: .circular)
          .strokeBorder(Palette.ink4, style: StrokeStyle(lineWidth: 1.5, dash: [4, 3]))
      } else {
        RoundedRectangle(cornerRadius: Self.outerRadius, style: .circular)
          .fill(LinearGradient(colors: [Palette.wellTop, Palette.wellBottom], startPoint: .top, endPoint: .bottom)
            .shadow(.inner(color: Palette.wellShade, radius: 1.5, y: 1)))
        if reserve {
          HatchPattern()
            .stroke(Palette.ink4, lineWidth: 2)
            .clipShape(RoundedRectangle(cornerRadius: Self.outerRadius - Self.inset, style: .circular))
            .padding(Self.inset)
        }
        // Liquid lives in a well inset 3pt on every side; the well's rounded bottom shapes low
        // levels, so the liquid never touches the tube wall.
        VStack(spacing: 0) {
          Spacer(minLength: 0)
          surface(warn: warn)
            .frame(height: liquid)
            .scaleEffect(x: 1, y: shown ? 1 : 0.001, anchor: .bottom)
        }
        .clipShape(RoundedRectangle(cornerRadius: Self.outerRadius - Self.inset, style: .circular))
        .padding(Self.inset)
        .animation(Motion.liquid, value: liquid)
        RoundedRectangle(cornerRadius: Self.outerRadius, style: .circular)
          // The recommended tube: a 1pt secondary-gray outline, quiet enough not to read as a
          // selection; the headline names the source it marks.
          .strokeBorder(emphasized ? Palette.ink2 : Palette.ink4, lineWidth: emphasized ? 1 : 0.5)
      }
    }
    .background(alignment: .bottom) {
      if warn != nil && fill != nil {
        Ellipse()
          .fill(RadialGradient(colors: [(warn ?? Palette.warn).opacity(0.5), .clear], center: .center, startRadius: 0, endRadius: 18))
          .frame(width: 34, height: 14)
          .blur(radius: 4)
          .offset(y: 7)
          .opacity(0.45)
          .allowsHitTesting(false)
      }
    }
    .frame(maxWidth: 40)
    .frame(height: height)
    .onChange(of: fillToken) { replay() }
    .onChange(of: active) { updateRipple() }
    .onChange(of: hovered) { _, isHovered in if isHovered { nudge() } }
    .onAppear {
      replay()
      updateRipple()
    }
  }

  /// The standing ripple at `now`, easing from where it was toward its goal.
  private func rippleLevel(at now: Date) -> CGFloat {
    let duration = rippleGoal > rippleFrom ? 0.8 : 1.4
    let p = max(0, min(1, now.timeIntervalSince(rippleChangedAt) / duration))
    let eased = CGFloat(p * p * (3 - 2 * p))
    return rippleFrom + (rippleGoal - rippleFrom) * eased
  }

  /// Surface state at `now`, including a hover nudge on top of whatever else is moving.
  private func surfaceState(at now: Date, fraction: Double) -> (ripple: CGFloat, tilt: CGFloat, second: CGFloat) {
    var state = baseSurfaceState(at: now, fraction: fraction)
    if let nudgedAt {
      let u = now.timeIntervalSince(nudgedAt)
      if u >= 0, u < Self.nudgeDuration {
        // Fuller tubes sway a little more; even a low one visibly answers the pointer.
        let m = CGFloat(0.35 + 0.65 * fraction)
        state.tilt += nudgeDirection * Self.nudgeTilt * m
          * CGFloat(exp(-u / Self.nudgeDecay) * sin(2 * .pi * u / Self.nudgePeriod))
        state.second -= nudgeDirection * Self.nudgeTilt * 0.3 * m
          * CGFloat(exp(-u / (Self.nudgeDecay * 0.7)) * sin(2 * .pi * u / (Self.nudgePeriod * 0.48)))
      }
    }
    return state
  }

  /// Surface state at `now`: wave amplitude and the side-to-side tilt, both in points.
  private func baseSurfaceState(at now: Date, fraction: Double) -> (ripple: CGFloat, tilt: CGFloat, second: CGFloat) {
    let standing = rippleLevel(at: now)
    guard let openedAt else { return (standing, 0, 0) }
    let t = now.timeIntervalSince(openedAt) - Double(index) * 0.06
    let arrival = Self.arrival + slosh.arrivalShift
    // How far the liquid climbs sets how hard it moves: a nearly full tube swings widely, a
    // low one barely does (momentum grows faster than the level).
    let momentum = CGFloat(max(0.04, pow(fraction, 1.5)))
    if t < arrival {
      // Rising: a small, quick rock that swells mid-climb and is back to level on arrival
      // (the envelope is zero at both ends), handing over smoothly to the slosh.
      let p = max(0, t) / arrival
      let rock = Self.riseRock * CGFloat(0.5 + 0.5 * fraction) * CGFloat(sin(.pi * p))
        * CGFloat(sin(2 * .pi * max(0, t) / Self.riseRockPeriod)) * slosh.direction
      return (max(standing, Self.riseShiver), rock, 0)
    }
    let s = t - arrival
    // Both modes start from zero (sin), so the surface leans away from flat smoothly the
    // moment the liquid stops rather than snapping to a lean.
    let tilt = slosh.direction * slosh.strength * Self.sloshTilt * momentum
      * CGFloat(exp(-s / slosh.decay) * sin(2 * .pi * s / slosh.period))
    let second = -slosh.direction * slosh.secondRatio * Self.sloshTilt * momentum
      * CGFloat(exp(-s / (slosh.decay * 0.7)) * sin(2 * .pi * s / (slosh.period * slosh.secondPeriodRatio)))
    let shiver = Self.riseShiver * CGFloat(exp(-s / 0.6))
    return (max(standing, shiver), tilt, second)
  }

  @ViewBuilder
  private func surface(warn: Color?) -> some View {
    let color = warn ?? Palette.liquid
    // The clock only runs for a source in use; when it stops, the amplitude eases to zero and
    // the frozen phase settles into a flat, still surface.
    TimelineView(.animation(minimumInterval: 1 / 30, paused: !(active || openedAt != nil || rippleEasing || nudgedAt != nil) || reduceMotion)) { context in
      let state = surfaceState(at: context.date, fraction: max(0, min(1, fill ?? 0)))
      LiquidSurface(
        phase: context.date.timeIntervalSinceReferenceDate * 2 * .pi / 3.6 + Double(index) * 1.3,
        amplitude: state.ripple,
        tilt: state.tilt,
        second: state.second
      )
      .fill(color)
    }
  }

  private var rippleTarget: CGFloat { active && !reduceMotion ? Self.rippleAmplitude : 0 }

  private func updateRipple() {
    // While the opening slosh plays the standing ripple waits; the slosh's end calls this.
    guard openedAt == nil, rippleTarget != rippleGoal else { return }
    let now = Date()
    let target = rippleTarget
    rippleFrom = rippleLevel(at: now)
    rippleGoal = target
    rippleChangedAt = now
    rippleEasing = true
    let duration = target > rippleFrom ? 0.8 : 1.4
    DispatchQueue.main.asyncAfter(deadline: .now() + duration + 0.1) {
      if rippleChangedAt == now { rippleEasing = false }
    }
  }

  private func nudge() {
    guard !reduceMotion, fill != nil else { return }
    let now = Date()
    // Sweeping the pointer across the row should not restart a nudge that just began.
    if let nudgedAt, now.timeIntervalSince(nudgedAt) < 0.35 { return }
    nudgeDirection = Bool.random() ? 1 : -1
    nudgedAt = now
    DispatchQueue.main.asyncAfter(deadline: .now() + Self.nudgeDuration + 0.05) {
      if nudgedAt == now { nudgedAt = nil }
    }
  }

  private func replay() {
    guard !reduceMotion else {
      shown = true
      openedAt = nil
      rippleFrom = 0
      rippleGoal = 0
      return
    }
    let delay = Double(index) * 0.06
    let started = Date()
    var transaction = Transaction()
    transaction.disablesAnimations = true
    withTransaction(transaction) {
      shown = false
      openedAt = started
      slosh = SloshProfile.random()
      // The standing ripple restarts from still once the slosh is over.
      rippleFrom = 0
      rippleGoal = 0
    }
    DispatchQueue.main.async {
      withAnimation(Motion.liquid.delay(delay)) { shown = true }
    }
    // The slosh is over once the tilt has decayed; an active source then keeps its ripple.
    DispatchQueue.main.asyncAfter(deadline: .now() + delay + Self.arrival + 0.1 + Self.sloshDuration) {
      guard openedAt == started else { return }
      openedAt = nil
      updateRipple()
    }
  }
}

/// One opening's slosh: which way the surface first leans, how strongly, how fast it swings and
/// how quickly it dies down. Redrawn on every opening so the tubes never repeat themselves.
struct SloshProfile {
  /// +1 leans left-up first, -1 right-up first.
  var direction: CGFloat
  /// Scales the first tilt (0.8...1.15).
  var strength: CGFloat
  var period: Double
  var decay: Double
  var secondRatio: CGFloat
  var secondPeriodRatio: Double
  /// Moves the instant the liquid stops, so the tubes do not all lurch at once.
  var arrivalShift: Double

  static func random() -> SloshProfile {
    SloshProfile(
      direction: Bool.random() ? 1 : -1,
      strength: CGFloat.random(in: 0.8...1.15),
      period: Double.random(in: 0.82...1.12),
      decay: Double.random(in: 1.0...1.5),
      secondRatio: CGFloat.random(in: 0.18...0.4),
      secondPeriodRatio: Double.random(in: 0.4...0.55),
      arrivalShift: Double.random(in: -0.06...0.08)
    )
  }
}

/// Liquid with a gently waving top edge. The wave stays inside the frame (it dips at most
/// twice the amplitude below the top), and zero amplitude is a flat surface.
struct LiquidSurface: Shape {
  var phase: Double
  var amplitude: CGFloat
  /// First slosh mode: the surface leans, left edge up while the right is down (and back).
  var tilt: CGFloat = 0
  /// Second slosh mode: both edges rise while the middle sinks.
  var second: CGFloat = 0

  var animatableData: CGFloat {
    get { amplitude }
    set { amplitude = newValue }
  }

  func path(in rect: CGRect) -> Path {
    var path = Path()
    guard rect.width > 0, rect.height > 0 else { return path }
    let amp = min(amplitude, rect.height / 4)
    let wavelength = Double(rect.width) * 1.35
    func y(_ x: CGFloat) -> CGFloat {
      let k = 2 * Double.pi / wavelength
      let wave = 0.65 * sin(k * Double(x) + phase) + 0.35 * sin(1.7 * k * Double(x) - 1.3 * phase)
      // Both slosh modes average to zero across the width, so the liquid volume is unchanged;
      // the surface may rise above the nominal level (the well clips it).
      let u = Double(x / rect.width)
      let lean = Double(tilt) * (1 - 2 * u)
      let mode2 = Double(second) * cos(2 * Double.pi * u)
      return rect.minY + amp * CGFloat(1 + wave) - CGFloat(lean + mode2)
    }
    path.move(to: CGPoint(x: rect.minX, y: rect.maxY))
    path.addLine(to: CGPoint(x: rect.minX, y: y(0)))
    let steps = 16
    for step in 1...steps {
      let x = rect.width * CGFloat(step) / CGFloat(steps)
      path.addLine(to: CGPoint(x: rect.minX + x, y: y(x)))
    }
    path.addLine(to: CGPoint(x: rect.maxX, y: rect.maxY))
    path.closeSubpath()
    return path
  }
}

struct HatchPattern: Shape {
  func path(in rect: CGRect) -> Path {
    var path = Path()
    let step: CGFloat = 7
    var x = -rect.height
    while x < rect.width {
      path.move(to: CGPoint(x: x, y: rect.maxY))
      path.addLine(to: CGPoint(x: x + rect.height, y: rect.minY))
      x += step
    }
    return path
  }
}

// MARK: - Main page

/// A quiet status strip, tied to the same state and color as the menu-bar dot.
struct RemoteControlStatus: View {
  let title: String
  let detail: String
  let names: [String]
  let actionLabel: String
  let action: () -> Void
  @State private var hovering = false

  private var description: String { names.isEmpty ? detail : names.joined(separator: " · ") }

  var body: some View {
    Button(action: action) {
      HStack(alignment: .center, spacing: 10) {
        Image(systemName: "desktopcomputer")
          .font(.system(size: 16, weight: .regular))
          .foregroundStyle(Palette.ink2)
          .frame(width: 32, height: 32)
          .background(Circle().fill(Palette.ink5))
          .overlay(alignment: .topTrailing) {
            Circle().fill(Palette.remoteControl)
              .frame(width: 6, height: 6)
              .offset(x: -1, y: 1)
          }
          .accessibilityHidden(true)
        VStack(alignment: .leading, spacing: 3) {
          Text(title)
            .font(.system(size: 13, weight: .medium))
            .foregroundStyle(Palette.ink)
          Text(description)
            .font(.system(size: 11))
            .foregroundStyle(Palette.ink2)
            .lineSpacing(2)
            .lineLimit(2)
        }
        .fixedSize(horizontal: false, vertical: true)
        .frame(maxWidth: .infinity, alignment: .leading)
        Image(systemName: "chevron.right")
          .font(.system(size: 10, weight: .medium))
          .foregroundStyle(hovering ? Palette.ink2 : Palette.ink3)
          .accessibilityHidden(true)
      }
      .padding(10)
      .background(RoundedRectangle(cornerRadius: 14, style: .circular).fill(hovering ? Palette.ink5 : .clear))
      .contentShape(Rectangle())
    }
    .buttonStyle(PressScaleStyle())
    .onHover { value in withAnimation(Motion.quick) { hovering = value } }
    .help(description + "\n" + actionLabel)
    .accessibilityLabel(title + ", " + description)
    .accessibilityHint(actionLabel)
  }
}

struct MainPage: View {
  @ObservedObject var store: MenubarStore
  let view: MBView
  let controller: StatusController
  @State private var offset: CGFloat = 0
  @State private var contentHeight: CGFloat = 0
  @State private var topHeight: CGFloat = 0
  @State private var footHeight: CGFloat = 0
  @State private var viewportHeight: CGFloat = 0

  var body: some View {
    VStack(spacing: 0) {
      topBar
        .background(GeometryReader { g in Color.clear.onAppear { topHeight = g.size.height }.onChange(of: g.size.height) { _, h in topHeight = h } })
      EdgeLine(visible: offset > 2)
      TrackedScroll(offset: $offset, contentHeight: $contentHeight) {
        content
      }
      .background(GeometryReader { g in Color.clear.onAppear { viewportHeight = g.size.height }.onChange(of: g.size.height) { _, h in viewportHeight = h } })
      EdgeLine(visible: offset + viewportHeight < contentHeight - 2)
      foot
        .background(GeometryReader { g in Color.clear.onAppear { footHeight = g.size.height }.onChange(of: g.size.height) { _, h in footHeight = h } })
    }
    .onChange(of: contentHeight) { report() }
    .onChange(of: topHeight) { report() }
    .onChange(of: footHeight) { report() }
  }

  private func report() {
    guard contentHeight > 0 else { return }
    let natural = (topHeight + contentHeight + footHeight + 1).rounded(.up)
    if abs(store.mainContentHeight - natural) > 0.5 { store.mainContentHeight = natural }
  }

  private var topBar: some View {
    VStack(spacing: 0) {
      HStack(spacing: 0) {
        Wordmark().frame(height: 13)
        TimelineView(.periodic(from: .now, by: 15)) { context in
          Text(updatedText(now: context.date))
            .font(.system(size: 11))
            .foregroundStyle(Palette.ink3)
            .lineLimit(1)
            .padding(.leading, 8)
        }
        Spacer(minLength: 0)
        RefreshButton(store: store)
      }
      .padding(EdgeInsets(top: 14, leading: 18, bottom: 4, trailing: 12))
      if view.remotelyControlled == true {
        RemoteControlStatus(
          title: store.s("remoteControlTitle"), detail: store.s("remoteControlBody"),
          names: view.remoteControllerNames ?? [], actionLabel: store.s("settings")
        ) { controller.emitAndClose(["type": "open-remote-control-settings"]) }
          .padding(EdgeInsets(top: 0, leading: 8, bottom: 4, trailing: 8))
        Hairline().padding(.horizontal, 18)
      }
    }
  }

  private func updatedText(now: Date) -> String {
    guard let updated = view.updatedAtMs else { return "" }
    let seconds = max(0, now.timeIntervalSince1970 - updated / 1000)
    if seconds < 60 { return store.s("updatedJustNow") }
    if seconds < 3600 { return store.s("updatedMinutes", ["n": String(Int(seconds / 60))]) }
    if seconds < 86400 { return store.s("updatedHours", ["n": String(Int(seconds / 3600))]) }
    return store.s("updatedDays", ["n": String(Int(seconds / 86400))])
  }

  private var content: some View {
    VStack(alignment: .leading, spacing: 0) {
      Headline(
        primary: view.headlinePrimary,
        secondary: view.headlineSecondary,
        alert: view.headlineAlert == true,
        short: store.short
      )
        .padding(EdgeInsets(top: store.short ? 6 : 10, leading: 20, bottom: 0, trailing: 20))

      // Only sources with a level get a tube; the rest (not read yet, pay-as-you-go) are
      // listed as quiet rows so an empty tube never stands in for missing data.
      let measured = view.sources.filter { $0.fill != nil }
      let unmeasured = view.sources.filter { $0.fill == nil }
      if !measured.isEmpty {
        Cells(store: store, cells: measured)
          .padding(.horizontal, 16)
          .padding(.top, store.short ? 10 : 14)
      }
      if !unmeasured.isEmpty {
        UnmeasuredSources(store: store, cells: unmeasured)
          .padding(.horizontal, 10)
          .padding(.top, measured.isEmpty ? 12 : 4)
      }

      Caption(title: store.s("tasks"), detail: view.taskSummary) {
        TaskTotal(tasks: view.tasks, tokenUnit: store.s("tokenUnit"), showsTokens: store.narrowWidth >= 350, replayToken: store.fillToken)
      }
      .padding(EdgeInsets(top: store.short ? 14 : 18, leading: 20, bottom: 6, trailing: 20))

      TaskList(store: store, tasks: view.tasks, controller: controller)
        .padding(.horizontal, 10)

      MonthCard(store: store, view: view)
        .padding(EdgeInsets(top: 8, leading: 12, bottom: 12, trailing: 12))
    }
    .frame(width: store.narrowWidth, alignment: .leading)
  }

  private var foot: some View {
    HStack(spacing: 6) {
      InkPillButton(title: store.s("openApp"), shortcut: "⌘O", brandMark: true, replayToken: store.fillToken) { controller.openApp() }
      Spacer(minLength: 0)
      IconButton(systemName: "gearshape", label: store.s("settings"), help: store.s("settings") + " ⌘,") {
        store.go(.manage)
      }
    }
    .padding(EdgeInsets(top: 8, leading: 12, bottom: 12, trailing: 10))
  }
}

/// Shown before the user signs in or skips sign-in: nothing has been read, so there is
/// nothing to show but the way in.
struct GatePage: View {
  @ObservedObject var store: MenubarStore
  let controller: StatusController

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      Wordmark().frame(height: 13)
        .padding(EdgeInsets(top: 18, leading: 18, bottom: 0, trailing: 18))

      if store.view?.remotelyControlled == true {
        RemoteControlStatus(
          title: store.s("remoteControlTitle"), detail: store.s("remoteControlBody"),
          names: store.view?.remoteControllerNames ?? [], actionLabel: store.s("settings")
        ) { controller.emitAndClose(["type": "open-remote-control-settings"]) }
          .padding(EdgeInsets(top: 8, leading: 8, bottom: 4, trailing: 8))
        Hairline().padding(.horizontal, 18)
      }

      Image(systemName: "person.crop.circle")
        .font(.system(size: 26, weight: .regular))
        .foregroundStyle(Palette.ink3)
        .accessibilityHidden(true)
        .padding(EdgeInsets(top: 22, leading: 20, bottom: 10, trailing: 20))

      Text(store.s("gateTitle"))
        .font(.system(size: 19, weight: .semibold))
        .tracking(-0.3)
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityAddTraits(.isHeader)
        .padding(.horizontal, 20)

      Text(store.s("gateBody"))
        .font(.system(size: 12.5))
        .lineSpacing(2)
        .foregroundStyle(Palette.ink3)
        .fixedSize(horizontal: false, vertical: true)
        .padding(EdgeInsets(top: 6, leading: 20, bottom: 0, trailing: 20))

      HStack(spacing: 6) {
        InkPillButton(title: store.s("openApp"), shortcut: "⌘O", brandMark: true, replayToken: store.fillToken) { controller.openApp() }
        Spacer(minLength: 0)
        IconButton(systemName: "gearshape", label: store.s("settings"), help: store.s("settings") + " ⌘,") {
          store.go(.manage)
        }
      }
      .padding(EdgeInsets(top: 20, leading: 12, bottom: 12, trailing: 10))
    }
    .frame(maxWidth: .infinity, alignment: .topLeading)
    .fixedSize(horizontal: false, vertical: true)
    .background(GeometryReader { g in
      Color.clear
        .onAppear { report(g.size.height) }
        .onChange(of: g.size.height) { _, h in report(h) }
    })
    .frame(maxHeight: .infinity, alignment: .top)
  }

  private func report(_ height: CGFloat) {
    let natural = (height + 1).rounded(.up)
    if natural > 0, abs(store.mainContentHeight - natural) > 0.5 { store.mainContentHeight = natural }
  }
}

struct Wordmark: View {
  @Environment(\.colorScheme) private var colorScheme

  var body: some View {
    if let image = WordmarkAsset.image(dark: colorScheme == .dark) {
      Image(nsImage: image)
        .resizable()
        .interpolation(.high)
        .aspectRatio(contentMode: .fit)
        .accessibilityLabel("Cindy")
    } else {
      Text("Cindy").font(.system(size: 13, weight: .bold)).foregroundStyle(Palette.ink)
    }
  }
}

/// Images and fonts shipped next to the helper binary.
enum HelperAssets {
  static let dir: String = ProcessInfo.processInfo.environment["CINDY_MENUBAR_ASSET_DIR"]
    ?? (CommandLine.arguments.first.map { ($0 as NSString).deletingLastPathComponent } ?? "")

  static func path(_ name: String) -> String { (dir as NSString).appendingPathComponent(name) }
}

/// Barlow Condensed for numbers and the % sign (OFL, shipped next to the helper). Falls back
/// to a smaller system font when the files are missing, so numbers still fit their columns.
enum NumFont {
  private static let faces = ["BarlowCondensed-Light", "BarlowCondensed-Medium", "BarlowCondensed-SemiBold"]
  private(set) static var available = false

  static func register() {
    for face in faces {
      let url = URL(fileURLWithPath: HelperAssets.path(face + ".ttf")) as CFURL
      CTFontManagerRegisterFontsForURL(url, .process, nil)
    }
    available = faces.allSatisfy { NSFont(name: $0, size: 12) != nil }
  }

  static func font(_ size: CGFloat, _ weight: Font.Weight = .semibold) -> Font {
    guard available else { return .system(size: (size * 0.8).rounded(), weight: weight) }
    let face: String
    switch weight {
    case .ultraLight, .thin, .light: face = faces[0]
    case .regular, .medium: face = faces[1]
    default: face = faces[2]
    }
    return .custom(face, fixedSize: size)
  }

  /// A pure number ("53", "$31.17", "12.5k", "98%") takes the number font. Anything that mixes
  /// in words or Chinese ("15天12时后重置", "周四 14:13", "5d 11h") stays entirely in the system
  /// font: a condensed face next to Chinese reads uneven.
  static func adaptive(_ string: String, size: CGFloat, weight: Font.Weight = .semibold, textSize: CGFloat, textWeight: Font.Weight = .medium) -> Text {
    if isPureNumber(string) { return Text(string).font(font(size, weight)) }
    return Text(string).font(.system(size: textSize, weight: textWeight)).monospacedDigit()
  }

  static func isPureNumber(_ string: String) -> Bool {
    var previousDigit = false
    var digits = 0
    for character in string {
      let isDigit = character.isNumber && character.isASCII
      let allowed = isDigit || "$¥€.,:%+-−".contains(character) || (previousDigit && "kKMB".contains(character))
      if !allowed { return false }
      if isDigit { digits += 1 }
      previousDigit = isDigit
    }
    return digits > 0
  }
}

/// The wordmark keeps its red ">" and dot, so it is a full-color pair, not a template image.
enum WordmarkAsset {
  private static let dir = HelperAssets.dir
  private static let light = NSImage(contentsOfFile: (dir as NSString).appendingPathComponent("wordmark-light.png"))
  private static let dark = NSImage(contentsOfFile: (dir as NSString).appendingPathComponent("wordmark-dark.png"))

  static func image(dark isDark: Bool) -> NSImage? {
    isDark ? (dark ?? light) : (light ?? dark)
  }
}

struct RefreshButton: View {
  @ObservedObject var store: MenubarStore
  @State private var angle: Double = 0

  var body: some View {
    IconButton(systemName: "arrow.clockwise", label: store.s("refresh"), help: store.s("refresh") + " ⌘R", rotation: angle) {
      store.refresh()
    }
    .onChange(of: store.refreshing) { _, refreshing in
      guard refreshing else { return }
      withAnimation(.timingCurve(0.4, 0.1, 0.3, 1, duration: 0.9)) { angle += 360 }
    }
  }
}

struct Headline: View {
  let primary: String
  let secondary: String?
  var alert = false
  var short = false

  var body: some View {
    VStack(alignment: .leading, spacing: 1) {
      Text(primary)
        .font(.system(size: short ? 19 : 21, weight: .semibold))
        .tracking(-0.5)
        .lineSpacing(1)
      if let secondary {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
          if alert {
            // Centered on the x-height of the first line, so it sits right on wrapped text too.
            Circle()
              .fill(Palette.warn)
              .frame(width: 7, height: 7)
              .alignmentGuide(.firstTextBaseline) { $0[.bottom] + (short ? 1.5 : 2) }
          }
          Text(secondary)
            .font(.system(size: short ? 14.5 : 16, weight: .semibold))
            .tracking(-0.3)
            .foregroundStyle(Palette.ink3)
        }
      }
    }
    .fixedSize(horizontal: false, vertical: true)
    .accessibilityElement(children: .combine)
    .accessibilityAddTraits(.isHeader)
  }
}

struct Caption<Trailing: View>: View {
  let title: String
  let detail: String
  @ViewBuilder let trailing: Trailing

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: 8) {
      Text(title).font(.system(size: 12.5, weight: .semibold)).tracking(-0.1).lineLimit(1).fixedSize()
      Text(detail).font(.system(size: 11.5)).foregroundStyle(Palette.ink3).monospacedDigit().lineLimit(1)
      Spacer(minLength: 4)
      trailing
    }
  }
}

struct Cells: View {
  @ObservedObject var store: MenubarStore
  let cells: [MBCell]

  var body: some View {
    HStack(alignment: .top, spacing: cells.count > 6 ? 4 : 8) {
      ForEach(Array(cells.enumerated()), id: \.element.id) { index, cell in
        CellView(cell: cell, index: index, fillToken: store.fillToken, tubeHeight: store.short ? 82 : 104) {
          store.go(.detail(cell.id))
        }
      }
    }
  }
}

/// Sources without a level: logo, name and why there is no tube, opening the detail page.
struct UnmeasuredSources: View {
  @ObservedObject var store: MenubarStore
  let cells: [MBCell]

  var body: some View {
    VStack(spacing: 2) {
      ForEach(cells) { cell in
        UnmeasuredRow(cell: cell) { store.go(.detail(cell.id)) }
      }
    }
  }
}

struct UnmeasuredRow: View {
  let cell: MBCell
  let action: () -> Void
  @State private var hovering = false

  private var status: String {
    [cell.valueLabel, cell.when]
      .compactMap { $0 }
      .filter { !$0.isEmpty && $0 != "—" }
      .joined(separator: " · ")
  }

  var body: some View {
    Button(action: action) {
      HStack(spacing: 10) {
        LogoView(svg: cell.logoSvg, size: 12)
          .frame(width: 24, height: 24)
          .background(RoundedRectangle(cornerRadius: 7, style: .circular).fill(Palette.ink5))
        Text(cell.name)
          .font(.system(size: 12.5, weight: .semibold))
          .tracking(-0.1)
          .lineLimit(1)
        Spacer(minLength: 8)
        Text(status)
          .font(.system(size: 11.5))
          .foregroundStyle(Palette.ink3)
          .lineLimit(1)
        Image(systemName: "chevron.right")
          .font(.system(size: 10, weight: .semibold))
          .foregroundStyle(Palette.ink4)
      }
      .padding(EdgeInsets(top: 4, leading: 10, bottom: 4, trailing: 10))
      .background(RoundedRectangle(cornerRadius: 10, style: .circular).fill(hovering ? Palette.ink5 : .clear))
      .contentShape(RoundedRectangle(cornerRadius: 10, style: .circular))
    }
    .buttonStyle(.plain)
    .onHover { hovering in withAnimation(.easeOut(duration: 0.15)) { self.hovering = hovering } }
    .accessibilityLabel(cell.accessibilityLabel)
  }
}

struct CellView: View {
  let cell: MBCell
  let index: Int
  let fillToken: Int
  var tubeHeight: CGFloat = 96
  let action: () -> Void
  @State private var hovering = false

  var body: some View {
    Button(action: action) {
      VStack(spacing: 7) {
        valueLabel.frame(height: 22, alignment: .bottom)
        TubeView(
          fill: cell.kind == "payg" ? nil : cell.fill,
          level: cell.level,
          reserve: cell.reserve,
          emphasized: cell.emphasized,
          active: cell.active == true,
          hovered: hovering,
          index: index,
          fillToken: fillToken,
          height: tubeHeight
        )
        VStack(spacing: 4) {
          LogoView(svg: cell.logoSvg, size: 12)
          Text(cell.name)
            .font(.system(size: 10.5))
            .foregroundStyle(Palette.ink2)
            .lineLimit(1)
            .truncationMode(.tail)
        }
        NumFont.adaptive(cell.when, size: 12, weight: .medium, textSize: 10)
          .foregroundStyle(Palette.level(cell.whenLevel) ?? Palette.ink2)
          .lineLimit(1)
          .minimumScaleFactor(0.8)
          .frame(height: 15)
          .padding(.top, -4)
      }
      .padding(.top, 4)
      .padding(.bottom, 2)
      .frame(maxWidth: .infinity)
      .contentShape(Rectangle())
      .offset(y: hovering ? -3 : 0)
    }
    .buttonStyle(CellPressStyle())
    .onHover { hovering in
      withAnimation(.timingCurve(0.22, 1, 0.36, 1, duration: 0.25)) { self.hovering = hovering }
    }
    .accessibilityLabel(cell.accessibilityLabel)
  }

  @ViewBuilder
  private var valueLabel: some View {
    if let value = cell.value {
      // The % sign uses the number font at about 60% of the value, on the same baseline.
      HStack(alignment: .firstTextBaseline, spacing: 1) {
        CountUpText(text: value, font: NumFont.font(cell.kind == "balance" ? 16 : 18), replayToken: fillToken, delay: Double(index) * 0.06)
          .lineLimit(1)
          .minimumScaleFactor(0.75)
        if let unit = cell.valueUnit {
          Text(unit).font(NumFont.font(11)).foregroundStyle(Palette.ink3)
        }
      }
      .monospacedDigit()
      .foregroundStyle(Palette.level(cell.level) ?? Palette.ink)
      .animation(Motion.quick, value: value)
    } else if let label = cell.valueLabel {
      Text(label)
        .font(.system(size: 10.5, weight: .semibold))
        .foregroundStyle(Palette.ink2)
        .lineLimit(1)
        .minimumScaleFactor(0.85)
        .padding(.top, 3)
    }
  }
}

/// A plain number ("53", "$31.17", "$20.0k") counts up from zero each time the panel opens
/// (`replayToken`), alongside the rising liquid. The final text reserves the width, so the
/// count never shifts its neighbours; anything that is not a plain number shows as-is.
struct CountUpText: View {
  let text: String
  let font: Font
  let replayToken: Int
  var delay: Double = 0
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var progress: Double = 1

  var body: some View {
    if let parts = CountUpParts(text) {
      Text(text)
        .opacity(0)
        .modifier(CountUpModifier(progress: progress, parts: parts))
        .font(font.monospacedDigit())
        .onAppear { replay() }
        .onChange(of: replayToken) { replay() }
    } else {
      Text(text).font(font.monospacedDigit())
    }
  }

  private func replay() {
    guard !reduceMotion else { progress = 1; return }
    var transaction = Transaction()
    transaction.disablesAnimations = true
    withTransaction(transaction) { progress = 0 }
    DispatchQueue.main.async {
      withAnimation(Motion.liquid.delay(delay)) { progress = 1 }
    }
  }
}

private struct CountUpModifier: ViewModifier, Animatable {
  var progress: Double
  let parts: CountUpParts

  var animatableData: Double {
    get { progress }
    set { progress = newValue }
  }

  /// The visible count is laid out in the hidden final text's frame and inherits the same
  /// line limit and scale factor, so a long value shrinks together with its placeholder.
  func body(content: Content) -> some View {
    content.overlay(alignment: .trailing) {
      Text(parts.render(progress)).accessibilityHidden(true)
    }
  }
}

/// "$20.0k" → prefix "$", value 20.0 with one decimal, suffix "k".
struct CountUpParts: Equatable {
  let prefix: String
  let value: Double
  let decimals: Int
  let grouped: Bool
  let suffix: String

  private static let pattern = try? NSRegularExpression(pattern: "^([^0-9]*)([0-9][0-9,]*(?:\\.[0-9]+)?)([^0-9]*)$")

  init?(_ text: String) {
    let range = NSRange(text.startIndex..., in: text)
    guard let match = Self.pattern?.firstMatch(in: text, range: range),
          let prefixRange = Range(match.range(at: 1), in: text),
          let numberRange = Range(match.range(at: 2), in: text),
          let suffixRange = Range(match.range(at: 3), in: text)
    else { return nil }
    let number = String(text[numberRange])
    guard let value = Double(number.replacingOccurrences(of: ",", with: "")) else { return nil }
    prefix = String(text[prefixRange])
    suffix = String(text[suffixRange])
    self.value = value
    decimals = number.split(separator: ".").dropFirst().first?.count ?? 0
    grouped = number.contains(",")
  }

  func render(_ progress: Double) -> String {
    let current = value * max(0, min(1, progress))
    let body: String
    if grouped {
      let formatter = NumberFormatter()
      formatter.numberStyle = .decimal
      formatter.locale = Locale(identifier: "en_US")
      formatter.minimumFractionDigits = decimals
      formatter.maximumFractionDigits = decimals
      body = formatter.string(from: NSNumber(value: current)) ?? String(format: "%.\(decimals)f", current)
    } else {
      body = String(format: "%.\(decimals)f", current)
    }
    return prefix + body + suffix
  }
}

/// Pressing a source squeezes it a little, then it springs back as the detail page opens.
struct CellPressStyle: ButtonStyle {
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .scaleEffect(!reduceMotion && configuration.isPressed ? 0.95 : 1)
      .animation(configuration.isPressed ? .easeOut(duration: 0.1) : .spring(response: 0.35, dampingFraction: 0.55), value: configuration.isPressed)
  }
}

// MARK: - Tasks

struct TaskTotal: View {
  let tasks: [MBTask]
  let tokenUnit: String
  /// A narrow panel keeps just the money; each task row still shows its tokens.
  var showsTokens = true
  var replayToken = 0

  /// Today's total reads larger than each task's own amount below it.
  var body: some View {
    let money = tasks.reduce(0) { $0 + $1.value }
    let tokens = tasks.reduce(0) { $0 + $1.tokens }
    // Tokens first, then the amount: the amount ends flush with the task amounts below, so the
    // two columns line up. Without tokens (a narrow panel) the amount alone sits at the right.
    HStack(alignment: .firstTextBaseline, spacing: 0) {
      if showsTokens {
        Text("\(Fmt.tokens(tokens)) \(tokenUnit) · ")
          .font(.system(size: 11.5))
          .foregroundStyle(Palette.ink3)
          .monospacedDigit()
      }
      CountUpText(text: Fmt.money(money), font: NumFont.font(19), replayToken: replayToken)
        .foregroundStyle(Palette.ink)
    }
    .lineLimit(1)
  }
}

struct TaskList: View {
  @ObservedObject var store: MenubarStore
  let tasks: [MBTask]
  let controller: StatusController

  var body: some View {
    let sorted = tasks.sorted { $0.value > $1.value }
    let total = max(0.0001, sorted.reduce(0) { $0 + $1.value })
    // A short screen keeps two rows; the rest are one click away on the usage page.
    let shown = store.short ? 2 : 3
    let top = Array(sorted.prefix(shown))
    let rest = Array(sorted.dropFirst(shown))
    VStack(spacing: 0) {
      if sorted.isEmpty {
        Text(store.s("noTasksToday"))
          .font(.system(size: 11.5))
          .foregroundStyle(Palette.ink3)
          .frame(maxWidth: .infinity, alignment: .leading)
          .padding(.horizontal, 10)
          .padding(.vertical, 4)
      }
      ForEach(top) { task in
        TaskRow(store: store, task: task, share: task.value / total) {
          controller.emitAndClose(["type": "open-session", "sessionId": task.sessionId])
        }
      }
      if !rest.isEmpty {
        MoreRow(
          label: store.s("moreTasks", ["n": String(rest.count)]),
          value: Fmt.money(rest.reduce(0) { $0 + $1.value })
        ) {
          store.usageList = .tasks
          store.go(.usage)
        }
        .padding(.horizontal, 10)
      }
    }
  }
}

struct TaskRow: View {
  @ObservedObject var store: MenubarStore
  let task: MBTask
  let share: Double
  let action: () -> Void
  @State private var hovering = false
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    Button(action: action) {
      HStack(alignment: .center, spacing: 10) {
        TaskIcon(svg: task.logoSvg, running: task.running)
        // Two baseline-aligned lines: the amount sits on the title's baseline and the share on
        // the meta line's, so the number font and the system text read as one row.
        VStack(alignment: .leading, spacing: 0) {
          HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(task.title)
              .font(.system(size: 12.5, weight: .semibold))
              .tracking(-0.1)
              .lineLimit(1)
              .frame(maxWidth: .infinity, alignment: .leading)
            CountUpText(text: Fmt.money(task.value), font: NumFont.font(14), replayToken: store.fillToken, delay: 0.12)
              .fixedSize()
          }
          HStack(alignment: .firstTextBaseline, spacing: 8) {
            metaLine
              .frame(maxWidth: .infinity, alignment: .leading)
            Text("\(Int((share * 100).rounded()))%")
              .font(NumFont.font(11, .medium))
              .foregroundStyle(Palette.ink3)
              .monospacedDigit()
              .fixedSize()
          }
        }
      }
      .padding(EdgeInsets(top: 6, leading: 10, bottom: 8, trailing: 10))
      .background(alignment: .bottomLeading) { shareBar }
      .background(RoundedRectangle(cornerRadius: 12, style: .circular).fill(hovering ? Palette.ink5 : .clear))
      .contentShape(RoundedRectangle(cornerRadius: 12, style: .circular))
    }
    .buttonStyle(.plain)
    .onHover { hovering in withAnimation(.easeOut(duration: 0.15)) { self.hovering = hovering } }
    .help(task.title)
    .accessibilityLabel("\(task.title), \(Fmt.money(task.value))")
  }

  private var shareBar: some View {
    GeometryReader { geometry in
      // Starts under the title: 10pt inset + 28pt icon + 10pt gap.
      let width = geometry.size.width - 48 - 10
      ZStack(alignment: .leading) {
        Capsule().fill(Palette.ink5)
        ShareFill(running: task.running && !reduceMotion).frame(width: max(4, width * share))
      }
      .frame(width: max(0, width), height: 2)
      .offset(x: 48, y: geometry.size.height - 3 - 2)
    }
  }

  @ViewBuilder
  private var metaLine: some View {
    if task.running, let started = task.startedAtMs {
      TimelineView(.periodic(from: .now, by: 1)) { context in
        HStack(spacing: 0) {
          BreathingDot(animate: !reduceMotion)
            .padding(.trailing, 5)
          Text(store.s("running") + " " + Fmt.clock(context.date.timeIntervalSince1970 - started / 1000))
            .fontWeight(.semibold)
            .foregroundStyle(Palette.ink2)
          Text(" · " + task.meta).foregroundStyle(Palette.ink3)
        }
        .font(.system(size: 10.5))
        .monospacedDigit()
        .lineLimit(1)
      }
    } else {
      Text(task.idleStatus + " · " + task.meta)
        .font(.system(size: 10.5))
        .foregroundStyle(Palette.ink3)
        .monospacedDigit()
        .lineLimit(1)
    }
  }
}

/// A task's share of today's value. While it runs, a soft highlight travels along the bar:
/// tokens are being spent right now.
struct ShareFill: View {
  let running: Bool

  var body: some View {
    if running {
      TimelineView(.animation(minimumInterval: 1 / 30)) { context in
        let t = context.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 1.8) / 1.8
        Capsule()
          .fill(LinearGradient(
            stops: [
              .init(color: Palette.ink3, location: 0),
              .init(color: Palette.ink, location: 0.5),
              .init(color: Palette.ink3, location: 1),
            ],
            startPoint: UnitPoint(x: -1 + 2 * t, y: 0.5),
            endPoint: UnitPoint(x: 2 * t, y: 0.5)
          ))
      }
    } else {
      Capsule().fill(Palette.ink3)
    }
  }
}

struct TaskIcon: View {
  let svg: String
  let running: Bool
  @State private var pulse = false
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    ZStack {
      RoundedRectangle(cornerRadius: 9, style: .circular).fill(Palette.tile)
      RoundedRectangle(cornerRadius: 9, style: .circular).strokeBorder(Palette.line, lineWidth: 0.5)
      LogoView(svg: svg, size: 13)
      if running && !reduceMotion {
        RoundedRectangle(cornerRadius: 11, style: .circular)
          .strokeBorder(Palette.ink3, lineWidth: 1)
          .padding(-3)
          .scaleEffect(pulse ? 1.12 : 0.92)
          .opacity(pulse ? 0 : 0.7)
          .onAppear {
            withAnimation(.easeOut(duration: 2.2).repeatForever(autoreverses: false)) { pulse = true }
          }
      }
    }
    .frame(width: 28, height: 28)
  }
}

struct BreathingDot: View {
  let animate: Bool
  var color: Color = Palette.ink2
  var size: CGFloat = 5
  @State private var dim = false

  var body: some View {
    Circle()
      .fill(color)
      .frame(width: size, height: size)
      .opacity(dim ? 0.2 : 1)
      .onAppear {
        guard animate else { return }
        withAnimation(.easeInOut(duration: 0.8).repeatForever(autoreverses: true)) { dim = true }
      }
  }
}

struct MoreRow: View {
  let label: String
  let value: String
  let action: () -> Void
  @State private var hovering = false

  var body: some View {
    Button(action: action) {
      HStack {
        Text(label)
        Spacer()
        Text(value + " ›").monospacedDigit()
      }
      .font(.system(size: 11.5))
      .foregroundStyle(hovering ? Palette.ink : Palette.ink3)
      .padding(.vertical, 4)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .onHover { hovering in withAnimation(Motion.quick) { self.hovering = hovering } }
  }
}

// MARK: - Month card

struct MonthCard: View {
  @ObservedObject var store: MenubarStore
  let view: MBView
  @State private var hovering = false

  var body: some View {
    let scope = view.settings.scope
    let data = view.usage.scopes[scope] ?? view.usage.scopes["all"]
    let last = Array((data?.daily ?? []).suffix(30))
    let days = Array(view.usage.days.suffix(30))
    let total = last.reduce(0) { $0 + $1.money.reduce(0, +) }
    Button {
      store.usageList = .models
      store.go(.usage)
    } label: {
      HStack(spacing: 12) {
        VStack(alignment: .leading, spacing: 0) {
          Text(store.s(scope == "local" ? "monthScopeLocal" : "monthScopeAll"))
            .font(.system(size: 10.5))
            .foregroundStyle(Palette.ink3)
            .lineLimit(1)
          CountUpText(text: Fmt.money(total), font: NumFont.font(22), replayToken: store.fillToken, delay: 0.2)
            .lineLimit(1)
        }
        .fixedSize()
        UsageChart(days: days, daily: last, money: true, compact: true, selection: .constant(nil))
          .frame(height: 28)
        HStack(spacing: 4) {
          Text(store.s("expand")).lineLimit(1)
          Image(systemName: "arrow.up.right").font(.system(size: 8.5, weight: .semibold))
        }
        .font(.system(size: 11.5, weight: .semibold))
        .foregroundStyle(Palette.ink2)
        .fixedSize()
      }
      .padding(EdgeInsets(top: 9, leading: 12, bottom: 9, trailing: 12))
      .background(RoundedRectangle(cornerRadius: 14, style: .circular).fill(Palette.tile))
      .overlay(RoundedRectangle(cornerRadius: 14, style: .circular).strokeBorder(Palette.line, lineWidth: 0.5))
      .contentShape(RoundedRectangle(cornerRadius: 14, style: .circular))
      .offset(y: hovering ? -1 : 0)
    }
    .buttonStyle(.plain)
    .onHover { hovering in withAnimation(Motion.quick) { self.hovering = hovering } }
    .accessibilityLabel(store.s("expandUsage"))
  }
}

// MARK: - Usage chart (Swift Charts)

struct UsagePoint: Identifiable {
  let id: String
  let date: Date
  let harness: String
  let value: Double
}

/// Harness stacking order, bottom to top: Codex, Claude Code, Pi.
let harnessOrder: [(index: Int, key: String)] = [(1, "codex"), (0, "claude-code"), (2, "pi")]

struct UsageChart: View {
  let days: [String]
  let daily: [MBDaily]
  let money: Bool
  let compact: Bool
  @Binding var selection: Int?
  var axisLabels: [(Int, String)] = []

  var body: some View {
    let count = min(days.count, daily.count)
    let dates = days.suffix(count).map(Fmt.day)
    let rows = Array(daily.suffix(count))
    let points = harnessOrder.flatMap { harness in
      (0..<count).map { i in
        UsagePoint(
          id: "\(harness.key)-\(i)",
          date: dates[i],
          harness: harness.key,
          value: money ? rows[i].money[harness.index] : rows[i].tokens[harness.index]
        )
      }
    }
    let totals = (0..<count).map { i in
      money ? rows[i].money.reduce(0, +) : rows[i].tokens.reduce(0, +)
    }
    let maxTotal = max(totals.max() ?? 0, 0.0001) * 1.08
    Chart {
      ForEach(points) { point in
        AreaMark(
          x: .value("Day", point.date),
          y: .value("Value", point.value),
          stacking: .standard
        )
        .foregroundStyle(by: .value("Harness", point.harness))
        .interpolationMethod(.monotone)
      }
      ForEach(0..<count, id: \.self) { i in
        LineMark(x: .value("Day", dates[i]), y: .value("Total", totals[i]), series: .value("Series", "total"))
          .foregroundStyle(Palette.ink.opacity(0.55))
          .lineStyle(StrokeStyle(lineWidth: compact ? 1 : 1.2))
          .interpolationMethod(.monotone)
      }
      if let selection, selection < count {
        RuleMark(x: .value("Day", dates[selection]))
          .foregroundStyle(Palette.ink3)
          .lineStyle(StrokeStyle(lineWidth: 1))
        PointMark(x: .value("Day", dates[selection]), y: .value("Total", totals[selection]))
          .symbol {
            Circle()
              .fill(Palette.ink)
              .frame(width: 8, height: 8)
              .overlay(Circle().stroke(Color(nsColor: .windowBackgroundColor), lineWidth: 2))
          }
      }
    }
    .chartForegroundStyleScale([
      "codex": gradient(Palette.codex),
      "claude-code": gradient(Palette.claude),
      "pi": gradient(Palette.pi),
    ])
    .chartLegend(.hidden)
    .chartYAxis(.hidden)
    .chartYScale(domain: 0...maxTotal)
    .chartXAxis {
      if compact || axisLabels.isEmpty {
        AxisMarks { _ in }
      } else {
        AxisMarks(values: axisLabels.map { dates[$0.0] }) { value in
          AxisValueLabel(anchor: .top) {
            if let date = value.as(Date.self), let label = axisLabels.first(where: { dates[$0.0] == date })?.1 {
              Text(label).font(.system(size: 10)).foregroundStyle(Palette.ink3)
            }
          }
        }
      }
    }
    .chartPlotStyle { plot in plot.clipped(antialiased: true) }
    .chartOverlay { proxy in
      if !compact {
        GeometryReader { geometry in
          Rectangle()
            .fill(Color.clear)
            .contentShape(Rectangle())
            .onContinuousHover { phase in
              switch phase {
              case .active(let location):
                guard let plotFrame = proxy.plotFrame else { return }
                let origin = geometry[plotFrame].origin
                let x = location.x - origin.x
                guard let date: Date = proxy.value(atX: x) else { return }
                let index = nearestIndex(dates: dates, to: date)
                if selection != index { selection = index }
              case .ended:
                selection = nil
              }
            }
        }
      }
    }
    .accessibilityHidden(compact)
  }

  private func gradient(_ color: Color) -> LinearGradient {
    LinearGradient(colors: [color.opacity(0.95), color.opacity(0.55)], startPoint: .top, endPoint: .bottom)
  }

  private func nearestIndex(dates: [Date], to date: Date) -> Int {
    var best = 0
    var bestDistance = Double.greatestFiniteMagnitude
    for (i, candidate) in dates.enumerated() {
      let distance = abs(candidate.timeIntervalSince(date))
      if distance < bestDistance {
        best = i
        bestDistance = distance
      }
    }
    return best
  }
}

// MARK: - Detail page

struct RingArc: Shape {
  var progress: Double
  let lineWidth: CGFloat

  var animatableData: Double {
    get { progress }
    set { progress = newValue }
  }

  /// The visible arc including both round caps spans exactly 0...progress of the circle:
  /// the stroke starts half a line width after 12 o'clock and ends half a line width early.
  /// A full ring uses butt caps so two round caps never meet; zero draws nothing.
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

struct RingsView: View {
  let rings: [MBRing]
  let fillToken: Int
  var size: CGFloat = 196
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var shown = true

  var body: some View {
    // Line width follows the ring size so the nested rings keep the same proportions.
    let lineWidth: CGFloat = (size * (rings.count > 1 ? 0.06 : 0.068)).rounded()
    let gap: CGFloat = 3
    ZStack {
      ForEach(Array(rings.enumerated()), id: \.offset) { index, ring in
        let inset = 3 + CGFloat(index) * (lineWidth + gap)
        ZStack {
          Circle()
            .strokeBorder(Palette.ink5, lineWidth: lineWidth)
          RingArc(progress: shown ? max(0, min(1, ring.fraction)) : 0, lineWidth: lineWidth)
            .fill(Palette.named(ring.color))
            .animation(Motion.fill.delay(Double(index) * 0.06), value: shown)
            .animation(Motion.fill, value: ring.fraction)
        }
        .padding(inset)
      }
    }
    .frame(width: size, height: size)
    .onAppear { replay() }
    .onChange(of: fillToken) { replay() }
  }

  private func replay() {
    guard !reduceMotion else { shown = true; return }
    var transaction = Transaction()
    transaction.disablesAnimations = true
    withTransaction(transaction) { shown = false }
    DispatchQueue.main.async { shown = true }
  }
}

struct DetailPage: View {
  @ObservedObject var store: MenubarStore
  let detail: MBDetail
  let controller: StatusController
  @State private var offset: CGFloat = 0
  @State private var contentHeight: CGFloat = 0
  @State private var headerHeight: CGFloat = 0
  @State private var footerHeight: CGFloat = 0

  /// Back and the action stay put; only the body between them scrolls when the screen is short.
  var body: some View {
    VStack(spacing: 0) {
    HStack(spacing: 6) {
      IconButton(systemName: "chevron.left", label: store.s("back")) { store.go(.main) }
      LogoView(svg: detail.logoSvg, size: 13)
      Text(detail.title).font(.system(size: 13, weight: .semibold)).lineLimit(1)
      Text(detail.plan).font(.system(size: 10.5, weight: .medium)).foregroundStyle(Palette.ink3).lineLimit(1)
      Spacer(minLength: 0)
    }
    .padding(EdgeInsets(top: 12, leading: 10, bottom: 10, trailing: 14))
        .background(GeometryReader { g in
          Color.clear
            .onAppear { headerHeight = g.size.height }
            .onChange(of: g.size.height) { _, h in headerHeight = h }
        })
      EdgeLine(visible: offset > 2)
      TrackedScroll(offset: $offset, contentHeight: $contentHeight) {
        VStack(alignment: .leading, spacing: 0) {

        let ring: CGFloat = store.short ? 160 : 188
        ZStack {
          RingsView(rings: detail.rings, fillToken: store.fillToken, size: ring)
          VStack(spacing: 3) {
            HStack(alignment: .firstTextBaseline, spacing: 2) {
              CountUpText(text: detail.bigValue, font: NumFont.font((detail.bigCompact ? 48 : 68) * ring / 188, .medium), replayToken: store.fillToken)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
              if let unit = detail.bigUnit {
                Text(unit).font(NumFont.font(24 * ring / 188, .medium)).foregroundStyle(Palette.ink3)
              }
            }
            .monospacedDigit()
            .foregroundStyle(detail.bigColor.map(Palette.named) ?? Palette.ink)
            Text(detail.bigCaption).font(.system(size: 11)).foregroundStyle(Palette.ink3).lineLimit(1)
          }
          .frame(maxWidth: ring - 44)
        }
        .frame(maxWidth: .infinity)
        .accessibilityElement(children: .combine)

        if !detail.legend.isEmpty {
          HStack(spacing: 12) {
            ForEach(detail.legend, id: \.self) { item in
              HStack(spacing: 5) {
                Circle().fill(Palette.named(item.color)).frame(width: 7, height: 7)
                Text(item.label).lineLimit(1)
              }
            }
          }
          .font(.system(size: 11))
          .foregroundStyle(Palette.ink2)
          .monospacedDigit()
          .frame(maxWidth: .infinity)
          .padding(.horizontal, 16)
          .padding(.top, 10)
        }

        sayText
          .font(.system(size: 15.5, weight: .semibold))
          .tracking(-0.3)
          .lineSpacing(2)
          .fixedSize(horizontal: false, vertical: true)
          .padding(EdgeInsets(top: 14, leading: 20, bottom: 0, trailing: 20))

        LazyVGrid(columns: [GridItem(.flexible(), spacing: 8), GridItem(.flexible(), spacing: 8)], spacing: 8) {
          ForEach(detail.facts, id: \.self) { fact in
            FactCard(fact: fact)
          }
        }
        .padding(EdgeInsets(top: 14, leading: 14, bottom: 14, trailing: 14))

        }
        .frame(width: store.narrowWidth, alignment: .leading)
      }
      // The panel may be taller than this page (it keeps the main page's height); the
      // action then follows the content instead of sinking to the bottom.
      .frame(maxHeight: contentHeight > 0 ? contentHeight : nil)
    InkPillButton(title: detail.actionLabel, height: 32, fullWidth: true, disabled: detail.action.kind == "none") {
      controller.emitAndClose(["type": "detail-action", "sourceId": detail.id])
    }
    .padding(EdgeInsets(top: 0, leading: 14, bottom: 14, trailing: 14))
        .background(GeometryReader { g in
          Color.clear
            .onAppear { footerHeight = g.size.height }
            .onChange(of: g.size.height) { _, h in footerHeight = h }
        })
    }
    .frame(maxHeight: .infinity, alignment: .top)
    .onChange(of: contentHeight) { report() }
    .onChange(of: headerHeight) { report() }
    .onChange(of: footerHeight) { report() }
  }

  private func report() {
    guard contentHeight > 0 else { return }
    let natural = (headerHeight + contentHeight + footerHeight + 1).rounded(.up)
    if abs(store.detailContentHeight - natural) > 0.5 { store.detailContentHeight = natural }
  }

  /// Chinese and Japanese run sentences together; other languages need a space between them.
  private var sayText: Text {
    var text = Text(detail.sayPrimary)
    if let secondary = detail.saySecondary {
      let joined = store.locale.hasPrefix("zh") || store.locale.hasPrefix("ja")
      text = text + Text((joined ? "" : " ") + secondary).foregroundColor(Palette.ink3)
    }
    return text
  }
}

struct FactCard: View {
  let fact: MBFact

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      Text(fact.label).font(.system(size: 10.5)).foregroundStyle(Palette.ink3).lineLimit(1)
      Text(fact.value)
        .font(.system(size: fact.value.count > 14 ? 12 : 15, weight: .semibold))
        .tracking(fact.value.count > 14 ? 0 : -0.3)
        .monospacedDigit()
        .lineLimit(1)
        .minimumScaleFactor(0.8)
        .padding(.top, fact.value.count > 14 ? 4 : 2)
      Text(fact.sub).font(.system(size: 10.5)).foregroundStyle(Palette.ink3).lineLimit(1).padding(.top, 1)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(EdgeInsets(top: 9, leading: 11, bottom: 9, trailing: 11))
    .background(RoundedRectangle(cornerRadius: 12, style: .circular).fill(Palette.tile))
    .overlay(RoundedRectangle(cornerRadius: 12, style: .circular).strokeBorder(Palette.line, lineWidth: 0.5))
  }
}

// MARK: - Usage page

/// Usage over 7/30/90 days at the panel's own width: one total, one chart, the harness split
/// and a short list. It slides in like a detail page instead of turning into a dashboard.
struct UsagePage: View {
  @ObservedObject var store: MenubarStore
  let view: MBView
  let controller: StatusController
  @State private var selection: Int?
  @State private var offset: CGFloat = 0
  @State private var contentHeight: CGFloat = 0
  @State private var headerHeight: CGFloat = 0

  private var scope: String { view.settings.scope }
  private var scopeData: MBScopeData? { view.usage.scopes[scope] ?? view.usage.scopes["all"] }

  var body: some View {
    let data = scopeData
    let range = store.usageRange
    let days = Array(view.usage.days.suffix(range))
    let daily = Array((data?.daily ?? []).suffix(range))
    let byHarness = harnessTotals(daily)
    let total = byHarness.reduce(0, +)
    VStack(spacing: 0) {
      header
        .background(GeometryReader { g in
          Color.clear
            .onAppear { headerHeight = g.size.height }
            .onChange(of: g.size.height) { _, h in headerHeight = h }
        })
      EdgeLine(visible: offset > 2)
      // Only the body scrolls, so back and the range switch stay in reach on long task lists.
      TrackedScroll(offset: $offset, contentHeight: $contentHeight) {
        VStack(alignment: .leading, spacing: 0) {
          summary(days: days, daily: daily, total: total)
            .padding(.horizontal, 18)
          UsageChart(days: days, daily: daily, money: true, compact: false, selection: $selection)
            .frame(height: store.short ? 84 : 100)
            .padding(EdgeInsets(top: 12, leading: 18, bottom: 0, trailing: 18))
          dateRange(days: days)
            .padding(EdgeInsets(top: 4, leading: 18, bottom: 0, trailing: 18))
          harnessSplit(byHarness: byHarness, total: total)
            .padding(EdgeInsets(top: 14, leading: 18, bottom: 0, trailing: 18))
          Picker("", selection: $store.usageList) {
            Text(store.s("listModels", ["n": String(range)])).tag(UsageList.models)
            Text(store.s("listTasks")).tag(UsageList.tasks)
          }
          .pickerStyle(.segmented)
          .labelsHidden()
          .controlSize(.small)
          .fixedSize()
          .padding(EdgeInsets(top: 16, leading: 14, bottom: 4, trailing: 14))
          Group {
            if store.usageList == .models {
              modelList(data?.models[String(range)] ?? [])
            } else {
              taskList
            }
          }
          .padding(.horizontal, 10)
          if let note = data?.note, !note.isEmpty {
            Text(note)
              .font(.system(size: 10.5))
              .foregroundStyle(Palette.ink3)
              .lineSpacing(2)
              .fixedSize(horizontal: false, vertical: true)
              .padding(EdgeInsets(top: 12, leading: 18, bottom: 16, trailing: 18))
          }
        }
        .frame(width: store.narrowWidth, alignment: .leading)
      }
    }
    .onChange(of: contentHeight) { report() }
    .onChange(of: headerHeight) { report() }
    .onChange(of: store.usageRange) { selection = nil }
  }

  /// Sizes the panel to the whole page; it only scrolls when the screen is shorter.
  private func report() {
    guard contentHeight > 0 else { return }
    let natural = (headerHeight + contentHeight + 1).rounded(.up)
    if abs(store.usageContentHeight - natural) > 0.5 { store.usageContentHeight = natural }
  }

  private var header: some View {
    HStack(spacing: 4) {
      IconButton(systemName: "chevron.left", label: store.s("back")) { store.go(.main) }
      Text(store.s("usageTitle")).font(.system(size: 13, weight: .bold)).lineLimit(1)
      Spacer(minLength: 8)
      Picker("", selection: $store.usageRange) {
        Text(store.s("range7")).tag(7)
        Text(store.s("range30")).tag(30)
        Text(store.s("range90")).tag(90)
      }
      .pickerStyle(.segmented)
      .labelsHidden()
      .controlSize(.small)
      .fixedSize()
    }
    .padding(EdgeInsets(top: 12, leading: 10, bottom: 8, trailing: 14))
  }

  /// The total, or the hovered day's amount and its harness split.
  @ViewBuilder
  private func summary(days: [String], daily: [MBDaily], total: Double) -> some View {
    VStack(alignment: .leading, spacing: 2) {
      if let selection, selection < daily.count {
        let row = daily[selection]
        let date = Fmt.day(days[selection])
        bigNumber(Fmt.money(row.money.reduce(0, +)))
        caption(Fmt.monthDay(date, locale: store.locale) + " " + Fmt.weekday(date, locale: store.locale))
        let present = harnessOrder.filter { row.money[$0.index] > 0 }
        caption(present.isEmpty
          ? store.s("noUsage")
          : present.map { "\(store.s("harness." + $0.key)) \(Fmt.money(row.money[$0.index]))" }.joined(separator: " · "))
      } else {
        bigNumber(Fmt.money(total))
        caption(store.s("wideCaptionMoney", ["n": String(store.usageRange)]) + " · " + store.s(scope == "local" ? "scopeLocal" : "scopeAll"))
        caption(stats(daily: daily, total: total))
      }
    }
  }

  private func bigNumber(_ text: String) -> some View {
    Text(text)
      .font(NumFont.font(34))
      .monospacedDigit()
      .lineLimit(1)
      .minimumScaleFactor(0.7)
      .contentTransition(.numericText())
      .animation(Motion.quick, value: text)
  }

  private func caption(_ text: String) -> some View {
    Text(text)
      .font(.system(size: 11))
      .foregroundStyle(Palette.ink3)
      .monospacedDigit()
      .lineLimit(1)
      .truncationMode(.tail)
  }

  private func stats(daily: [MBDaily], total: Double) -> String {
    let range = Double(max(1, store.usageRange))
    let paid = daily.reduce(0) { $0 + $1.paid }
    let tokens = daily.reduce(0) { $0 + $1.tokens.reduce(0, +) }
    return [
      "\(store.s("dailyAverage")) \(Fmt.money(total / range))",
      "\(store.s("paid")) \(Fmt.money(paid))",
      "\(Fmt.tokens(tokens)) \(store.s("tokenUnit"))",
    ].joined(separator: " · ")
  }

  private func harnessTotals(_ daily: [MBDaily]) -> [Double] {
    var totals = [0.0, 0.0, 0.0]
    for day in daily {
      for j in 0..<3 { totals[j] += day.money[j] }
    }
    return totals
  }

  /// One thin bar and three columns: name and share above, amount below.
  @ViewBuilder
  private func harnessSplit(byHarness: [Double], total: Double) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      HarnessBar(values: harnessOrder.map { ($0.key, byHarness[$0.index]) })
        .frame(height: 4)
      HStack(alignment: .top, spacing: 0) {
        ForEach(Array(harnessOrder.enumerated()), id: \.element.index) { position, harness in
          if position > 0 { Spacer(minLength: 10) }
          VStack(alignment: .leading, spacing: 1) {
            HStack(spacing: 5) {
              Circle().fill(Palette.harness(harness.key)).frame(width: 6, height: 6)
              Text(store.s("harness." + harness.key)).lineLimit(1)
              Text("\(Int((byHarness[harness.index] / max(total, 0.0001) * 100).rounded()))%")
                .foregroundStyle(Palette.ink3)
            }
            .font(.system(size: 10.5))
            .foregroundStyle(Palette.ink2)
            Text(Fmt.money(byHarness[harness.index]))
              .font(NumFont.font(16))
              .padding(.leading, 11)
          }
          .monospacedDigit()
          .fixedSize()
        }
      }
    }
    .accessibilityElement(children: .combine)
  }

  /// First day on the left, "Today" on the right; hovering the chart names the exact day.
  private func dateRange(days: [String]) -> some View {
    HStack {
      if let first = days.first {
        Text(Fmt.monthDay(Fmt.day(first), locale: store.locale))
      }
      Spacer(minLength: 0)
      Text(store.s("today"))
    }
    .font(.system(size: 10))
    .foregroundStyle(Palette.ink3)
    .monospacedDigit()
    .accessibilityHidden(true)
  }

  @ViewBuilder
  private func modelList(_ models: [MBModelUsage]) -> some View {
    let rows = models.filter { $0.money > 0 }.sorted { $0.money > $1.money }.prefix(5)
    VStack(spacing: 0) {
      if rows.isEmpty {
        emptyRow(store.s("noUsage"))
      }
      ForEach(Array(rows.enumerated()), id: \.offset) { _, model in
        HStack(spacing: 8) {
          Circle().fill(Palette.harness(model.harness)).frame(width: 6, height: 6)
          Text(model.name).lineLimit(1).truncationMode(.tail).frame(maxWidth: .infinity, alignment: .leading)
          Text(Fmt.money(model.money)).fontWeight(.semibold)
        }
        .font(.system(size: 12))
        .monospacedDigit()
        .padding(.horizontal, 8)
        .frame(height: 26)
      }
    }
  }

  private var taskList: some View {
    let tasks = view.tasks.sorted { $0.value > $1.value }
    return VStack(spacing: 0) {
      if tasks.isEmpty {
        emptyRow(store.s("noTasksToday"))
      }
      ForEach(tasks) { task in
        UsageTaskRow(task: task, runningLabel: store.s("running")) {
          controller.emitAndClose(["type": "open-session", "sessionId": task.sessionId])
        }
      }
    }
  }

  private func emptyRow(_ text: String) -> some View {
    Text(text)
      .font(.system(size: 12))
      .foregroundStyle(Palette.ink3)
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(.horizontal, 8)
      .frame(height: 26)
  }
}

struct UsageTaskRow: View {
  let task: MBTask
  let runningLabel: String
  let action: () -> Void
  @State private var hovering = false
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    Button(action: action) {
      HStack(spacing: 8) {
        // A running task's harness dot breathes; one dot carries both facts. With Reduce
        // Motion the dot stays still, so a ring marks it as running instead.
        if task.running {
          BreathingDot(animate: !reduceMotion, color: Palette.harness(task.harness), size: 6)
            .overlay {
              if reduceMotion {
                Circle().strokeBorder(Palette.harness(task.harness).opacity(0.5), lineWidth: 1.5).frame(width: 11, height: 11)
              }
            }
        } else {
          Circle().fill(Palette.harness(task.harness)).frame(width: 6, height: 6)
        }
        Text(task.title).lineLimit(1).truncationMode(.tail).frame(maxWidth: .infinity, alignment: .leading)
        Text(Fmt.money(task.value)).fontWeight(.semibold)
      }
      .font(.system(size: 12))
      .monospacedDigit()
      .padding(.horizontal, 8)
      .frame(height: 26)
      .background(RoundedRectangle(cornerRadius: 8, style: .circular).fill(hovering ? Palette.ink5 : .clear))
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .onHover { hovering in withAnimation(Motion.quick) { self.hovering = hovering } }
    .help(task.title)
    .accessibilityLabel(task.running
      ? "\(task.title), \(runningLabel), \(Fmt.money(task.value))"
      : "\(task.title), \(Fmt.money(task.value))")
  }
}

/// Capsule segments in harness order. Each segment is its own capsule, so rounding comes from
/// a single shape per segment and tiny shares keep a readable minimum width.
struct HarnessBar: View {
  let values: [(String, Double)]

  var body: some View {
    GeometryReader { geometry in
      let present = values.filter { $0.1 > 0 }
      let total = max(present.reduce(0) { $0 + $1.1 }, 0.0001)
      let gaps = CGFloat(max(0, present.count - 1)) * 2
      let available = max(0, geometry.size.width - gaps)
      let minimum: CGFloat = 6
      let raw = present.map { CGFloat($0.1 / total) * available }
      let deficit = raw.reduce(0) { $0 + max(0, minimum - $1) }
      let flexible = raw.reduce(0) { $0 + ($1 > minimum ? $1 : 0) }
      HStack(spacing: 2) {
        ForEach(Array(present.enumerated()), id: \.offset) { index, item in
          let width = raw[index] <= minimum ? minimum : raw[index] - deficit * (raw[index] / max(flexible, 0.0001))
          Capsule().fill(Palette.harness(item.0)).frame(width: max(minimum, width))
        }
      }
    }
  }
}

// MARK: - Manage page

struct ManagePage: View {
  @ObservedObject var store: MenubarStore
  let view: MBView
  let controller: StatusController
  @State private var offset: CGFloat = 0
  @State private var contentHeight: CGFloat = 0
  @State private var headerHeight: CGFloat = 0
  @State private var dragging: String?

  var body: some View {
    VStack(spacing: 0) {
      HStack(spacing: 4) {
        IconButton(systemName: "chevron.left", label: store.s("back")) { store.go(.main) }
        Text(store.s("manageTitle")).font(.system(size: 13, weight: .bold)).lineLimit(1)
        Spacer(minLength: 0)
        Button { store.go(.main) } label: {
          Text(store.s("done"))
            .font(.system(size: 12, weight: .semibold))
            .foregroundStyle(Palette.onInk)
            .lineLimit(1)
            .padding(.horizontal, 12)
            .frame(height: 26)
            .background(Capsule().fill(Palette.cta))
        }
        .buttonStyle(PressScaleStyle())
        .keyboardShortcut(.defaultAction)
      }
      .padding(EdgeInsets(top: 12, leading: 10, bottom: 8, trailing: 14))
      .background(GeometryReader { g in
        Color.clear
          .onAppear { headerHeight = g.size.height }
          .onChange(of: g.size.height) { _, h in headerHeight = h }
      })
      EdgeLine(visible: offset > 2)
      TrackedScroll(offset: $offset, contentHeight: $contentHeight) {
        content
      }
    }
    .onChange(of: contentHeight) { report() }
    .onChange(of: headerHeight) { report() }
  }

  /// Sizes the panel to the whole page; it only scrolls when the screen is shorter.
  private func report() {
    guard contentHeight > 0 else { return }
    let natural = (headerHeight + contentHeight + 1).rounded(.up)
    if abs(store.manageContentHeight - natural) > 0.5 { store.manageContentHeight = natural }
  }

  private var content: some View {
    VStack(alignment: .leading, spacing: 0) {
      section(store.s("sources"), store.s("sourcesShown", [
        "a": String(view.manage.filter { !$0.hidden }.count),
        "b": String(view.manage.count),
      ]))
      sourceList

      section(store.s("statusIcon"), nil)
      StatusPreview(store: store, view: view)
        .padding(.horizontal, 12)
      // Four labels never fit one segmented row in every language; two columns always do.
      ChoiceGrid(
        label: store.s("statusIcon"),
        options: ["icon", "lowest", "today", "task"].map { ($0, store.s("statusIconMode." + $0)) },
        selected: view.settings.statusText
      ) { Bridge.emitSettings(["statusText": $0]) }
      .padding(EdgeInsets(top: 8, leading: 12, bottom: 0, trailing: 12))

      section(store.s("other"), nil)
      Tile {
        VStack(spacing: 0) {
          settingRow(store.s("lowAlert"), nil) {
            Toggle("", isOn: Binding(get: { view.settings.lowAlert }, set: { Bridge.emitSettings(["lowAlert": $0]) }))
              .toggleStyle(.switch).controlSize(.small).labelsHidden()
          }
          Hairline()
          settingRow(store.s("privacy"), nil) {
            Toggle("", isOn: Binding(get: { view.settings.privacy }, set: { Bridge.emitSettings(["privacy": $0]) }))
              .toggleStyle(.switch).controlSize(.small).labelsHidden()
          }
          Hairline()
          // The picker moves under its title when the two labels don't fit beside it.
          ViewThatFits(in: .horizontal) {
            settingRow(store.s("usageScope"), nil) { scopePicker }
            VStack(alignment: .leading, spacing: 6) {
              Text(store.s("usageScope")).font(.system(size: 12.5))
              scopePicker
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.vertical, 8)
          }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 1)
      }
      .padding(.horizontal, 12)

      Button { controller.emitAndClose(["type": "open-provider-settings"]) } label: {
        Text(store.s("manageFoot"))
          .font(.system(size: 11))
          .foregroundStyle(Palette.ink3)
          .lineSpacing(3)
          .multilineTextAlignment(.leading)
          .fixedSize(horizontal: false, vertical: true)
      }
      .buttonStyle(.plain)
      .padding(EdgeInsets(top: 14, leading: 18, bottom: 16, trailing: 18))
    }
    .frame(width: store.narrowWidth, alignment: .leading)
  }

  private var scopePicker: some View {
    Picker("", selection: Binding(get: { view.settings.scope }, set: { Bridge.emitSettings(["scope": $0]) })) {
      Text(store.s("scopeLocal")).tag("local")
      Text(store.s("scopeAll")).tag("all")
    }
    .pickerStyle(.segmented)
    .labelsHidden()
    .controlSize(.small)
    .fixedSize()
  }

  private func section(_ title: String, _ detail: String?) -> some View {
    HStack(alignment: .firstTextBaseline, spacing: 8) {
      Text(title).font(.system(size: 12.5, weight: .semibold)).lineLimit(1).fixedSize()
      Spacer(minLength: 0)
      if let detail {
        Text(detail).font(.system(size: 11)).foregroundStyle(Palette.ink3).monospacedDigit().lineLimit(1).truncationMode(.tail)
      }
    }
    .padding(EdgeInsets(top: 16, leading: 18, bottom: 6, trailing: 18))
  }

  private func settingRow<Control: View>(_ title: String, _ sub: String?, @ViewBuilder control: () -> Control) -> some View {
    HStack(spacing: 10) {
      VStack(alignment: .leading, spacing: 1) {
        Text(title).font(.system(size: 12.5)).fixedSize(horizontal: false, vertical: true)
        if let sub {
          Text(sub).font(.system(size: 10.5)).foregroundStyle(Palette.ink3).fixedSize(horizontal: false, vertical: true)
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      control()
    }
    .padding(.vertical, 8)
  }

  private var sourceList: some View {
    let rows = store.manageRows
    return Tile {
      VStack(spacing: 0) {
        ForEach(Array(rows.enumerated()), id: \.element.id) { index, row in
          ManageRow(
            store: store,
            row: row,
            showDivider: index > 0,
            dragging: dragging == row.id
          )
          .onDrag {
            dragging = row.id
            return NSItemProvider(object: row.id as NSString)
          }
          .onDrop(of: [.text], delegate: ReorderDropDelegate(target: row.id, store: store, dragging: $dragging))
        }
      }
      .padding(3)
    }
    .padding(.horizontal, 12)
  }
}

/// Exclusive choice laid out in two columns of equal chips; used where a segmented control
/// would be wider than the panel in some languages.
/// Two columns of mutually exclusive choices. Assistive technologies see one radio group,
/// like the segmented control it replaces, rather than four separate buttons.
struct ChoiceGrid: View {
  let label: String
  let options: [(id: String, label: String)]
  let selected: String
  let choose: (String) -> Void

  var body: some View {
    LazyVGrid(columns: [GridItem(.flexible(), spacing: 6), GridItem(.flexible(), spacing: 6)], spacing: 6) {
      ForEach(options, id: \.id) { option in
        ChoiceChip(label: option.label, selected: option.id == selected) { choose(option.id) }
      }
    }
    .accessibilityRepresentation {
      Picker(label, selection: Binding(get: { selected }, set: { choose($0) })) {
        ForEach(options, id: \.id) { option in Text(option.label).tag(option.id) }
      }
      .pickerStyle(.radioGroup)
    }
  }
}

struct ChoiceChip: View {
  let label: String
  let selected: Bool
  let action: () -> Void
  @State private var hovering = false

  var body: some View {
    Button(action: action) {
      Text(label)
        .font(.system(size: 12, weight: selected ? .semibold : .regular))
        .lineLimit(1)
        .minimumScaleFactor(0.85)
        .frame(maxWidth: .infinity)
        .frame(height: 28)
        .padding(.horizontal, 8)
        .foregroundStyle(selected ? Palette.onInk : Palette.ink2)
        .background(
          Capsule()
            .fill(selected ? Palette.ink : (hovering ? Palette.ink5 : Palette.tile))
        )
        .overlay(
          Capsule()
            .strokeBorder(selected ? Color.clear : Palette.line, lineWidth: 0.5)
        )
        .contentShape(Capsule())
    }
    .buttonStyle(PressScaleStyle())
    .onHover { hovering in withAnimation(Motion.quick) { self.hovering = hovering } }
    .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
  }
}

struct ReorderDropDelegate: DropDelegate {
  let target: String
  let store: MenubarStore
  @Binding var dragging: String?

  func dropEntered(info: DropInfo) {
    guard let dragging, dragging != target else { return }
    Task { @MainActor in store.move(dragging, into: target) }
  }

  func dropUpdated(info: DropInfo) -> DropProposal? { DropProposal(operation: .move) }

  func performDrop(info: DropInfo) -> Bool {
    Task { @MainActor in
      store.commitOrder()
      dragging = nil
    }
    return true
  }

  func dropExited(info: DropInfo) {}
}

struct ManageRow: View {
  @ObservedObject var store: MenubarStore
  let row: MBManageRow
  let showDivider: Bool
  let dragging: Bool
  @State private var hovering = false
  @State private var shake: CGFloat = 0

  var body: some View {
    HStack(spacing: 9) {
      Image(systemName: "line.3.horizontal")
        .font(.system(size: 10, weight: .semibold))
        .foregroundStyle(Palette.ink3)
        .frame(width: 14, height: 24)
        .accessibilityHidden(true)
      ZStack {
        RoundedRectangle(cornerRadius: 8, style: .circular).fill(Palette.ink5)
        LogoView(svg: row.logoSvg, size: 13)
      }
      .frame(width: 26, height: 26)
      .opacity(row.hidden ? 0.4 : 1)
      VStack(alignment: .leading, spacing: 0) {
        Text(row.title).font(.system(size: 12.5, weight: .semibold)).lineLimit(1)
        Text(row.subtitle).font(.system(size: 10.5)).foregroundStyle(Palette.ink3).lineLimit(1)
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .opacity(row.hidden ? 0.4 : 1)
      Text(row.value)
        .font(.system(size: 11.5))
        .foregroundStyle(Palette.ink3)
        .monospacedDigit()
        .lineLimit(1)
        .fixedSize()
      Toggle("", isOn: Binding(get: { !row.hidden }, set: { _ in store.toggleHidden(row) }))
        .toggleStyle(.switch)
        .controlSize(.small)
        .labelsHidden()
        .offset(x: shake)
        .accessibilityLabel(store.s("showSource", ["name": row.title]))
    }
    .padding(EdgeInsets(top: 6, leading: 6, bottom: 6, trailing: 8))
    .background(RoundedRectangle(cornerRadius: 11, style: .circular).fill(hovering ? Palette.ink5 : .clear))
    .overlay(alignment: .top) {
      // Starts under the title: 6pt inset + 14pt handle + 9pt + 26pt logo + 9pt.
      if showDivider {
        Rectangle().fill(Palette.line).frame(height: 0.5).padding(.leading, 64).padding(.trailing, 10)
      }
    }
    .opacity(dragging ? 0.35 : 1)
    .contentShape(Rectangle())
    .onHover { hovering in withAnimation(.easeOut(duration: 0.15)) { self.hovering = hovering } }
    .accessibilityElement(children: .contain)
    .accessibilityLabel(row.title)
    .accessibilityHint(store.s("reorderHint"))
    .accessibilityAction(named: store.s("moveUp")) { store.moveBy(row.id, offset: -1) }
    .accessibilityAction(named: store.s("moveDown")) { store.moveBy(row.id, offset: 1) }
    .contextMenu {
      Button(store.s("moveUp")) { store.moveBy(row.id, offset: -1) }
      Button(store.s("moveDown")) { store.moveBy(row.id, offset: 1) }
    }
    .onChange(of: store.shakeId) { _, id in
      guard id == row.id else { return }
      withAnimation(.easeInOut(duration: 0.06).repeatCount(4, autoreverses: true)) { shake = 4 }
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { withAnimation(.easeOut(duration: 0.05)) { shake = 0 } }
    }
  }
}

/// A slice of a menu bar over a wallpaper, showing exactly what the status item will look like.
struct StatusPreview: View {
  @ObservedObject var store: MenubarStore
  let view: MBView
  @Environment(\.colorScheme) private var colorScheme

  var body: some View {
    let text = view.statusTitle
    let dark = colorScheme == .dark
    ZStack(alignment: .topLeading) {
      wallpaper(dark: dark)
      HStack(spacing: 4) {
        Spacer()
        Image(systemName: "wifi").font(.system(size: 12, weight: .semibold)).opacity(0.5).padding(.horizontal, 6)
        HStack(spacing: 5) {
          if let icon = Logos.statusIcon(dark: dark, controlled: view.remotelyControlled == true) {
            Image(nsImage: icon).renderingMode(.original).resizable().frame(width: 18, height: 18)
          }
          if !text.isEmpty {
            Text(text).font(.system(size: 13, weight: .regular)).monospacedDigit().lineLimit(1).fixedSize()
          }
        }
        .padding(.horizontal, 7)
        .frame(height: 22)
        .background(RoundedRectangle(cornerRadius: 6, style: .continuous).fill(dark ? Color.white.opacity(0.18) : Color.black.opacity(0.11)))
        .layoutPriority(1)
        TimelineView(.periodic(from: .now, by: 30)) { context in
          Text(Fmt.clockTime(context.date, locale: store.locale))
            .font(.system(size: 12, weight: .medium))
            .monospacedDigit()
            .lineLimit(1)
            .opacity(0.8)
            .padding(.horizontal, 6)
        }
      }
      .foregroundStyle(dark ? Color(white: 0.957) : Color(white: 0.063))
      .padding(.horizontal, 10)
      .frame(height: 26)
      .background(.ultraThinMaterial)
      .padding(.top, 16)
    }
    .frame(height: 68)
    .frame(maxWidth: .infinity)
    .clipShape(RoundedRectangle(cornerRadius: 14, style: .circular))
    .overlay(RoundedRectangle(cornerRadius: 14, style: .circular).strokeBorder(Palette.line, lineWidth: 0.5))
    .animation(Motion.quick, value: text)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(text.isEmpty ? "Cindy" : "Cindy \(text)")
  }

  private func wallpaper(dark: Bool) -> some View {
    ZStack {
      (dark ? Color(red: 0.055, green: 0.059, blue: 0.071) : Color(red: 0.89, green: 0.882, blue: 0.859))
      RadialGradient(colors: [dark ? Color(red: 0.165, green: 0.137, blue: 0.251) : Color(red: 0.965, green: 0.937, blue: 0.894), .clear], center: UnitPoint(x: 0.15, y: 0.15), startRadius: 0, endRadius: 220)
      RadialGradient(colors: [dark ? Color(red: 0.29, green: 0.165, blue: 0.11) : Color(red: 0.941, green: 0.788, blue: 0.651), .clear], center: UnitPoint(x: 0.85, y: 0.25), startRadius: 0, endRadius: 200)
      RadialGradient(colors: [dark ? Color(red: 0.071, green: 0.231, blue: 0.227) : Color(red: 0.663, green: 0.765, blue: 0.776), .clear], center: UnitPoint(x: 0.7, y: 1), startRadius: 0, endRadius: 220)
    }
  }
}

// MARK: - App

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
  let store = MenubarStore()
  var controller: StatusController?
  private let decoder = JSONDecoder()

  func applicationDidFinishLaunching(_ notification: Notification) {
    NumFont.register()
    controller = StatusController(store: store)
    let args = CommandLine.arguments
    if let index = args.firstIndex(of: "--preview"), index + 1 < args.count {
      startPreview(path: args[index + 1], args: args)
      return
    }
    startReadingStdin()
    Bridge.emit(["type": "ready"])
  }

  /// Development preview: render a saved view model and open the panel without main.
  private func startPreview(path: String, args: [String]) {
    guard let data = FileManager.default.contents(atPath: path) else {
      FileHandle.standardError.write(Data("menubar: preview file missing\n".utf8))
      NSApp.terminate(nil)
      return
    }
    do {
      let view = try decoder.decode(MBView.self, from: data)
      store.apply(view)
    } catch {
      FileHandle.standardError.write(Data("menubar: preview decode failed: \(error)\n".utf8))
      NSApp.terminate(nil)
      return
    }
    if let index = args.firstIndex(of: "--appearance"), index + 1 < args.count {
      NSApp.appearance = NSAppearance(named: args[index + 1] == "dark" ? .darkAqua : .aqua)
    }
    var page: Page = .main
    if let index = args.firstIndex(of: "--page"), index + 1 < args.count {
      let value = args[index + 1]
      if value == "usage" || value == "wide" { page = .usage }
      if value == "manage" { page = .manage }
      if value.hasPrefix("detail:") { page = .detail(String(value.dropFirst(7))) }
    }
    if args.contains("--short") { controller?.forceShort = true }
    if let index = args.firstIndex(of: "--list"), index + 1 < args.count, args[index + 1] == "tasks" {
      store.usageList = .tasks
    }
    var snapshotPath: String?
    if let index = args.firstIndex(of: "--snapshot"), index + 1 < args.count {
      snapshotPath = args[index + 1]
    }
    var snapshotDelay = 1.2
    if let index = args.firstIndex(of: "--delay"), index + 1 < args.count, let value = Double(args[index + 1]) {
      snapshotDelay = value
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { [weak self] in
      self?.controller?.openForPreview(page: page) {
        guard let window = NSApp.windows.first(where: { $0 is MenubarPanel }) else { return }
        FileHandle.standardError.write(Data("menubar: preview window \(window.windowNumber)\n".utf8))
        guard let snapshotPath else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + snapshotDelay) {
          Self.writeSnapshot(of: window, to: snapshotPath)
          NSApp.terminate(nil)
        }
      }
    }
  }

  /// Renders the panel into a PNG without screen recording access. The frosted material
  /// cannot be sampled this way, so the backdrop is a flat stand-in for it.
  private static func writeSnapshot(of window: NSWindow, to path: String) {
    guard let view = window.contentView else { return }
    let scale = window.backingScaleFactor
    let size = view.bounds.size
    guard let rep = NSBitmapImageRep(
      bitmapDataPlanes: nil, pixelsWide: Int(size.width * scale), pixelsHigh: Int(size.height * scale),
      bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
      colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)
    else { return }
    rep.size = size
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    let dark = NSApp.effectiveAppearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
    (dark ? NSColor(white: 0.17, alpha: 1) : NSColor(white: 0.93, alpha: 1)).setFill()
    NSBezierPath(roundedRect: view.bounds, xRadius: PanelBackgroundView.radius, yRadius: PanelBackgroundView.radius).fill()
    NSGraphicsContext.restoreGraphicsState()
    view.cacheDisplay(in: view.bounds, to: rep)
    try? rep.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: path))
  }

  private func startReadingStdin() {
    DispatchQueue.global(qos: .userInitiated).async { [weak self] in
      while let line = readLine(strippingNewline: true) {
        self?.handle(line)
      }
      DispatchQueue.main.async { NSApp.terminate(nil) }
    }
  }

  nonisolated private func handle(_ line: String) {
    guard let data = line.data(using: .utf8) else { return }
    let decoder = JSONDecoder()
    do {
      let message = try decoder.decode(MBIncoming.self, from: data)
      switch message.type {
      case "shutdown":
        DispatchQueue.main.async { NSApp.terminate(nil) }
      case "update":
        guard let view = message.view else { return }
        DispatchQueue.main.async { [weak self] in
          MainActor.assumeIsolated { self?.store.apply(view) }
        }
      case "open":
        DispatchQueue.main.async { [weak self] in
          MainActor.assumeIsolated { self?.controller?.open() }
        }
      default:
        break
      }
    } catch {
      Bridge.emit(["type": "error", "message": "Could not decode menu bar update: \(error)"])
    }
  }
}

@main
enum MenubarHelperMain {
  static func main() {
    let app = NSApplication.shared
    let delegate = AppDelegate()
    app.delegate = delegate
    app.setActivationPolicy(.accessory)
    withExtendedLifetime(delegate) { app.run() }
  }
}

// The Cindy "A" mark from the brand kit (24pt viewBox, 20pt ink, even-odd `>` cut-out).
let cindySilhouettePath = "M 18.163,3.549 C 18.561,3.879 18.876,4.238 19.198,4.64 C 19.268,4.71 19.339,4.78 19.411,4.852 C 19.492,4.934 19.574,5.015 19.658,5.099 C 19.707,5.148 19.756,5.196 19.807,5.246 C 20.975,6.474 21.548,8.384 21.521,10.044 C 21.495,10.615 21.368,11.261 20.977,11.697 C 20.936,11.732 20.894,11.768 20.852,11.805 C 20.852,11.562 20.852,11.32 20.852,11.07 C 20.633,11.931 20.637,12.526 20.946,13.369 C 21.317,14.501 21.213,15.792 20.72,16.867 C 20.364,17.549 20.364,17.549 20.025,17.775 C 20.039,17.703 20.054,17.631 20.068,17.557 C 20.077,17.511 20.077,17.511 20.123,17.275 C 20.141,17.183 20.159,17.09 20.178,16.994 C 20.188,16.919 20.198,16.843 20.209,16.764 C 20.178,16.734 20.148,16.704 20.117,16.673 C 20.107,16.753 20.098,16.833 20.088,16.915 C 19.896,17.855 19.189,18.653 18.463,19.244 C 17.965,19.568 17.495,19.757 16.902,19.796 C 17.054,19.644 17.205,19.492 17.361,19.336 C 17.086,19.336 17.086,19.336 16.81,19.428 C 16.621,19.435 16.431,19.436 16.242,19.434 C 16.142,19.433 16.042,19.432 15.939,19.431 C 15.863,19.43 15.787,19.429 15.708,19.428 C 15.799,19.368 15.89,19.307 15.983,19.244 C 15.898,19.247 15.813,19.249 15.725,19.251 C 15.611,19.253 15.498,19.254 15.381,19.256 C 15.269,19.258 15.157,19.26 15.042,19.262 C 14.677,19.243 14.4,19.174 14.055,19.061 C 14.149,18.786 14.248,18.513 14.347,18.24 C 14.374,18.162 14.401,18.084 14.429,18.003 C 14.638,17.438 14.638,17.438 14.908,17.298 C 15.231,17.321 15.513,17.399 15.823,17.494 C 16.353,17.646 16.809,17.746 17.361,17.683 C 17.713,17.485 17.801,17.281 17.918,16.902 C 18.096,16.333 18.096,16.333 18.372,16.122 C 18.432,16.122 18.493,16.122 18.555,16.122 C 18.55,16.051 18.544,15.981 18.538,15.909 C 18.555,15.662 18.555,15.662 18.693,15.533 C 18.87,15.345 18.853,15.256 18.848,15.002 C 18.875,14.596 19.004,14.442 19.302,14.17 C 19.37,14.114 19.439,14.059 19.509,14.002 C 19.658,13.825 19.658,13.825 19.651,13.601 C 19.559,13.348 19.446,13.159 19.29,12.941 C 18.966,12.484 18.91,12.168 18.897,11.606 C 18.895,11.541 18.894,11.477 18.892,11.41 C 18.886,11.203 18.882,10.996 18.877,10.788 C 18.858,9.96 18.837,9.138 18.739,8.314 C 18.678,8.314 18.618,8.314 18.555,8.314 C 18.538,8.426 18.521,8.538 18.504,8.653 C 18.133,10.262 16.849,11.349 15.68,12.413 C 14.855,13.168 14.222,13.835 14.115,14.994 C 14.099,15.675 14.158,16.228 14.422,16.856 C 14.109,16.759 13.87,16.672 13.595,16.489 C 13.563,16.603 13.531,16.716 13.498,16.833 C 13.279,17.493 12.925,18.134 12.467,18.657 C 12.309,18.877 12.309,18.877 12.315,19.07 C 12.413,19.269 12.522,19.396 12.677,19.554 C 12.985,19.893 13.235,20.25 13.481,20.634 C 13.515,20.688 13.55,20.741 13.585,20.797 C 14.146,21.686 14.146,21.686 14.146,22 C 13.75,21.874 13.374,21.722 12.993,21.558 C 11.378,20.9 9.722,20.714 7.992,20.622 C 8.028,20.575 8.064,20.528 8.101,20.479 C 8.37,20.121 8.637,19.761 8.894,19.394 C 8.947,19.317 9.001,19.241 9.056,19.162 C 9.187,18.969 9.187,18.969 9.278,18.785 C 9.245,18.78 9.245,18.78 9.077,18.756 C 8.797,18.688 8.6,18.576 8.36,18.418 C 8.36,18.478 8.36,18.539 8.36,18.602 C 7.479,18.463 6.695,17.922 6.155,17.224 C 5.981,16.926 5.832,16.623 5.696,16.305 C 5.74,16.453 5.784,16.6 5.828,16.747 C 5.853,16.829 5.877,16.911 5.903,16.996 C 5.954,17.164 6.008,17.332 6.064,17.499 C 5.299,17.281 4.772,16.857 4.318,16.213 C 3.714,15.033 3.82,13.901 4.043,12.631 C 3.577,13.432 3.387,14.102 3.308,15.019 C 2.824,14.591 2.572,13.903 2.481,13.274 C 2.397,11.547 3.913,10.126 4.944,8.882 C 5.479,8.227 5.879,7.592 6.224,6.822 C 6.567,6.064 6.997,5.455 7.533,4.824 C 7.593,4.75 7.652,4.675 7.713,4.599 C 10.235,1.556 15.063,1.158 18.163,3.549 Z"
let cindyMarkPath = cindySilhouettePath + " M 11.024,12.539 L 13.412,14.009 L 13.412,14.56 L 11.024,16.03 L 11.024,15.203 L 12.585,14.284 L 11.024,13.366 L 11.024,12.539 Z"
