import ActivityKit
import SwiftUI
import WidgetKit

// Exported from the desktop Live Activity's Palette and mascot renderer by
// scripts/export-agent-activity-artwork.mjs. No independently drawn phone skin.
private enum AgentActivityPalette {
  static let running = Color("agent-island-running")
  static let attention = Color("agent-island-attention")
  static let completed = Color("agent-island-completed")
  // The system island is black in either appearance, as on macOS.
  static let islandText = Color.white
  static let islandSecondary = Color.white.opacity(0.62)
}

private extension CindyAgentActivityAttributes.ContentState {
  var pose: String {
    switch status {
    case "attention": return "attention"
    case "completed", "error": return "completed"
    default: return "running"
    }
  }
  var tint: Color {
    switch pose {
    case "attention": return AgentActivityPalette.attention
    case "completed": return AgentActivityPalette.completed
    default: return AgentActivityPalette.running
    }
  }
}

private struct AgentActivityMascot: View {
  let state: CindyAgentActivityAttributes.ContentState
  let size: CGFloat
  var stale = false
  var showBadge = false

  var body: some View {
    Image("agent-island-\(state.pose)")
      .resizable().interpolation(.high).scaledToFit()
      .frame(width: size, height: size)
      .overlay(alignment: .bottomTrailing) {
        if stale {
          Image(systemName: "clock.badge.exclamationmark")
            .font(.system(size: max(9, size * 0.35)))
        } else if showBadge {
          Circle().fill(state.tint)
            .frame(width: max(5, size * 0.3), height: max(5, size * 0.3))
            .overlay(Circle().stroke(.black, lineWidth: max(1, size * 0.06)))
        }
      }
      .accessibilityLabel(stale ? state.staleDetail : state.detail)
  }
}

/// Same counts as the desktop task capsule: waiting + unread results · running.
private struct AgentActivityCounts: View {
  let state: CindyAgentActivityAttributes.ContentState
  let size: CGFloat

  var body: some View {
    HStack(spacing: size * 0.25) {
      if state.noticeCount > 0 {
        Text(state.noticeCount, format: .number)
          .foregroundStyle(state.attentionCount > 0 ? AgentActivityPalette.attention : AgentActivityPalette.completed)
      }
      if state.noticeCount > 0 && state.runningCount > 0 {
        Text("·").foregroundStyle(.secondary)
      }
      if state.runningCount > 0 {
        Text(state.runningCount, format: .number).foregroundStyle(AgentActivityPalette.running)
      }
    }
    .font(.system(size: size, weight: .semibold, design: .rounded)).monospacedDigit()
  }
}

struct CindyAgentActivityWidget: Widget {
  var body: some WidgetConfiguration {
    ActivityConfiguration(for: CindyAgentActivityAttributes.self) { context in
      HStack(spacing: 12) {
        AgentActivityMascot(state: context.state, size: 38, stale: context.isStale, showBadge: true)
        VStack(alignment: .leading, spacing: 4) {
          Text(context.state.title).font(.headline).lineLimit(1).privacySensitive()
          Text(context.isStale ? context.state.staleDetail : context.state.detail)
            .font(.subheadline)
            .foregroundStyle(context.isStale ? WidgetPalette.ink2 : context.state.tint).lineLimit(2)
        }
        Spacer(minLength: 0)
        AgentActivityCounts(state: context.state, size: 18)
      }
      .padding(16)
      .activityBackgroundTint(WidgetPalette.background)
      .activitySystemActionForegroundColor(WidgetPalette.ink)
      .foregroundStyle(WidgetPalette.ink)
      .widgetURL(URL(string: context.state.url))
    } dynamicIsland: { context in
      DynamicIsland {
        DynamicIslandExpandedRegion(.leading) {
          AgentActivityMascot(state: context.state, size: 36, stale: context.isStale, showBadge: true)
            .padding(.leading, 4)
        }
        DynamicIslandExpandedRegion(.trailing) {
          AgentActivityCounts(state: context.state, size: 20).padding(.trailing, 4)
        }
        DynamicIslandExpandedRegion(.bottom) {
          VStack(alignment: .leading, spacing: 4) {
            Text(context.state.title).font(.headline).foregroundStyle(AgentActivityPalette.islandText)
              .lineLimit(1).privacySensitive()
            Text(context.isStale ? context.state.staleDetail : context.state.detail)
              .font(.subheadline)
              .foregroundStyle(context.isStale ? AgentActivityPalette.islandSecondary : context.state.tint).lineLimit(2)
          }
          .frame(maxWidth: .infinity, alignment: .leading)
          // The bottom region's rounded mask can cut into glyphs even while
          // they are inside the outer island. Keep both lines away from its
          // side curves and reserve space below the last baseline.
          .padding(.horizontal, 12)
          .padding(.bottom, 8)
        }
      } compactLeading: {
        AgentActivityMascot(state: context.state, size: 20, stale: context.isStale)
      } compactTrailing: {
        AgentActivityCounts(state: context.state, size: 13)
      } minimal: {
        AgentActivityMascot(state: context.state, size: 20, stale: context.isStale, showBadge: true)
      }
      .keylineTint(context.state.tint)
      .widgetURL(URL(string: context.state.url))
    }
  }

}
