import ActivityKit
import AppKit
import SwiftUI
import WidgetKit

// Widget extension that renders Cindy's task activity in the macOS Dynamic Island
// (or the menu bar Live Activity area on Macs without one). All text is localized
// by the main process; this target only lays it out.

@main
struct CindyAgentActivityBundle: WidgetBundle {
  var body: some Widget {
    CindyAgentActivityWidget()
  }
}

private extension CindyAgentActivityAttributes.ContentState {
  var needsUser: Bool { status == "attention" && attentionCount > 0 }
  var isCompleted: Bool { status == "completed" }
  /// Semantic status colors: system colors adapt to light and dark appearance.
  var tint: Color {
    if needsUser { return .orange }
    if isCompleted { return .green }
    return .primary
  }
}

private struct MascotView: View {
  let skin: String
  let size: CGFloat

  var body: some View {
    Group {
      if let image = Self.image(for: skin) {
        Image(nsImage: image).resizable().interpolation(.high).scaledToFit()
      } else {
        Image(systemName: "sparkles").resizable().scaledToFit()
      }
    }
    .frame(width: size, height: size)
  }

  static func image(for skin: String) -> NSImage? {
    let bundle = Bundle.main
    let url = bundle.url(forResource: skin, withExtension: "png", subdirectory: "mascots")
      ?? bundle.url(forResource: "cindy", withExtension: "png", subdirectory: "mascots")
    return url.flatMap(NSImage.init(contentsOf:))
  }
}

/// Compact trailing indicator: what waits on the user first, else the running count.
private struct StatusIndicator: View {
  let state: CindyAgentActivityAttributes.ContentState

  var body: some View {
    HStack(spacing: 3) {
      if state.needsUser {
        Image(systemName: "exclamationmark.circle.fill")
        Text("\(state.attentionCount)").monospacedDigit()
      } else if state.isCompleted {
        Image(systemName: "checkmark.circle.fill")
      } else {
        Text("\(max(1, state.runningCount))").monospacedDigit()
      }
    }
    .font(.system(size: 13, weight: .semibold))
    .foregroundStyle(state.tint)
  }
}

private struct ActivityBanner: View {
  let state: CindyAgentActivityAttributes.ContentState
  let appName: String

  var body: some View {
    HStack(spacing: 10) {
      MascotView(skin: state.mascot, size: 28)
      VStack(alignment: .leading, spacing: 2) {
        Text(state.title.isEmpty ? appName : state.title)
          .font(.headline)
          .lineLimit(1)
        Text(state.detail)
          .font(.subheadline)
          .foregroundStyle(.secondary)
          .lineLimit(1)
      }
      Spacer(minLength: 8)
      StatusIndicator(state: state)
    }
    .padding(.horizontal, 14)
    .padding(.vertical, 10)
  }
}

struct CindyAgentActivityWidget: Widget {
  var body: some WidgetConfiguration {
    ActivityConfiguration(for: CindyAgentActivityAttributes.self) { context in
      ActivityBanner(state: context.state, appName: context.attributes.appName)
    } dynamicIsland: { context in
      DynamicIsland {
        DynamicIslandExpandedRegion(.leading) {
          MascotView(skin: context.state.mascot, size: 32)
        }
        DynamicIslandExpandedRegion(.trailing) {
          StatusIndicator(state: context.state)
        }
        DynamicIslandExpandedRegion(.center) {
          Text(context.state.title.isEmpty ? context.attributes.appName : context.state.title)
            .font(.headline)
            .lineLimit(1)
        }
        DynamicIslandExpandedRegion(.bottom) {
          Text(context.state.detail)
            .font(.subheadline)
            .foregroundStyle(.secondary)
            .lineLimit(1)
        }
      } compactLeading: {
        MascotView(skin: context.state.mascot, size: 18)
      } compactTrailing: {
        StatusIndicator(state: context.state)
      } minimal: {
        MascotView(skin: context.state.mascot, size: 18)
      }
      .keylineTint(context.state.tint)
    }
  }
}
