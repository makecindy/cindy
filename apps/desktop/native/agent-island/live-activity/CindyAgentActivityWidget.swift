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
  var needsUser: Bool { status == "attention" && attentionCount > 0 }
  var isCompleted: Bool { status == "completed" }
  var tint: Color {
    if needsUser { return Palette.attention }
    if isCompleted { return Palette.completed }
    return Palette.running
  }
}

/// Asset-catalog mascot (build.mjs compiles `mascots/` into Assets.car; WidgetKit does
/// not archive file-loaded images). Skins drawn in code fall back to Cindy.
private struct MascotView: View {
  let skin: String
  let size: CGFloat
  var dot: Color? = nil

  var body: some View {
    Image(NSImage(named: skin) != nil ? skin : "cindy")
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

/// `● Needs input · 2 more tasks running`
private struct StatusLine: View {
  let state: CindyAgentActivityAttributes.ContentState
  let secondary: Color

  var body: some View {
    HStack(spacing: 5) {
      Circle().fill(state.tint).frame(width: 6, height: 6)
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
      MascotView(skin: state.mascot, size: 38, dot: state.tint)
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
    } dynamicIsland: { context in
      DynamicIsland {
        DynamicIslandExpandedRegion(.leading) {
          MascotView(skin: context.state.mascot, size: 36, dot: context.state.tint)
            .padding(.leading, 4)
        }
        DynamicIslandExpandedRegion(.trailing) {
          CountRuns(state: context.state, size: 20)
            .padding(.trailing, 4)
        }
        DynamicIslandExpandedRegion(.center) {
          Text(context.state.title.isEmpty ? context.attributes.appName : context.state.title)
            .font(.system(size: 15, weight: .semibold))
            .foregroundStyle(Palette.islandText)
            .lineLimit(1)
        }
        DynamicIslandExpandedRegion(.bottom) {
          StatusLine(state: context.state, secondary: Palette.islandSecondary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 4)
        }
      } compactLeading: {
        MascotView(skin: context.state.mascot, size: 20)
      } compactTrailing: {
        CompactStatus(state: context.state)
      } minimal: {
        MascotView(skin: context.state.mascot, size: 20, dot: context.state.tint)
      }
      .keylineTint(context.state.tint)
    }
  }
}
