import ActivityKit
import AppKit
import SwiftUI
import WidgetKit

// Widget extension that renders Cindy's task activity in the macOS Dynamic Island
// (or the menu bar Live Activity area on Macs without one). All text is localized
// by the main process; this target only lays it out. Colors and the count format
// follow Agent Island (`PillBadge` in macos-agent-island-helper.swift): running is
// orange, waiting on the user teal, unread results green, `attention · running`.

@main
struct CindyAgentActivityBundle: WidgetBundle {
  var body: some Widget {
    CindyAgentActivityWidget()
  }
}

private enum Palette {
  static let running = Color(red: 1.0, green: 0.4, blue: 0.0)
  static let attention = Color(red: 0.0, green: 0.851, blue: 0.773)
  static let completed = Color(red: 0.133, green: 0.773, blue: 0.369)
  /// The Dynamic Island and the menu bar pill are dark in both appearances.
  static let islandText = Color.white
  static let islandSecondary = Color.white.opacity(0.62)
  static let separator = Color.white.opacity(0.42)
}

private extension CindyAgentActivityAttributes.ContentState {
  var destinationURL: URL? { taskUrl.flatMap { URL(string: $0) } }
  var needsUser: Bool { status == "attention" && attentionCount > 0 }
  var isCompleted: Bool { status == "completed" }
  var tint: Color {
    if needsUser { return Palette.attention }
    if isCompleted { return Palette.completed }
    return Palette.running
  }
}

/// Asset-catalog still of the island mascot in the pose for `status` (`<skin>-<status>`,
/// exported by the island helper in build.mjs; WidgetKit does not archive file-loaded images).
/// A skin newer than this build falls back to Cindy.
private struct MascotView: View {
  let skin: String
  let status: String
  let size: CGFloat
  var dot: Color? = nil

  var body: some View {
    Image(NSImage(named: "\(skin)-\(status)") != nil ? "\(skin)-\(status)" : "cindy-\(status)")
      .resizable()
      .interpolation(.high)
      .scaledToFit()
      .frame(width: size, height: size)
      .overlay(alignment: .bottomTrailing) {
        if let dot {
          Circle()
            .fill(dot)
            .frame(width: max(5, size * 0.3), height: max(5, size * 0.3))
            .overlay(Circle().stroke(Color.black, lineWidth: max(1, size * 0.06)))
            .offset(x: size * 0.06, y: size * 0.06)
        }
      }
  }
}

/// Dark tints of the companion hue families; mirrors `agentIslandCompanionHueColor`
/// in macos-agent-island-helper.swift.
private func companionHueColor(_ hue: String) -> Color {
  let rgb: (Double, Double, Double)
  switch hue {
  case "red": rgb = (0x4a, 0x2e, 0x2a)
  case "orange": rgb = (0x4a, 0x35, 0x27)
  case "amber": rgb = (0x47, 0x3a, 0x22)
  case "green": rgb = (0x26, 0x40, 0x2a)
  case "teal": rgb = (0x21, 0x40, 0x3e)
  case "blue": rgb = (0x26, 0x34, 0x49)
  case "pink": rgb = (0x45, 0x2b, 0x39)
  case "graphite": rgb = (0x3c, 0x3c, 0x3a)
  default: rgb = (0x32, 0x2b, 0x48)
  }
  return Color(red: rgb.0 / 255, green: rgb.1 / 255, blue: rgb.2 / 255)
}

/// Companion avatar as the island draws it: artwork, or its emoji / initial on the hue.
private struct CompanionAvatarView: View {
  let companion: CindyAgentActivityAttributes.Companion
  let size: CGFloat

  var body: some View {
    ZStack {
      Circle().fill(companionHueColor(companion.hue))
      if let artwork {
        artwork.resizable().interpolation(.high).aspectRatio(contentMode: .fill)
      } else if companion.glyphIsInitial {
        Text(companion.glyph)
          .font(.system(size: size * 0.5, weight: .medium))
          .foregroundStyle(Color.white.opacity(0.92))
      } else {
        Text(companion.glyph).font(.system(size: size * 0.58))
      }
    }
    .frame(width: size, height: size)
    .clipShape(Circle())
  }

  private var artwork: Image? {
    companion.imageJpeg
      .flatMap { Data(base64Encoded: $0) }
      .flatMap { NSImage(data: $0) }
      .map { Image(nsImage: $0) }
  }
}

/// Who the activity is about: the companion once it needs the user or has replied,
/// otherwise the mascot in the pose for the status.
private struct Identity: View {
  let state: CindyAgentActivityAttributes.ContentState
  let size: CGFloat
  var dot: Color? = nil

