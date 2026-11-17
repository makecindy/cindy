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
          Image(systemName: "clock")
            .font(.system(size: max(9, size * 0.35)))
        } else if showBadge {
          Circle().fill(state.tint)
            .frame(width: max(5, size * 0.3), height: max(5, size * 0.3))
            .overlay(Circle().stroke(.black, lineWidth: max(1, size * 0.06)))
        }
      }
      .accessibilityLabel(stale ? Text("activity.waitingForUpdate") : Text(state.detail))
  }
}

/// Same counts as the desktop task capsule: waiting + unread results · running.
private struct AgentActivityCounts: View {
  let state: CindyAgentActivityAttributes.ContentState
  let size: CGFloat
  var stale = false

  var body: some View {
    HStack(spacing: size * 0.25) {
      if state.noticeCount > 0 {
        Text(state.noticeCount, format: .number)
          .foregroundStyle(stale ? .secondary : (state.attentionCount > 0 ? AgentActivityPalette.attention : AgentActivityPalette.completed))
      }
      if state.noticeCount > 0 && state.runningCount > 0 {
        Text("·").foregroundStyle(.secondary)
      }
      if state.runningCount > 0 {
        Text(state.runningCount, format: .number).foregroundStyle(stale ? .secondary : AgentActivityPalette.running)
      }
    }
    .font(.system(size: size, weight: .semibold, design: .rounded)).monospacedDigit()
  }
}

private struct AgentActivityFreshness: View {
  let state: CindyAgentActivityAttributes.ContentState

  var body: some View {
    HStack(spacing: 4) {
      if let confirmedAt = state.confirmedAt, confirmedAt.isFinite, confirmedAt > 0 {
        Text("activity.lastUpdated")
        Text(Date(timeIntervalSince1970: confirmedAt), style: .time)
      } else {
        Text("activity.waitingForUpdate")
      }
    }
    .font(.caption)
    .lineLimit(1)
  }
}

/// Lock Screen and banner presentation of the aggregate task.
private struct AgentActivityBanner: View {
  let context: ActivityViewContext<CindyAgentActivityAttributes>

  var body: some View {
    HStack(spacing: 12) {
      AgentActivityMascot(state: context.state, size: 38, stale: context.isStale, showBadge: true)
      VStack(alignment: .leading, spacing: 4) {
        Text(context.state.title).font(.headline).lineLimit(1).privacySensitive()
        Text(context.state.detail)
          .font(.subheadline)
          .foregroundStyle(context.isStale ? WidgetPalette.ink2 : context.state.tint).lineLimit(2)
        if context.isStale {
          AgentActivityFreshness(state: context.state).foregroundStyle(WidgetPalette.ink2)
        }
      }
      Spacer(minLength: 0)
      AgentActivityCounts(state: context.state, size: 18, stale: context.isStale)
    }
    .padding(16)
    .activityBackgroundTint(WidgetPalette.background)
    .activitySystemActionForegroundColor(WidgetPalette.ink)
    .foregroundStyle(WidgetPalette.ink)
  }
}

/// The small family: Apple Watch's Smart Stack, and wherever else the system
/// asks for it. Two lines only, so a stale activity shows when it was last
/// confirmed instead of the old status line. The system supplies the
/// background there, so text uses system styles rather than the phone palette.
@available(iOS 18.0, *)
private struct AgentActivityGlance: View {
  let context: ActivityViewContext<CindyAgentActivityAttributes>

  var body: some View {
    HStack(spacing: 8) {
      AgentActivityMascot(state: context.state, size: 30, stale: context.isStale, showBadge: true)
      VStack(alignment: .leading, spacing: 2) {
        Text(context.state.title).font(.headline).lineLimit(1).privacySensitive()
        if context.isStale {
          AgentActivityFreshness(state: context.state).foregroundStyle(.secondary)
        } else {
          Text(context.state.detail).font(.subheadline).foregroundStyle(context.state.tint).lineLimit(1)
        }
      }
      Spacer(minLength: 0)
      AgentActivityCounts(state: context.state, size: 16, stale: context.isStale)
    }
    .foregroundStyle(.primary)
  }
}

