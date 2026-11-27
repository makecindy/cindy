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

/// Dark tints of the companion hue families; mirrors the desktop Live Activity's
/// `companionHueColor` and `agentIslandCompanionHueColor` in the macOS island helper.
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

/// Companion avatar as the Mac island draws it: artwork, or its emoji / initial on the hue.
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
      .flatMap { UIImage(data: $0) }
      .map { Image(uiImage: $0) }
  }
}

/// Who the activity is about: the companion once its task needs the user or has
/// replied (same rule as macOS), otherwise Cindy in the pose for the status.
private struct AgentActivityMascot: View {
  let state: CindyAgentActivityAttributes.ContentState
  let size: CGFloat
  var showBadge = false

  var body: some View {
    identity
      .frame(width: size, height: size)
      .overlay(alignment: .bottomTrailing) {
        // An avatar has no pose, so it always carries the status dot.
        if showBadge || showsCompanion {
          Circle().fill(state.tint)
            .frame(width: max(5, size * 0.3), height: max(5, size * 0.3))
            .overlay(Circle().stroke(.black, lineWidth: max(1, size * 0.06)))
        }
      }
      .accessibilityLabel(Text(state.detail))
  }

  @Environment(\.redactionReasons) private var redactionReasons

  /// The avatar identifies the companion, so it follows the lock-screen privacy
  /// setting like the privacy-sensitive title: when the system redacts, show Cindy.
  private var showsCompanion: Bool {
    state.companion != nil && state.status != "running" && !redactionReasons.contains(.privacy)
  }

  @ViewBuilder private var identity: some View {
    if let companion = state.companion, showsCompanion {
      CompanionAvatarView(companion: companion, size: size)
    } else {
      Image("agent-island-\(state.pose)")
        .resizable().interpolation(.high).scaledToFit()
    }
  }
}

/// Same counts as the desktop Live Activity: waiting + unread results · running.
private struct AgentActivityCounts: View {
  let state: CindyAgentActivityAttributes.ContentState
  let size: CGFloat
  var showLabels = false

  var body: some View {
    HStack(alignment: .top, spacing: size * 0.25) {
      if state.noticeCount > 0 {
        VStack(spacing: 2) {
          Text(state.noticeCount, format: .number)
            .foregroundStyle(state.attentionCount > 0 ? AgentActivityPalette.attention : AgentActivityPalette.completed)
          if showLabels {
            Text("activity.toReview").font(.caption2).foregroundStyle(AgentActivityPalette.islandSecondary)
          }
        }
      }
      if state.noticeCount > 0 && state.runningCount > 0 {
        Text("·").foregroundStyle(.secondary)
      }
      if state.runningCount > 0 {
        VStack(spacing: 2) {
          Text(state.runningCount, format: .number).foregroundStyle(AgentActivityPalette.running)
          if showLabels {
            Text("activity.inProgress").font(.caption2).foregroundStyle(AgentActivityPalette.islandSecondary)
          }
        }
      }
    }
    .font(.system(size: size, weight: .semibold, design: .rounded)).monospacedDigit()
  }
}

/// Explain the left-hand total without changing the compact counts or APNs schema.
/// Pending includes both questions and approvals; unread can include error results.
private struct AgentActivityAttentionBreakdown: View {
  let state: CindyAgentActivityAttributes.ContentState

  private var pending: Int { min(state.noticeCount, max(0, state.attentionCount)) }
  private var unread: Int { state.noticeCount - pending }

  private var summary: Text {
    let pendingText = Text("activity.pendingCount \(pending)").foregroundColor(AgentActivityPalette.attention)
    let unreadText = Text("activity.unreadCount \(unread)").foregroundColor(AgentActivityPalette.completed)
    if pending == 0 { return unreadText }
    if unread == 0 { return pendingText }
    return pendingText + Text(" · ").foregroundColor(AgentActivityPalette.islandSecondary) + unreadText
  }

  var body: some View {
    summary.font(.footnote).lineLimit(2)
  }
}

// No view here reads `context.isStale`: the stale date is an internal deadline,
// never a state the user sees. The service ends the activity when it passes,
// and the app does when it is next opened and still cannot confirm the content.
// Until then the activity keeps showing the last content it received.

/// Lock Screen and banner presentation of the aggregate task.
private struct AgentActivityBanner: View {
  let context: ActivityViewContext<CindyAgentActivityAttributes>

  var body: some View {
    HStack(spacing: 12) {
      AgentActivityMascot(state: context.state, size: 38, showBadge: true)
      VStack(alignment: .leading, spacing: 4) {
        Text(context.state.title).font(.headline).lineLimit(1).privacySensitive()
        Text(context.state.detail)
          .font(.subheadline).foregroundStyle(context.state.tint).lineLimit(2)
      }
      Spacer(minLength: 0)
      AgentActivityCounts(state: context.state, size: 18)
    }
    .padding(16)
    .activityBackgroundTint(WidgetPalette.background)
    .activitySystemActionForegroundColor(WidgetPalette.ink)
    .foregroundStyle(WidgetPalette.ink)
  }
}

/// The small family: Apple Watch's Smart Stack, and wherever else the system
/// asks for it. Two lines only. The system supplies the background there, so
/// text uses system styles rather than the phone palette.
@available(iOS 18.0, *)
private struct AgentActivityGlance: View {
  let context: ActivityViewContext<CindyAgentActivityAttributes>

  var body: some View {
    HStack(spacing: 8) {
      AgentActivityMascot(state: context.state, size: 30, showBadge: true)
      VStack(alignment: .leading, spacing: 2) {
        Text(context.state.title).font(.headline).lineLimit(1).privacySensitive()
        Text(context.state.detail).font(.subheadline).foregroundStyle(context.state.tint).lineLimit(1)
      }
      Spacer(minLength: 0)
      AgentActivityCounts(state: context.state, size: 16)
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
  // Fallback for a payload whose task URL does not parse: the installed app's
  // own scheme (including CN/beta variants).
  private static var homeURL: URL? {
    guard let scheme = Bundle.main.object(forInfoDictionaryKey: "CindyURLScheme") as? String else { return nil }
    return URL(string: "\(scheme):///")
  }

  private static func taskURL(_ context: ActivityViewContext<CindyAgentActivityAttributes>) -> URL? {
    URL(string: context.state.url) ?? homeURL
  }

  private static func expandedTask(_ context: ActivityViewContext<CindyAgentActivityAttributes>) -> some View {
    VStack(alignment: .leading, spacing: 4) {
      Text(context.state.title).font(.headline).foregroundStyle(AgentActivityPalette.islandText)
        .lineLimit(1).privacySensitive()
      Text(context.state.detail)
        .font(.subheadline).foregroundStyle(context.state.tint).lineLimit(2)
      if context.state.noticeCount > 0 {
        AgentActivityAttentionBreakdown(state: context.state)
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
          AgentActivityMascot(state: context.state, size: 36, showBadge: true)
            .padding(.leading, 4)
        }
        DynamicIslandExpandedRegion(.trailing) {
          AgentActivityCounts(state: context.state, size: 20, showLabels: true)
            .multilineTextAlignment(.center)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: 160)
            .padding(.trailing, 4)
        }
        DynamicIslandExpandedRegion(.bottom) {
          expandedTask(context)
        }
      } compactLeading: {
        AgentActivityMascot(state: context.state, size: 27)
      } compactTrailing: {
        AgentActivityCounts(state: context.state, size: 13)
      } minimal: {
        AgentActivityMascot(state: context.state, size: 27, showBadge: true)
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