  var body: some View {
    if let companion = state.companion, state.status != "running" {
      CompanionAvatarView(companion: companion, size: size)
        .overlay(alignment: .bottomTrailing) {
          if let dot {
            Circle()
              .fill(dot)
              .frame(width: max(5, size * 0.3), height: max(5, size * 0.3))
              .overlay(Circle().stroke(Color.black, lineWidth: max(1, size * 0.06)))
              .offset(x: size * 0.06, y: size * 0.06)
          }
        }
    } else {
      MascotView(skin: state.mascot, status: state.status, size: size, dot: dot)
    }
  }
}

/// `attention · running` counts in Agent Island colors; a check for unread results.
private struct CountRuns: View {
  let state: CindyAgentActivityAttributes.ContentState
  let size: CGFloat
  var separator: Color = Palette.separator

  var body: some View {
    HStack(spacing: size * 0.25) {
      if state.attentionCount > 0 {
        Text("\(state.attentionCount)").foregroundStyle(Palette.attention)
      }
      if state.attentionCount > 0 && state.runningCount > 0 {
        Text("·").foregroundStyle(separator)
      }
      if state.runningCount > 0 {
        Text("\(state.runningCount)").foregroundStyle(Palette.running)
      }
      if state.attentionCount == 0 && state.runningCount == 0 {
        Image(systemName: "checkmark").foregroundStyle(Palette.completed)
      }
    }
    .font(.system(size: size, weight: .semibold, design: .rounded))
    .monospacedDigit()
  }
}

/// Compact trailing region. It leads with a status dot: the menu bar omits a
/// trailing region that holds only text.
private struct CompactStatus: View {
  let state: CindyAgentActivityAttributes.ContentState

  var body: some View {
    HStack(spacing: 5) {
      Circle().fill(state.tint).frame(width: 6, height: 6)
      CountRuns(state: state, size: 13)
    }
  }
}

/// `Needs input · 2 more tasks running`, in the status color. No leading dot: it sits next
/// to the avatar, whose corner dot already carries the status.
private struct StatusLine: View {
  let state: CindyAgentActivityAttributes.ContentState
  let secondary: Color

  var body: some View {
    HStack(spacing: 5) {
      Text(state.detail).foregroundStyle(state.tint)
      if !state.summary.isEmpty {
        Text("·").foregroundStyle(secondary)
        Text(state.summary).foregroundStyle(secondary)
      }
    }
    .font(.system(size: 12, weight: .medium))
    .lineLimit(1)
  }
}

/// Lock screen / notification-style presentation; sits on system material, so text
/// follows the appearance while status colors stay Agent Island's.
private struct ActivityBanner: View {
  let state: CindyAgentActivityAttributes.ContentState
  let appName: String

  var body: some View {
    HStack(spacing: 12) {
      Identity(state: state, size: 38, dot: state.tint)
      VStack(alignment: .leading, spacing: 3) {
        Text(state.title.isEmpty ? appName : state.title)
          .font(.system(size: 14, weight: .semibold))
          .foregroundStyle(.primary)
          .lineLimit(1)
        StatusLine(state: state, secondary: .secondary)
      }
      Spacer(minLength: 8)
      CountRuns(state: state, size: 18, separator: .secondary)
    }
    .padding(.horizontal, 16)
    .padding(.vertical, 12)
  }
}

struct CindyAgentActivityWidget: Widget {
  var body: some WidgetConfiguration {
    ActivityConfiguration(for: CindyAgentActivityAttributes.self) { context in
      ActivityBanner(state: context.state, appName: context.attributes.appName)
        .widgetURL(context.state.destinationURL)
    } dynamicIsland: { context in
      DynamicIsland {
        DynamicIslandExpandedRegion(.leading) {
          Identity(state: context.state, size: 36, dot: context.state.tint)
            .padding(.leading, 4)
        }
        DynamicIslandExpandedRegion(.trailing) {
          CountRuns(state: context.state, size: 20)
            .padding(.trailing, 4)
        }
        // Title and status share the center region so the avatar keeps the leading
        // column to itself (a bottom region would run under it).
        DynamicIslandExpandedRegion(.center) {
          VStack(alignment: .leading, spacing: 3) {
            Text(context.state.title.isEmpty ? context.attributes.appName : context.state.title)
              .font(.system(size: 15, weight: .semibold))
              .foregroundStyle(Palette.islandText)
              .lineLimit(1)
            StatusLine(state: context.state, secondary: Palette.islandSecondary)
          }
          .frame(maxWidth: .infinity, alignment: .leading)
        }
      } compactLeading: {
        Identity(state: context.state, size: 20)
      } compactTrailing: {
        CompactStatus(state: context.state)
      } minimal: {
        Identity(state: context.state, size: 20, dot: context.state.tint)
      }
      .widgetURL(context.state.destinationURL)
      .keylineTint(context.state.tint)
    }
  }
}