@available(iOS 18.0, *)
private struct AgentActivityFamilyContent: View {
  @Environment(\.activityFamily) private var family
  let context: ActivityViewContext<CindyAgentActivityAttributes>

  var body: some View {
    switch family {
    case .small: AgentActivityGlance(context: context)
    default: AgentActivityBanner(context: context)
    }
  }
}

@MainActor
private enum AgentActivityPresentation {
  // Use the installed app's scheme (including CN/beta variants), not the task
  // URL from the latest push, for the stale Lock Screen fallback.
  private static var homeURL: URL? {
    guard let scheme = Bundle.main.object(forInfoDictionaryKey: "CindyURLScheme") as? String else { return nil }
    return URL(string: "\(scheme):///")
  }

  private static func taskURL(_ context: ActivityViewContext<CindyAgentActivityAttributes>) -> URL? {
    context.isStale ? homeURL : (URL(string: context.state.url) ?? homeURL)
  }

  private static func expandedTask(_ context: ActivityViewContext<CindyAgentActivityAttributes>) -> some View {
    VStack(alignment: .leading, spacing: 4) {
      Text(context.state.title).font(.headline).foregroundStyle(AgentActivityPalette.islandText)
        .lineLimit(1).privacySensitive()
      Text(context.state.detail)
        .font(.subheadline)
        .foregroundStyle(context.isStale ? AgentActivityPalette.islandSecondary : context.state.tint).lineLimit(2)
      if context.isStale {
        AgentActivityFreshness(state: context.state).foregroundStyle(AgentActivityPalette.islandSecondary)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    // Keep text inside the bottom region's rounded mask.
    .padding(.horizontal, 12)
    .padding(.bottom, 8)
    .contentShape(Rectangle())
  }

  static var configuration: some WidgetConfiguration {
    ActivityConfiguration(for: CindyAgentActivityAttributes.self) { context in
      Group {
        if #available(iOS 18.0, *) {
          AgentActivityFamilyContent(context: context)
        } else {
          AgentActivityBanner(context: context)
        }
      }
      .widgetURL(taskURL(context))
    } dynamicIsland: { context in
      DynamicIsland {
        DynamicIslandExpandedRegion(.leading) {
          AgentActivityMascot(state: context.state, size: 36, stale: context.isStale, showBadge: true)
            .padding(.leading, 4)
        }
        DynamicIslandExpandedRegion(.trailing) {
          AgentActivityCounts(state: context.state, size: 20, stale: context.isStale).padding(.trailing, 4)
        }
        DynamicIslandExpandedRegion(.bottom) {
          expandedTask(context)
        }
      } compactLeading: {
        AgentActivityMascot(state: context.state, size: 20, stale: context.isStale)
      } compactTrailing: {
        AgentActivityCounts(state: context.state, size: 13, stale: context.isStale)
      } minimal: {
        AgentActivityMascot(state: context.state, size: 20, stale: context.isStale, showBadge: true)
      }
      .keylineTint(context.state.tint)
      // No URL or Link: let iOS foreground the app without changing its route.
    }
  }
}

/// iOS 17: Lock Screen, banner and Dynamic Island.
struct CindyAgentActivityWidget: Widget {
  var body: some WidgetConfiguration {
    AgentActivityPresentation.configuration
  }
}

/// iOS 18+: the same activity, also offered in the small family so a paired
/// Apple Watch shows the task title and status in its Smart Stack. The bundle
/// registers exactly one of the two widgets.
@available(iOS 18.0, *)
struct CindyAgentActivityGlanceWidget: Widget {
  var body: some WidgetConfiguration {
    AgentActivityPresentation.configuration.supplementalActivityFamilies([.small])
  }
}
