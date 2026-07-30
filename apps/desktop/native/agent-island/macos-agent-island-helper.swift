import AppKit
import Foundation
import QuartzCore
import SwiftUI

private let agentIslandSoundIds: Set<String> = [
  "startup-chime",
  "ring-chime",
  "item-found",
  "gem-collect",
  "item-fanfare",
  "victory-fanfare",
  "error-buzz",
  "secret-chime",
]

final class AgentIslandSoundPlayer: NSObject, NSSoundDelegate {
  static let shared = AgentIslandSoundPlayer()

  private var activeSounds: [NSSound] = []

  func play(soundId: String) {
    guard agentIslandSoundIds.contains(soundId), let url = soundURL(soundId: soundId) else {
      return
    }
    play(url: url)
  }

  func play(filePath: String) {
    guard !filePath.isEmpty else { return }
    let url = URL(fileURLWithPath: filePath)
    guard FileManager.default.fileExists(atPath: url.path) else {
      return
    }
    play(url: url)
  }

  private func play(url: URL) {
    guard let sound = NSSound(contentsOf: url, byReference: false) else {
      return
    }
    sound.volume = 0.58
    sound.delegate = self
    activeSounds.append(sound)
    sound.play()
  }

  func sound(_ sound: NSSound, didFinishPlaying flag: Bool) {
    activeSounds.removeAll { $0 === sound }
  }

  private func soundURL(soundId: String) -> URL? {
    for base in soundBaseDirectories() {
      let url = base
        .appendingPathComponent("sounds", isDirectory: true)
        .appendingPathComponent("\(soundId).mp3")
      if FileManager.default.fileExists(atPath: url.path) {
        return url
      }
    }
    return nil
  }

  private func soundBaseDirectories() -> [URL] {
    var urls: [URL] = []
    let environment = ProcessInfo.processInfo.environment
    if let assetDir = environment["XDT_AGENT_ISLAND_ASSET_DIR"], !assetDir.isEmpty {
      urls.append(URL(fileURLWithPath: assetDir))
    }
    if let executablePath = CommandLine.arguments.first, !executablePath.isEmpty {
      urls.append(URL(fileURLWithPath: executablePath).deletingLastPathComponent())
    }
    urls.append(
      URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
        .appendingPathComponent("apps")
        .appendingPathComponent("desktop")
        .appendingPathComponent("native")
        .appendingPathComponent("agent-island")
    )
    return urls
  }
}

enum AgentIslandMascotAnimationState: Equatable {
  case idle
  case working
  case waitingApproval
  case completed
}

private struct AgentIslandMascotAnimationsActiveKey: EnvironmentKey {
  static let defaultValue = true
}

private struct AgentIslandMascotAnimationEpochKey: EnvironmentKey {
  static let defaultValue = 0
}

private extension EnvironmentValues {
  var agentIslandMascotAnimationsActive: Bool {
    get { self[AgentIslandMascotAnimationsActiveKey.self] }
    set { self[AgentIslandMascotAnimationsActiveKey.self] = newValue }
  }

  var agentIslandMascotAnimationEpoch: Int {
    get { self[AgentIslandMascotAnimationEpochKey.self] }
    set { self[AgentIslandMascotAnimationEpochKey.self] = newValue }
  }
}

private extension View {
  func agentIslandMascotAnimationsActive(_ active: Bool) -> some View {
    environment(\.agentIslandMascotAnimationsActive, active)
  }

  func agentIslandMascotAnimationEpoch(_ epoch: Int) -> some View {
    environment(\.agentIslandMascotAnimationEpoch, epoch)
  }
}

private func agentIslandMascotLerp(_ keyframes: [(CGFloat, CGFloat)], at pct: CGFloat) -> CGFloat {
  guard let first = keyframes.first else { return 0 }
  if pct <= first.0 { return first.1 }
  for index in 1..<keyframes.count {
    if pct <= keyframes[index].0 {
      let span = keyframes[index].0 - keyframes[index - 1].0
      guard span > 0 else { return keyframes[index].1 }
      let t = (pct - keyframes[index - 1].0) / span
      return keyframes[index - 1].1 + (keyframes[index].1 - keyframes[index - 1].1) * t
    }
  }
  return keyframes.last?.1 ?? 0
}

struct PululuMascotView: View {
  let size: CGFloat
  let state: AgentIslandMascotAnimationState
  @State private var alive = false
  @State private var timelineStart = Date().timeIntervalSinceReferenceDate
  @Environment(\.agentIslandMascotAnimationsActive) private var animationsActive
  @Environment(\.agentIslandMascotAnimationEpoch) private var animationEpoch

  private static let shellC = Color(red: 0.91, green: 0.93, blue: 0.96)
  private static let faceC = Color(red: 0.29, green: 0.29, blue: 0.34)
  private static let footC = Color(red: 0.95, green: 0.85, blue: 0.45)
  private static let eyeC = Color(red: 0.96, green: 0.97, blue: 1.0)
  private static let alertC = Color(red: 0.0, green: 0.85, blue: 0.77)
  private static let approvalGlowC = Color(red: 1.0, green: 0.72, blue: 0.20)
  private static let kbBase = Color(red: 0.16, green: 0.18, blue: 0.23)
  private static let kbKey = Color(red: 0.44, green: 0.49, blue: 0.58)
  private static let kbHi = Color.white
  private static let idleCycleDuration: Double = 4.8
  private static let idleSleepStart: Double = 1.15

  var body: some View {
    ZStack {
      switch state {
      case .idle:
        sleepScene
      case .working:
        workScene
      case .waitingApproval:
        alertScene
      case .completed:
        completionScene
      }
    }
    .frame(width: size, height: size)
    .clipped()
    .onAppear {
      restartTimeline()
    }
    .onChange(of: state) { _, _ in
      restartTimeline()
    }
    .onChange(of: animationEpoch) { _, _ in
      restartTimeline()
    }
  }

  @ViewBuilder
  private func timeline<Content: View>(
    every interval: TimeInterval,
    staticTime: Double = 0,
    @ViewBuilder content: @escaping (Double) -> Content
  ) -> some View {
    if animationsActive {
      TimelineView(.periodic(from: .now, by: interval)) { ctx in
        content(ctx.date.timeIntervalSinceReferenceDate - timelineStart)
      }
      .id(animationEpoch)
    } else {
      content(staticTime)
    }
  }

  private func restartTimeline() {
    alive = false
    timelineStart = Date().timeIntervalSinceReferenceDate
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) {
      alive = true
    }
  }

  private struct V {
    let ox: CGFloat
    let oy: CGFloat
    let s: CGFloat

    init(_ sz: CGSize, w: CGFloat = 16, h: CGFloat = 16) {
      s = min(sz.width / w, sz.height / h)
      ox = (sz.width - w * s) / 2
      oy = (sz.height - h * s) / 2
    }

    func rect(_ x: CGFloat, _ y: CGFloat, _ w: CGFloat, _ h: CGFloat, dy: CGFloat = 0) -> CGRect {
      CGRect(x: ox + x * s, y: oy + (y + dy) * s, width: w * s, height: h * s)
    }

    func ellipse(cx: CGFloat, cy: CGFloat, rx: CGFloat, ry: CGFloat? = nil, dy: CGFloat = 0) -> CGRect {
      let ey = ry ?? rx
      return rect(cx - rx, cy - ey, rx * 2, ey * 2, dy: dy)
    }
  }

  private func rounded(_ rect: CGRect, radius: CGFloat) -> Path {
    Path(roundedRect: rect, cornerRadius: radius)
  }

  private func drawShadow(_ c: GraphicsContext, v: V, width: CGFloat, opacity: Double, dy: CGFloat = 0) {
    c.fill(
      Path(ellipseIn: v.ellipse(cx: 8, cy: 14.0, rx: width / 2, ry: 0.55, dy: dy)),
      with: .color(.black.opacity(opacity))
    )
  }

  private func drawPululu(
    _ c: GraphicsContext,
    v: V,
    dy: CGFloat = 0,
    squashX: CGFloat = 1,
    squashY: CGFloat = 1,
    eyeScale: CGFloat = 1,
    eyeOpacity: Double = 1,
    eyeYOffset: CGFloat = 0,
    eyesBright: Bool = false,
    headAngle: CGFloat = 0
  ) {
    let shellRx = 5.95 * squashX
    let shellRy = 5.95 * squashY
    let shellCy = 8.15 + (1 - squashY) * 2.2
    let faceRx = 4.15 * squashX
    let faceRy = 4.15 * squashY
    let faceCy = 6.95 + (1 - squashY) * 1.7

    c.fill(
      Path(ellipseIn: v.ellipse(cx: 8, cy: shellCy, rx: shellRx, ry: shellRy, dy: dy)),
      with: .color(Self.shellC)
    )

    var head = c
    if abs(headAngle) > 0.001 {
      let center = CGPoint(x: v.ox + 8 * v.s, y: v.oy + (faceCy + dy) * v.s)
      head.translateBy(x: center.x, y: center.y)
      head.rotate(by: .radians(Double(headAngle)))
      head.translateBy(x: -center.x, y: -center.y)
    }

    head.fill(
      Path(ellipseIn: v.ellipse(cx: 8, cy: faceCy, rx: faceRx, ry: faceRy, dy: dy)),
      with: .color(Self.faceC)
    )
    drawEyes(head, v: v, dy: dy + eyeYOffset, scale: eyeScale, opacity: eyeOpacity, bright: eyesBright)

    c.fill(
      Path(ellipseIn: v.ellipse(cx: 4.45, cy: 11.25, rx: 1.1, ry: 1.25, dy: dy)),
      with: .color(Self.footC)
    )
    c.fill(
      Path(ellipseIn: v.ellipse(cx: 11.55, cy: 11.25, rx: 1.1, ry: 1.25, dy: dy)),
      with: .color(Self.footC)
    )
  }

  private func drawEyes(
    _ c: GraphicsContext,
    v: V,
    dy: CGFloat,
    scale: CGFloat,
    opacity: Double,
    bright: Bool
  ) {
    let openness = scale < 0.25 ? 0 : min(scale, 1.25)
    let closed = 1 - min(openness, 1)
    let w = 1.30 + closed * 0.08
    let h = 0.22 + openness * 1.58
    let cy: CGFloat = 6.72
    let left = v.rect(6.05 - w / 2, cy - h / 2, w, h, dy: dy)
    let right = v.rect(9.95 - w / 2, cy - h / 2, w, h, dy: dy)
    let color = bright ? Color.white : Self.eyeC
    let radius = min(w, h) * v.s * 0.5

    if bright {
      c.fill(
        rounded(left.insetBy(dx: -0.1 * v.s, dy: -0.12 * v.s), radius: radius),
        with: .color(Color(red: 0.52, green: 0.61, blue: 1.0).opacity(0.26))
      )
      c.fill(
        rounded(right.insetBy(dx: -0.1 * v.s, dy: -0.12 * v.s), radius: radius),
        with: .color(Color(red: 0.52, green: 0.61, blue: 1.0).opacity(0.26))
      )
    }

    c.fill(rounded(left, radius: radius), with: .color(color.opacity(opacity)))
    c.fill(rounded(right, radius: radius), with: .color(color.opacity(opacity)))
  }

  private func drawKeyboard(_ c: GraphicsContext, v: V, phase: Int, dy: CGFloat) {
    c.fill(Path(v.rect(0.5, 12.0, 15, 3, dy: dy)), with: .color(Self.kbBase))
    for row in 0..<2 {
      let ky = 12.5 + CGFloat(row) * 1.2
      for col in 0..<6 {
        let kx = 1.0 + CGFloat(col) * 2.4
        c.fill(Path(v.rect(kx, ky, 1.8, 0.7, dy: dy)), with: .color(Self.kbKey))
      }
    }

    let flashRow = phase / 3
    let flashCol = phase % 6
    let fkx = 1.0 + CGFloat(flashCol) * 2.4
    let fky = 12.5 + CGFloat(flashRow) * 1.2
    c.fill(Path(v.rect(fkx, fky, 1.8, 0.7, dy: dy)), with: .color(Self.kbHi.opacity(0.9)))
  }

  private func drawBang(_ c: GraphicsContext, v: V, pct: CGFloat, jumpY: CGFloat) {
    let opacity = agentIslandMascotLerp([
      (0, 0), (0.03, 1), (0.10, 1), (0.55, 1), (0.62, 0), (1, 0),
    ], at: pct)
    guard opacity > 0.01 else { return }

    let scale = agentIslandMascotLerp([
      (0, 0.3), (0.03, 1.3), (0.10, 1.0), (0.55, 1.0), (0.62, 0.6), (1, 0.6),
    ], at: pct)
    let bw: CGFloat = 1.65 * scale
    let bx: CGFloat = 13
    let by: CGFloat = 1.0 + jumpY * 0.15
    c.fill(
      rounded(v.rect(bx, by, bw, 3.5 * scale, dy: 0), radius: bw * v.s * 0.45),
      with: .color(Self.alertC.opacity(Double(opacity)))
    )
    c.fill(
      rounded(v.rect(bx, by + 4.05 * scale, bw, 1.45 * scale, dy: 0), radius: bw * v.s * 0.45),
      with: .color(Self.alertC.opacity(Double(opacity)))
    )
  }

  private func drawCompletionBadge(_ c: GraphicsContext, v: V, pct: CGFloat) {
    let fade = pct < 0.92 ? 1.0 : max(0, (1.0 - pct) / 0.08)
    let badgeScale = agentIslandMascotLerp([
      (0, 0.15), (0.10, 1.20), (0.20, 0.94),
      (0.32, 1.0), (0.92, 1.0), (1, 0.90),
    ], at: pct)
    let cx: CGFloat = 8
    let cy: CGFloat = 8.05
    let badgeR: CGFloat = 5.95 * badgeScale

    c.fill(
      Path(ellipseIn: v.ellipse(cx: cx, cy: cy, rx: badgeR, ry: badgeR)),
      with: .color(Self.alertC.opacity(Double(fade)))
    )
    c.fill(
      Path(ellipseIn: v.ellipse(
        cx: cx - 1.55 * badgeScale,
        cy: cy - 1.85 * badgeScale,
        rx: 1.08 * badgeScale,
        ry: 0.55 * badgeScale
      )),
      with: .color(Color.white.opacity(Double(0.25 * fade)))
    )

    var check = Path()
    check.move(to: CGPoint(x: v.ox + (cx - 2.38 * badgeScale) * v.s, y: v.oy + (cy + 0.18 * badgeScale) * v.s))
    check.addLine(to: CGPoint(x: v.ox + (cx - 0.62 * badgeScale) * v.s, y: v.oy + (cy + 1.86 * badgeScale) * v.s))
    check.addLine(to: CGPoint(x: v.ox + (cx + 2.92 * badgeScale) * v.s, y: v.oy + (cy - 2.10 * badgeScale) * v.s))
    c.stroke(
      check,
      with: .color(Color.white.opacity(Double(fade))),
      style: StrokeStyle(lineWidth: 1.10 * badgeScale * v.s, lineCap: .round, lineJoin: .round)
    )
  }

  private var sleepScene: some View {
    ZStack {
      timeline(every: 0.06) { t in
        sleepCanvas(t: t)
      }
      timeline(every: 0.05) { t in
        floatingZs(t: t)
      }
    }
  }

  private func floatingZs(t: Double) -> some View {
    ZStack {
      ForEach(0..<3, id: \.self) { i in
        let ci = Double(i)
        let idleTime = t.truncatingRemainder(dividingBy: Self.idleCycleDuration)
        let sleepElapsed = idleTime - Self.idleSleepStart
        let cycle = 2.8 + ci * 0.3
        let delay = ci * 0.9
        let localT = sleepElapsed - delay
        let phase = localT >= 0 ? (localT.truncatingRemainder(dividingBy: cycle)) / cycle : 0
        let p = max(0, phase)
        let fontSize = max(6, size * CGFloat(0.18 + p * 0.10))
        let baseOpacity = 0.7 - ci * 0.1
        let sleepOpacity = sleepElapsed >= delay ? 1.0 : 0.0
        let opacity = sleepOpacity * (p < 0.8 ? baseOpacity : (1.0 - p) * 3.5 * baseOpacity)
        let xOff = size * CGFloat(0.08 + ci * 0.06 + sin(p * .pi * 2) * 0.03)
        let yOff = -size * CGFloat(0.15 + p * 0.38)
        Text("z")
          .font(.system(size: fontSize, weight: .black, design: .monospaced))
          .foregroundStyle(Color.white.opacity(opacity))
          .offset(x: xOff, y: yOff)
      }
    }
  }

  private func sleepCanvas(t: Double) -> some View {
    let idleTime = t.truncatingRemainder(dividingBy: Self.idleCycleDuration)
    let phase = idleTime / Self.idleCycleDuration
    let float = sin(phase * .pi * 2) * 0.55
    let breathe = sin(phase * .pi * 2 + 0.6)
    let eyeScale = agentIslandMascotLerp([
      (0.0, 1.10),
      (CGFloat(Self.idleSleepStart - 0.18), 1.10),
      (CGFloat(Self.idleSleepStart), 0.0),
      (CGFloat(Self.idleCycleDuration - 0.28), 0.0),
      (CGFloat(Self.idleCycleDuration), 1.10),
    ], at: CGFloat(idleTime))

    return Canvas(rendersAsynchronously: true) { c, sz in
      let v = V(sz)
      drawShadow(c, v: v, width: 8.2 - abs(float) * 0.25, opacity: 0.22)
      drawPululu(
        c,
        v: v,
        dy: float,
        squashX: 1 + breathe * 0.012,
        squashY: 1 - breathe * 0.010,
        eyeScale: eyeScale,
        eyeOpacity: 0.95
      )
    }
  }

  private var workScene: some View {
    timeline(every: 0.03) { t in
      workCanvas(t: t)
    }
  }

  private func workCanvas(t: Double) -> some View {
    let bounce = sin(t * 2 * .pi / 0.38) * 0.75
    let breathe = sin(t * 2 * .pi / 2.6)
    let keyPhase = Int(t / 0.1) % 6
    let blinkPhase = t.truncatingRemainder(dividingBy: 3.2)
    let eyeScale: CGFloat = blinkPhase > 1.15 && blinkPhase < 1.26 ? 0.0 : 1.0
    let headTurn = CGFloat(sin(t * 2 * .pi / 0.86)) * 0.26

    return Canvas(rendersAsynchronously: true) { c, sz in
      let v = V(sz)
      let dy = CGFloat(bounce - 0.25)
      let squashY: CGFloat = dy > 0.25 ? 0.98 : 1.0

      drawShadow(c, v: v, width: 8.1 - abs(dy) * 0.32, opacity: 0.30)
      // 键盘先画：角色要挡在键盘前面，而不是被键盘条横切。
      drawKeyboard(c, v: v, phase: keyPhase, dy: -0.05)
      drawPululu(
        c,
        v: v,
        dy: dy,
        squashX: 1.0 + CGFloat(breathe) * 0.008 + (dy > 0.25 ? 0.018 : 0),
        squashY: squashY,
        eyeScale: eyeScale,
        eyeOpacity: 1,
        eyeYOffset: 0.18,
        eyesBright: true,
        headAngle: headTurn
      )
    }
  }

  private var alertScene: some View {
    let glowActive = alive && animationsActive
    return ZStack {
      Circle()
        .fill(Self.approvalGlowC.opacity(glowActive ? 0.14 : 0))
        .frame(width: size * 0.86)
        .blur(radius: size * 0.06)
        .animation(
          animationsActive ? .easeInOut(duration: 0.48).repeatForever(autoreverses: true) : .default,
          value: glowActive
        )

      timeline(every: 0.03) { t in
        alertCanvas(t: t)
      }
    }
  }

  private func alertCanvas(t: Double) -> some View {
    let cycle = t.truncatingRemainder(dividingBy: 3.5)
    let pct = CGFloat(cycle / 3.5)
    let jumpY = agentIslandMascotLerp([
      (0, 0), (0.03, 0), (0.10, -0.4), (0.15, 0.55),
      (0.175, -3.7), (0.20, -3.7), (0.25, 0.55),
      (0.275, -3.0), (0.30, -3.0), (0.35, 0.45),
      (0.375, -1.9), (0.40, -1.9), (0.45, 0.36),
      (0.475, -1.1), (0.50, -1.1), (0.55, 0.18),
      (0.62, 0), (1, 0),
    ], at: pct)

    let landing = max(0, jumpY)
    let squashX = 1 + landing * 0.08
    let squashY = 1 - landing * 0.05
    let eyeScale: CGFloat = pct > 0.03 && pct < 0.16 ? 1.22 : 1.0
    let shakeX: CGFloat = pct > 0.08 && pct < 0.62 ? sin(pct * .pi * 18) * 0.55 : 0
    let headWobble: CGFloat = pct > 0.08 && pct < 0.62 ? sin(pct * .pi * 16) * 0.23 : 0

    return Canvas(rendersAsynchronously: true) { c, sz in
      let v = V(sz)
      drawShadow(c, v: v, width: 8.4 - abs(min(0, jumpY)) * 0.42, opacity: 0.36)
      var body = c
      body.translateBy(x: shakeX * v.s, y: 0)
      drawPululu(
        body,
        v: v,
        dy: jumpY,
        squashX: squashX,
        squashY: squashY,
        eyeScale: eyeScale,
        eyeOpacity: 1,
        eyeYOffset: pct > 0.03 && pct < 0.16 ? -0.16 : 0,
        eyesBright: true,
        headAngle: headWobble
      )
      drawBang(c, v: v, pct: pct, jumpY: jumpY)
    }
  }

  private var completionScene: some View {
    timeline(every: 0.03) { t in
      completionCanvas(t: t)
    }
  }

  private func completionCanvas(t: Double) -> some View {
    let cycleDuration: Double = 2.05
    let cycle = t.truncatingRemainder(dividingBy: cycleDuration)
    let pct = CGFloat(cycle / cycleDuration)
    let mascotPct = min(1, pct / 0.58)
    let badgePct = max(0, min(1, (pct - 0.54) / 0.46))
    let jumpPhase = mascotPct * 3.0
    let jumpLocal = jumpPhase.truncatingRemainder(dividingBy: 1.0)
    let hop = -sin(jumpLocal * .pi) * (2.05 + mascotPct * 0.55)
    let disappear = agentIslandMascotLerp([
      (0, 1), (0.78, 1), (1, 0),
    ], at: mascotPct)
    let shrink = agentIslandMascotLerp([
      (0, 1), (0.78, 1), (1, 0.18),
    ], at: mascotPct)
    let headNod = sin(Double(jumpPhase) * .pi * 2) * 0.18
    let eyePulse = 1.04 + sin(Double(jumpPhase) * .pi * 2) * 0.07

    return Canvas(rendersAsynchronously: true) { c, sz in
      let v = V(sz)
      if mascotPct < 1 {
        let dy = hop
        drawShadow(c, v: v, width: 8.0 - abs(dy) * 0.36, opacity: 0.26 * Double(disappear))
        var mascot = c
        let center = CGPoint(x: v.ox + 8 * v.s, y: v.oy + 8.15 * v.s)
        mascot.translateBy(x: center.x, y: center.y)
        mascot.scaleBy(x: shrink, y: shrink)
        mascot.translateBy(x: -center.x, y: -center.y)
        mascot.opacity = Double(disappear)
        drawPululu(
          mascot,
          v: v,
          dy: dy,
          squashX: 1.0 + max(0, dy) * 0.035,
          squashY: 1.0 - max(0, dy) * 0.025,
          eyeScale: eyePulse,
          eyeOpacity: 1,
          eyeYOffset: 0.02,
          eyesBright: true,
          headAngle: headNod
        )
      }
      if badgePct > 0 {
        drawCompletionBadge(c, v: v, pct: badgePct)
      }
    }
  }
}

/// Per-skin parameters ported from the Code Island SwiftUI mascot export.
struct SpriteMascotConfig {
  let image: Image?
  let fallbackColor: Color
  let alertColor: Color
  let completionBadgeColor: Color
  let eyeColor: Color
  let approvalGlowColor: Color
  let keyboardBaseColor: Color
  let keyboardKeyColor: Color
  let bodyScale: CGFloat
  let eyeLeftX: CGFloat
  let eyeRightX: CGFloat
  let eyeY: CGFloat
  let eyeRxBase: CGFloat
  let eyeRxClosedAdd: CGFloat
  let eyeRyMin: CGFloat
  let eyeRyOpen: CGFloat
  let eyeRyClosedAdd: CGFloat

  static let tarara = SpriteMascotConfig(
    image: AgentIslandAssets.tararaMascotImage.map { Image(nsImage: $0) },
    fallbackColor: Color(red: 1.0, green: 0.72, blue: 0.20),
    alertColor: Color(red: 0.0, green: 0.85, blue: 0.77),
    completionBadgeColor: Color(red: 0.0, green: 0.85, blue: 0.77),
    eyeColor: Color(red: 0.239, green: 0.447, blue: 0.894),
    approvalGlowColor: Color(red: 0.0, green: 0.85, blue: 0.77),
    keyboardBaseColor: Color(red: 0.00, green: 0.38, blue: 0.34),
    keyboardKeyColor: Color(red: 0.00, green: 0.85, blue: 0.77),
    bodyScale: 1.0,
    eyeLeftX: 6.9,
    eyeRightX: 9.7,
    eyeY: 10.40,
    eyeRxBase: 0.585,
    eyeRxClosedAdd: 0.55,
    eyeRyMin: 0.40,
    eyeRyOpen: 0.98,
    eyeRyClosedAdd: 0.08
  )

  static let boli = SpriteMascotConfig(
    image: AgentIslandAssets.boliMascotImage.map { Image(nsImage: $0) },
    fallbackColor: Color(red: 0.96, green: 0.48, blue: 0.48),
    alertColor: Color(red: 0.949, green: 0.988, blue: 0.463),
    completionBadgeColor: Color(red: 0.620, green: 0.761, blue: 0.961),
    eyeColor: .black,
    approvalGlowColor: Color(red: 0.949, green: 0.988, blue: 0.463),
    keyboardBaseColor: Color(red: 0.16, green: 0.18, blue: 0.23),
    keyboardKeyColor: Color(red: 0.44, green: 0.49, blue: 0.58),
    bodyScale: 0.80,
    eyeLeftX: 5.63,
    eyeRightX: 10.63,
    eyeY: 8.13,
    eyeRxBase: 0.88,
    eyeRxClosedAdd: 0.28,
    eyeRyMin: 0.30,
    eyeRyOpen: 0.88,
    eyeRyClosedAdd: 0.08
  )

  static let whitesnow = SpriteMascotConfig(
    image: AgentIslandAssets.whitesnowMascotImage.map { Image(nsImage: $0) },
    fallbackColor: Color(red: 0.92, green: 0.16, blue: 0.13),
    alertColor: Color(red: 0.976, green: 0.882, blue: 0.345),
    completionBadgeColor: Color(red: 0.569, green: 0.682, blue: 0.373),
    eyeColor: .black,
    approvalGlowColor: Color(red: 0.976, green: 0.882, blue: 0.345),
    keyboardBaseColor: Color(red: 0.16, green: 0.18, blue: 0.23),
    keyboardKeyColor: Color(red: 0.44, green: 0.49, blue: 0.58),
    bodyScale: 1.0,
    eyeLeftX: 6.86,
    eyeRightX: 9.50,
    eyeY: 9.64,
    eyeRxBase: 0.465,
    eyeRxClosedAdd: 0.48,
    eyeRyMin: 0.39,
    eyeRyOpen: 1.02,
    eyeRyClosedAdd: 0.09
  )

  static let annie = SpriteMascotConfig(
    image: AgentIslandAssets.annieMascotImage.map { Image(nsImage: $0) },
    fallbackColor: Color(red: 0.98, green: 0.56, blue: 0.68),
    alertColor: Color(red: 0.992, green: 0.388, blue: 0.549),
    completionBadgeColor: Color(red: 0.467, green: 0.769, blue: 0.918),
    eyeColor: Color(red: 0.682, green: 0.129, blue: 0.275),
    approvalGlowColor: Color(red: 0.992, green: 0.388, blue: 0.549),
    keyboardBaseColor: Color(red: 0.18, green: 0.42, blue: 0.56),
    keyboardKeyColor: Color(red: 0.467, green: 0.769, blue: 0.918),
    bodyScale: 1.0,
    eyeLeftX: 6.31,
    eyeRightX: 9.56,
    eyeY: 11.69,
    eyeRxBase: 0.585,
    eyeRxClosedAdd: 0.55,
    eyeRyMin: 0.40,
    eyeRyOpen: 0.98,
    eyeRyClosedAdd: 0.08
  )

  static let chaku = SpriteMascotConfig(
    image: AgentIslandAssets.chakuMascotImage.map { Image(nsImage: $0) },
    fallbackColor: Color(red: 0.98, green: 0.72, blue: 0.20),
    alertColor: Color(red: 0.992, green: 0.812, blue: 0.271),
    completionBadgeColor: Color(red: 0.129, green: 0.741, blue: 0.682),
    eyeColor: Color(red: 0.992, green: 0.812, blue: 0.271),
    approvalGlowColor: Color(red: 0.992, green: 0.812, blue: 0.271),
    keyboardBaseColor: Color(red: 0.45, green: 0.32, blue: 0.03),
    keyboardKeyColor: Color(red: 0.992, green: 0.812, blue: 0.271),
    bodyScale: 1.0,
    eyeLeftX: 6.19,
    eyeRightX: 9.69,
    eyeY: 9.69,
    eyeRxBase: 0.585,
    eyeRxClosedAdd: 0.55,
    eyeRyMin: 0.40,
    eyeRyOpen: 0.98,
    eyeRyClosedAdd: 0.08
  )

  static let muffin = SpriteMascotConfig(
    image: AgentIslandAssets.muffinMascotImage.map { Image(nsImage: $0) },
    fallbackColor: Color(red: 0.96, green: 0.48, blue: 0.48),
    alertColor: Color(red: 1.0, green: 0.306, blue: 0.192),
    completionBadgeColor: Color(red: 0.490, green: 0.600, blue: 0.835),
    eyeColor: .black,
    approvalGlowColor: Color(red: 1.0, green: 0.306, blue: 0.192),
    keyboardBaseColor: Color(red: 0.19, green: 0.24, blue: 0.38),
    keyboardKeyColor: Color(red: 0.490, green: 0.600, blue: 0.835),
    bodyScale: 1.0,
    eyeLeftX: 5.56,
    eyeRightX: 10.56,
    eyeY: 9.31,
    eyeRxBase: 0.585,
    eyeRxClosedAdd: 0.55,
    eyeRyMin: 0.40,
    eyeRyOpen: 0.98,
    eyeRyClosedAdd: 0.08
  )

  // 以下三个角色的参数来源(2026-07-27)：眼睛几何由「带眼睛版」与「无眼睛版」素材做像素
  // diff 得到 bbox 再换算到 16 单位坐标；眼睛/感叹号/完成徽章的颜色直接取自设计给的色板。
  // 眼睛形状(Rx/Ry/闭眼增量)按设计要求复用 tarara，只有位置和颜色按各自素材实测。

  /// 眼睛：深棕 #6B3D32，形状复用 tarara。
  static let cindy = SpriteMascotConfig(
    image: AgentIslandAssets.cindyMascotImage.map { Image(nsImage: $0) },
    fallbackColor: Color(red: 0.251, green: 0.255, blue: 0.322),
    alertColor: Color(red: 0.875, green: 0.180, blue: 0.153),
    completionBadgeColor: Color(red: 0.404, green: 0.463, blue: 0.941),
    eyeColor: Color(red: 0.420, green: 0.239, blue: 0.196),
    approvalGlowColor: Color(red: 0.875, green: 0.180, blue: 0.153),
    keyboardBaseColor: Color(red: 0.149, green: 0.169, blue: 0.271),
    keyboardKeyColor: Color(red: 0.404, green: 0.463, blue: 0.941),
    bodyScale: 1.0,
    eyeLeftX: 6.71,
    eyeRightX: 9.30,
    eyeY: 9.50,
    eyeRxBase: 0.585,
    eyeRxClosedAdd: 0.55,
    eyeRyMin: 0.40,
    eyeRyOpen: 0.98,
    eyeRyClosedAdd: 0.08
  )

  /// 眼睛：黄色 #FDCF45，形状复用 tarara(与 chaku 同一套)。
  /// 位置不用带眼版素材的实测值(6.25/9.75/9.50)：那版素材的眼睛只有 0.76 宽，换成 tarara
  /// 的 1.17 宽眼型后同样间距会显挤、重心偏低，所以外移到间距 4.10 并上提到 9.05。
  static let blackcat = SpriteMascotConfig(
    image: AgentIslandAssets.blackcatMascotImage.map { Image(nsImage: $0) },
    fallbackColor: Color(red: 0.169, green: 0.196, blue: 0.220),
    alertColor: Color(red: 0.875, green: 0.180, blue: 0.153),
    completionBadgeColor: Color(red: 0.404, green: 0.463, blue: 0.941),
    eyeColor: Color(red: 0.992, green: 0.812, blue: 0.271),
    approvalGlowColor: Color(red: 0.875, green: 0.180, blue: 0.153),
    keyboardBaseColor: Color(red: 0.122, green: 0.141, blue: 0.161),
    keyboardKeyColor: Color(red: 0.404, green: 0.463, blue: 0.941),
    bodyScale: 1.0,
    eyeLeftX: 5.95,
    eyeRightX: 10.05,
    eyeY: 9.05,
    eyeRxBase: 0.585,
    eyeRxClosedAdd: 0.55,
    eyeRyMin: 0.40,
    eyeRyOpen: 0.98,
    eyeRyClosedAdd: 0.08
  )

  /// 眼睛：棕 #875D42，形状复用 tarara；眼位比 cindy 更低。
  static let erika = SpriteMascotConfig(
    image: AgentIslandAssets.erikaMascotImage.map { Image(nsImage: $0) },
    fallbackColor: Color(red: 0.329, green: 0.302, blue: 0.337),
    alertColor: Color(red: 0.953, green: 0.796, blue: 0.314),
    completionBadgeColor: Color(red: 0.353, green: 0.612, blue: 0.667),
    eyeColor: Color(red: 0.529, green: 0.365, blue: 0.259),
    approvalGlowColor: Color(red: 0.953, green: 0.796, blue: 0.314),
    keyboardBaseColor: Color(red: 0.200, green: 0.278, blue: 0.302),
    keyboardKeyColor: Color(red: 0.353, green: 0.612, blue: 0.667),
    bodyScale: 1.0,
    eyeLeftX: 6.84,
    eyeRightX: 9.16,
    eyeY: 10.75,
    eyeRxBase: 0.585,
    eyeRxClosedAdd: 0.55,
    eyeRyMin: 0.40,
    eyeRyOpen: 0.98,
    eyeRyClosedAdd: 0.08
  )
}

/// 灵动岛角色清单与查表：新增角色时只改这里(加 `skins` 条目 + `spriteConfig` 分支)，
/// 运行时渲染和 `preview:island-mascots` 预览网格都会自动覆盖新角色。
/// `skins` 必须与 `src/shared/agentIsland.ts` 的 `AGENT_ISLAND_MASCOT_SKINS` 保持一致。
enum AgentIslandMascotCatalog {
  /// 顺序与 `src/shared/agentIsland.ts` 的 `AGENT_ISLAND_MASCOT_SKINS` 一致
  /// (也就是设置页列表的展示顺序)，预览网格同样按这个顺序铺。
  static let skins: [String] = [
    "cindy",
    "blackcat",
    "pululu",
    "tarara",
    "boli",
    "whitesnow",
    "annie",
    "chaku",
    "muffin",
    "erika",
  ]

  /// PNG 贴图角色的渲染参数；返回 nil 表示该皮肤走矢量绘制(pululu)。
  static func spriteConfig(for skin: String) -> SpriteMascotConfig? {
    switch skin {
    case "tarara": return .tarara
    case "boli": return .boli
    case "whitesnow": return .whitesnow
    case "annie": return .annie
    case "chaku": return .chaku
    case "muffin": return .muffin
    case "cindy": return .cindy
    case "blackcat": return .blackcat
    case "erika": return .erika
    default: return nil
    }
  }
}

/// Runtime mascot renderer for PNG-backed skins with shared animation timing.
struct SpriteMascotView: View {
  let size: CGFloat
  let state: AgentIslandMascotAnimationState
  let config: SpriteMascotConfig
  @State private var alive = false
  @State private var timelineStart = Date().timeIntervalSinceReferenceDate
  @Environment(\.agentIslandMascotAnimationsActive) private var animationsActive
  @Environment(\.agentIslandMascotAnimationEpoch) private var animationEpoch
  private static let keyboardHighlightColor = Color.white
  private static let idleCycleDuration: Double = 4.9
  private static let idleSleepStart: Double = 1.15

  var body: some View {
    ZStack {
      switch state {
      case .idle:
        sleepScene
      case .working:
        workScene
      case .waitingApproval:
        alertScene
      case .completed:
        completionScene
      }
    }
    .frame(width: size, height: size)
    .clipped()
    .onAppear {
      restartTimeline()
    }
    .onChange(of: state) { _, _ in
      restartTimeline()
    }
    .onChange(of: animationEpoch) { _, _ in
      restartTimeline()
    }
  }

  @ViewBuilder
  private func timeline<Content: View>(
    every interval: TimeInterval,
    staticTime: Double = 0,
    @ViewBuilder content: @escaping (Double) -> Content
  ) -> some View {
    if animationsActive {
      TimelineView(.periodic(from: .now, by: interval)) { ctx in
        content(ctx.date.timeIntervalSinceReferenceDate - timelineStart)
      }
      .id(animationEpoch)
    } else {
      content(staticTime)
    }
  }

  private func restartTimeline() {
    alive = false
    timelineStart = Date().timeIntervalSinceReferenceDate
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) {
      alive = true
    }
  }

  private struct V {
    let ox: CGFloat
    let oy: CGFloat
    let s: CGFloat

    init(_ sz: CGSize, w: CGFloat = 16, h: CGFloat = 16) {
      s = min(sz.width / w, sz.height / h)
      ox = (sz.width - w * s) / 2
      oy = (sz.height - h * s) / 2
    }

    func rect(_ x: CGFloat, _ y: CGFloat, _ w: CGFloat, _ h: CGFloat, dy: CGFloat = 0) -> CGRect {
      CGRect(x: ox + x * s, y: oy + (y + dy) * s, width: w * s, height: h * s)
    }

    func ellipse(cx: CGFloat, cy: CGFloat, rx: CGFloat, ry: CGFloat? = nil, dy: CGFloat = 0) -> CGRect {
      let ey = ry ?? rx
      return rect(cx - rx, cy - ey, rx * 2, ey * 2, dy: dy)
    }

    func point(_ x: CGFloat, _ y: CGFloat, dy: CGFloat = 0) -> CGPoint {
      CGPoint(x: ox + x * s, y: oy + (y + dy) * s)
    }
  }

  private func rounded(_ rect: CGRect, radius: CGFloat) -> Path {
    Path(roundedRect: rect, cornerRadius: radius)
  }

  private func drawShadow(_ c: GraphicsContext, v: V, width: CGFloat, opacity: Double, dy: CGFloat = 0) {
    c.fill(
      Path(ellipseIn: v.ellipse(cx: 8, cy: 14.3, rx: width / 2, ry: 0.48, dy: dy)),
      with: .color(.black.opacity(opacity))
    )
  }

  private func drawSprite(
    _ c: GraphicsContext,
    v: V,
    dy: CGFloat = 0,
    x: CGFloat = 0,
    scaleX: CGFloat = 1,
    scaleY: CGFloat = 1,
    opacity: Double = 1,
    eyeScale: CGFloat = 1,
    eyeOpacity: Double = 1,
    eyeYOffset: CGFloat = 0,
    angle: CGFloat = 0
  ) {
    var sprite = c
    let center = v.point(8 + x, 8.1, dy: dy)
    sprite.translateBy(x: center.x, y: center.y)
    sprite.rotate(by: .radians(Double(angle)))
    sprite.scaleBy(x: scaleX * config.bodyScale, y: scaleY * config.bodyScale)
    sprite.translateBy(x: -center.x, y: -center.y)
    sprite.opacity = opacity

    if let image = config.image {
      sprite.draw(image, in: v.rect(x, 0, 16, 16, dy: dy))
    } else {
      sprite.fill(
        Path(ellipseIn: v.ellipse(cx: 8 + x, cy: 8.1, rx: 5.8, ry: 5.8, dy: dy)),
        with: .color(config.fallbackColor)
      )
    }
    drawEyes(sprite, v: v, dy: dy + eyeYOffset, x: x, scale: eyeScale, opacity: eyeOpacity)
  }

  private func drawEyes(
    _ c: GraphicsContext,
    v: V,
    dy: CGFloat,
    x: CGFloat,
    scale: CGFloat,
    opacity: Double
  ) {
    let openness = scale < 0.25 ? 0 : min(scale, 1.18)
    let closed = 1 - min(openness, 1)
    let rx = config.eyeRxBase + config.eyeRxClosedAdd * closed
    let ry = max(config.eyeRyMin, config.eyeRyOpen * openness + config.eyeRyClosedAdd * closed)
    let cy = config.eyeY
    c.fill(
      Path(ellipseIn: v.ellipse(cx: config.eyeLeftX + x, cy: cy, rx: rx, ry: ry, dy: dy)),
      with: .color(config.eyeColor.opacity(opacity))
    )
    c.fill(
      Path(ellipseIn: v.ellipse(cx: config.eyeRightX + x, cy: cy, rx: rx, ry: ry, dy: dy)),
      with: .color(config.eyeColor.opacity(opacity))
    )
  }

  private func drawKeyboard(_ c: GraphicsContext, v: V, phase: Int, dy: CGFloat) {
    c.fill(Path(v.rect(0.5, 13.0, 15, 3, dy: dy)), with: .color(config.keyboardBaseColor))
    for row in 0..<2 {
      let ky = 13.5 + CGFloat(row) * 1.2
      for col in 0..<6 {
        let kx = 1.0 + CGFloat(col) * 2.4
        c.fill(Path(v.rect(kx, ky, 1.8, 0.7, dy: dy)), with: .color(config.keyboardKeyColor))
      }
    }
    c.fill(
      Path(v.rect(1.0 + CGFloat(phase % 6) * 2.4, 13.5 + CGFloat(phase / 3) * 1.2, 1.8, 0.7, dy: dy)),
      with: .color(Self.keyboardHighlightColor.opacity(0.9))
    )
  }

  private func drawBang(_ c: GraphicsContext, v: V, pct: CGFloat, jumpY: CGFloat) {
    let opacity = agentIslandMascotLerp([
      (0, 0), (0.03, 1), (0.10, 1), (0.55, 1), (0.62, 0), (1, 0),
    ], at: pct)
    guard opacity > 0.01 else { return }
    let scale = agentIslandMascotLerp([
      (0, 0.3), (0.03, 1.3), (0.10, 1.0), (0.55, 1.0), (0.62, 0.6), (1, 0.6),
    ], at: pct)
    let bw: CGFloat = 1.65 * scale
    let bx: CGFloat = 13
    let by: CGFloat = 1.0 + jumpY * 0.15
    c.fill(
      rounded(v.rect(bx, by, bw, 3.5 * scale), radius: bw * v.s * 0.45),
      with: .color(config.alertColor.opacity(Double(opacity)))
    )
    c.fill(
      rounded(v.rect(bx, by + 4.05 * scale, bw, 1.45 * scale), radius: bw * v.s * 0.45),
      with: .color(config.alertColor.opacity(Double(opacity)))
    )
  }

  private func drawCompletionBadge(_ c: GraphicsContext, v: V, pct: CGFloat) {
    let fade = pct < 0.92 ? 1.0 : max(0, (1.0 - pct) / 0.08)
    let badgeScale = agentIslandMascotLerp([
      (0, 0.15), (0.10, 1.20), (0.20, 0.94),
      (0.32, 1.0), (0.92, 1.0), (1, 0.90),
    ], at: pct)
    let cx: CGFloat = 8
    let cy: CGFloat = 8.05
    let badgeR: CGFloat = 5.95 * badgeScale

    c.fill(
      Path(ellipseIn: v.ellipse(cx: cx, cy: cy, rx: badgeR, ry: badgeR)),
      with: .color(config.completionBadgeColor.opacity(Double(fade)))
    )
    c.fill(
      Path(ellipseIn: v.ellipse(
        cx: cx - 1.55 * badgeScale,
        cy: cy - 1.85 * badgeScale,
        rx: 1.08 * badgeScale,
        ry: 0.55 * badgeScale
      )),
      with: .color(Color.white.opacity(Double(0.25 * fade)))
    )

    var check = Path()
    check.move(to: CGPoint(x: v.ox + (cx - 2.38 * badgeScale) * v.s, y: v.oy + (cy + 0.18 * badgeScale) * v.s))
    check.addLine(to: CGPoint(x: v.ox + (cx - 0.62 * badgeScale) * v.s, y: v.oy + (cy + 1.86 * badgeScale) * v.s))
    check.addLine(to: CGPoint(x: v.ox + (cx + 2.92 * badgeScale) * v.s, y: v.oy + (cy - 2.10 * badgeScale) * v.s))
    c.stroke(
      check,
      with: .color(Color.white.opacity(Double(fade))),
      style: StrokeStyle(lineWidth: 1.10 * badgeScale * v.s, lineCap: .round, lineJoin: .round)
    )
  }

  private var sleepScene: some View {
    ZStack {
      timeline(every: 0.06) { t in
        sleepCanvas(t: t)
      }
      timeline(every: 0.05) { t in
        floatingZs(t: t)
      }
    }
  }

  private func floatingZs(t: Double) -> some View {
    ZStack {
      ForEach(0..<3, id: \.self) { i in
        let ci = Double(i)
        let idleTime = t.truncatingRemainder(dividingBy: Self.idleCycleDuration)
        let sleepElapsed = idleTime - Self.idleSleepStart
        let cycle = 2.8 + ci * 0.3
        let delay = ci * 0.9
        let localT = sleepElapsed - delay
        let phase = localT >= 0 ? (localT.truncatingRemainder(dividingBy: cycle)) / cycle : 0
        let p = max(0, phase)
        let fontSize = max(6, size * CGFloat(0.18 + p * 0.10))
        let baseOpacity = 0.74 - ci * 0.1
        let sleepOpacity = sleepElapsed >= delay ? 1.0 : 0.0
        let opacity = sleepOpacity * (p < 0.8 ? baseOpacity : (1.0 - p) * 3.5 * baseOpacity)
        let xOff = size * CGFloat(0.10 + ci * 0.05 + sin(p * .pi * 2) * 0.03)
        let yOff = -size * CGFloat(0.16 + p * 0.38)
        Text("z")
          .font(.system(size: fontSize, weight: .black, design: .monospaced))
          .foregroundStyle(Color.white.opacity(opacity))
          .offset(x: xOff, y: yOff)
      }
    }
  }

  private func sleepCanvas(t: Double) -> some View {
    let idleTime = t.truncatingRemainder(dividingBy: Self.idleCycleDuration)
    let phase = idleTime / Self.idleCycleDuration
    let float = sin(phase * .pi * 2) * 0.42
    let breathe = sin(phase * .pi * 2 + 0.6)
    let eyeScale = agentIslandMascotLerp([
      (0.0, 1.08),
      (CGFloat(Self.idleSleepStart - 0.18), 1.08),
      (CGFloat(Self.idleSleepStart), 0.0),
      (CGFloat(Self.idleCycleDuration - 0.28), 0.0),
      (CGFloat(Self.idleCycleDuration), 1.08),
    ], at: CGFloat(idleTime))

    return Canvas(rendersAsynchronously: true) { c, sz in
      let v = V(sz)
      drawShadow(c, v: v, width: 8.8 - abs(float) * 0.22, opacity: 0.23)
      drawSprite(
        c,
        v: v,
        dy: float,
        scaleX: 1 + breathe * 0.012,
        scaleY: 1 - breathe * 0.010,
        eyeScale: eyeScale,
        eyeOpacity: 0.96,
        angle: CGFloat(breathe) * 0.04
      )
    }
  }

  private var workScene: some View {
    timeline(every: 0.03) { t in
      workCanvas(t: t)
    }
  }

  private func workCanvas(t: Double) -> some View {
    let bounce = sin(t * 2 * .pi / 0.38) * 0.72
    let breathe = sin(t * 2 * .pi / 2.5)
    let keyPhase = Int(t / 0.1) % 6
    let blinkPhase = t.truncatingRemainder(dividingBy: 3.1)
    let eyeScale: CGFloat = blinkPhase > 1.12 && blinkPhase < 1.23 ? 0.0 : 1.0
    let headTurn = CGFloat(sin(t * 2 * .pi / 0.84)) * 0.22
    let xShift = CGFloat(sin(t * 2 * .pi / 0.72)) * 0.18

    return Canvas(rendersAsynchronously: true) { c, sz in
      let v = V(sz)
      let dy = bounce - 0.25
      drawShadow(c, v: v, width: 8.4 - abs(dy) * 0.32, opacity: 0.30)
      // 键盘先画：角色要挡在键盘前面，而不是被键盘条横切。
      drawKeyboard(c, v: v, phase: keyPhase, dy: -0.05)
      drawSprite(
        c,
        v: v,
        dy: dy,
        x: xShift,
        scaleX: 1.0 + breathe * 0.008 + (dy > 0.25 ? 0.018 : 0),
        scaleY: dy > 0.25 ? 0.98 : 1.0,
        eyeScale: eyeScale,
        eyeOpacity: 1,
        eyeYOffset: 0.05,
        angle: headTurn
      )
    }
  }

  private var alertScene: some View {
    let glowActive = alive && animationsActive
    return ZStack {
      Circle()
        .fill(config.approvalGlowColor.opacity(glowActive ? 0.12 : 0))
        .frame(width: size * 0.92)
        .blur(radius: size * 0.06)
        .animation(
          animationsActive ? .easeInOut(duration: 0.48).repeatForever(autoreverses: true) : .default,
          value: glowActive
        )

      timeline(every: 0.03) { t in
        alertCanvas(t: t)
      }
    }
  }

  private func alertCanvas(t: Double) -> some View {
    let cycle = t.truncatingRemainder(dividingBy: 3.5)
    let pct = CGFloat(cycle / 3.5)
    let jumpY = agentIslandMascotLerp([
      (0, 0), (0.03, 0), (0.10, -0.4), (0.15, 0.55),
      (0.175, -3.7), (0.20, -3.7), (0.25, 0.55),
      (0.275, -3.0), (0.30, -3.0), (0.35, 0.45),
      (0.375, -1.9), (0.40, -1.9), (0.45, 0.36),
      (0.475, -1.1), (0.50, -1.1), (0.55, 0.18),
      (0.62, 0), (1, 0),
    ], at: pct)
    let landing = max(0, jumpY)
    let eyeScale: CGFloat = pct > 0.03 && pct < 0.16 ? 1.16 : 1.0
    let shakeX: CGFloat = pct > 0.08 && pct < 0.62 ? sin(pct * .pi * 18) * 0.55 : 0
    let headWobble: CGFloat = pct > 0.08 && pct < 0.62 ? sin(pct * .pi * 16) * 0.20 : 0

    return Canvas(rendersAsynchronously: true) { c, sz in
      let v = V(sz)
      drawShadow(c, v: v, width: 8.6 - abs(min(0, jumpY)) * 0.42, opacity: 0.36)
      drawSprite(
        c,
        v: v,
        dy: jumpY,
        x: shakeX,
        scaleX: 1 + landing * 0.08,
        scaleY: 1 - landing * 0.05,
        eyeScale: eyeScale,
        eyeOpacity: 1,
        eyeYOffset: pct > 0.03 && pct < 0.16 ? -0.12 : 0,
        angle: headWobble
      )
      drawBang(c, v: v, pct: pct, jumpY: jumpY)
    }
  }

  private var completionScene: some View {
    timeline(every: 0.03) { t in
      completionCanvas(t: t)
    }
  }

  private func completionCanvas(t: Double) -> some View {
    let cycleDuration: Double = 2.05
    let cycle = t.truncatingRemainder(dividingBy: cycleDuration)
    let pct = CGFloat(cycle / cycleDuration)
    let mascotPct = min(1, pct / 0.58)
    let badgePct = max(0, min(1, (pct - 0.54) / 0.46))
    let jumpPhase = mascotPct * 3.0
    let jumpLocal = jumpPhase.truncatingRemainder(dividingBy: 1.0)
    let hop = -sin(jumpLocal * .pi) * (2.05 + mascotPct * 0.55)
    let disappear = agentIslandMascotLerp([(0, 1), (0.78, 1), (1, 0)], at: mascotPct)
    let shrink = agentIslandMascotLerp([(0, 1), (0.78, 1), (1, 0.18)], at: mascotPct)
    let headNod = CGFloat(sin(Double(jumpPhase) * .pi * 2) * 0.18)
    let eyePulse = 1.04 + CGFloat(sin(Double(jumpPhase) * .pi * 2)) * 0.07

    return Canvas(rendersAsynchronously: true) { c, sz in
      let v = V(sz)
      if mascotPct < 1 {
        let dy = hop
        drawShadow(c, v: v, width: 8.4 - abs(dy) * 0.36, opacity: 0.26 * Double(disappear))
        drawSprite(
          c,
          v: v,
          dy: dy,
          scaleX: shrink * (1.0 + max(0, dy) * 0.035),
          scaleY: shrink * (1.0 - max(0, dy) * 0.025),
          opacity: Double(disappear),
          eyeScale: eyePulse,
          eyeOpacity: 1,
          eyeYOffset: 0.02,
          angle: headNod
        )
      }
      if badgePct > 0 {
        drawCompletionBadge(c, v: v, pct: badgePct)
      }
    }
  }
}

struct AgentIslandRect: Codable, Equatable {
  let x: Double
  let y: Double
  let width: Double
  let height: Double
}

struct AgentIslandCarrierFrame: Codable {
  let x: Double
  let y: Double
  let width: Double
  let height: Double
  let displayId: Int
  let displayBounds: AgentIslandRect
  let contentWidth: Double?
}

struct AgentIslandScreenMetrics: Codable, Equatable {
  let displayId: Int
  let frame: AgentIslandRect
  let hasNotch: Bool
  let notchWidth: Double
  let topBarHeight: Double
  let menuBarHeight: Double
  let safeAreaTop: Double
  let isMain: Bool
  let signature: String

  static let fallback = AgentIslandScreenMetrics(
    displayId: 0,
    frame: AgentIslandRect(x: 0, y: 0, width: 1728, height: 1117),
    hasNotch: false,
    notchWidth: 210,
    topBarHeight: 24,
    menuBarHeight: 24,
    safeAreaTop: 0,
    isMain: true,
    signature: "fallback"
  )

  var dictionary: [String: Any] {
    [
      "displayId": displayId,
      "frame": [
        "x": frame.x,
        "y": frame.y,
        "width": frame.width,
        "height": frame.height,
      ],
      "hasNotch": hasNotch,
      "notchWidth": notchWidth,
      "topBarHeight": topBarHeight,
      "menuBarHeight": menuBarHeight,
      "safeAreaTop": safeAreaTop,
      "isMain": isMain,
      "signature": signature,
    ]
  }

  func disablingHardwareNotchLayout() -> AgentIslandScreenMetrics {
    let simulatedNotchWidth = min(
      Double(AgentIslandScreenMetricsConfig.simulatedNotchMaxWidth),
      max(
        Double(AgentIslandScreenMetricsConfig.simulatedNotchMinWidth),
        frame.width * Double(AgentIslandScreenMetricsConfig.simulatedNotchWidthRatio)
      )
    )
    return AgentIslandScreenMetrics(
      displayId: displayId,
      frame: frame,
      hasNotch: false,
      notchWidth: simulatedNotchWidth,
      topBarHeight: topBarHeight,
      menuBarHeight: menuBarHeight,
      safeAreaTop: safeAreaTop,
      isMain: isMain,
      signature: signature
    )
  }
}

struct AgentIslandActivityLine: Codable, Equatable, Identifiable {
  let id: String
  let kind: String
  let text: String
}

struct AgentIslandPermissionAction: Codable, Equatable {
  let requestId: String
  let canAllowForSession: Bool
}

struct AgentIslandSession: Codable, Equatable, Identifiable {
  let sessionId: String
  let title: String
  let projectName: String?
  let detail: String
  let compactDetail: String
  let messagePreview: AgentIslandActivityLine?
  let phase: String
  let agentKind: String
  let interactionKind: String?
  let permissionAction: AgentIslandPermissionAction?
  let attention: Bool
  let activityLines: [AgentIslandActivityLine]
  let startedAt: Double
  let lastActivityAt: Double

  var id: String { sessionId }
  var displayTitle: String { title.isEmpty ? (projectName ?? title) : title }
  var subtitle: String { compactDetail }
}

struct AgentIslandPillSnapshot: Codable {
  let priorityId: String?
  let priorityStatus: String
  let priorityMicroTitle: String
  let priorityCompactTitle: String
  let sessionCount: Int
  let activeSessionCount: Int
  let pendingInteractionCount: Int
  let unreadCompletedCount: Int
  let deferredRevealCount: Int
  let attentionCount: Int

  static let empty = AgentIslandPillSnapshot(
    priorityId: nil,
    priorityStatus: "idle",
    priorityMicroTitle: "",
    priorityCompactTitle: "",
    sessionCount: 0,
    activeSessionCount: 0,
    pendingInteractionCount: 0,
    unreadCompletedCount: 0,
    deferredRevealCount: 0,
    attentionCount: 0
  )
}

struct AgentIslandStrings: Codable, Equatable {
  let appName: String?
  let newConversationTitle: String
  let newConversationHint: String
  let muteSound: String
  let enableSound: String
  let settings: String
  let newMessage: String
  let review: String
  let needsInput: String
  let completed: String
  let error: String
  let input: String
  let done: String
  let running: String
  // 等待交互摘要(按 interactionKind 出人话;与 app 侧栏卡片 awaiting* 文案一致)
  let awaitingPermission: String
  let awaitingQuestion: String
  let awaitingPlan: String
  let permissionPromptTitle: String
  let allowOnce: String
  let alwaysAllowForSession: String
  let deny: String

  // Older main-process payloads do not contain appName; keep their idle view brand-current.
  var displayAppName: String { appName ?? "Cindy" }

  static let fallback = AgentIslandStrings(
    appName: "Cindy",
    newConversationTitle: "New Maker",
    newConversationHint: "Start a new conversation",
    muteSound: "Mute Agent Island",
    enableSound: "Enable Agent Island sound",
    settings: "Agent Island settings",
    newMessage: "New message",
    review: "Review",
    needsInput: "Needs input",
    completed: "Completed",
    error: "Error",
    input: "Input",
    done: "Done",
    running: "Running",
    awaitingPermission: "Awaiting permission",
    awaitingQuestion: "Awaiting your reply",
    awaitingPlan: "Awaiting plan review",
    permissionPromptTitle: "Confirm permission",
    allowOnce: "Allow once",
    alwaysAllowForSession: "Always allow",
    deny: "Deny"
  )
}

struct AgentIslandSoundSettings: Codable {
  let enabled: Bool
  let sounds: [String: AgentIslandSoundChoice]

  static let fallback = AgentIslandSoundSettings(
    enabled: true,
    sounds: [
      "start": .builtin("startup-chime"),
      "attention": .builtin("secret-chime"),
      "complete": .builtin("gem-collect"),
      "error": .builtin("error-buzz"),
      "select": .builtin("none"),
    ]
  )
}

enum AgentIslandSoundChoice: Codable {
  case builtin(String)
  case custom(path: String, name: String)

  private enum CodingKeys: String, CodingKey {
    case type
    case id
    case path
    case name
  }

  init(from decoder: Decoder) throws {
    if let container = try? decoder.singleValueContainer(),
       let soundId = try? container.decode(String.self)
    {
      self = .builtin(soundId)
      return
    }
    let container = try decoder.container(keyedBy: CodingKeys.self)
    let type = try container.decode(String.self, forKey: .type)
    switch type {
    case "custom":
      let path = try container.decode(String.self, forKey: .path)
      let name = try container.decodeIfPresent(String.self, forKey: .name) ?? URL(fileURLWithPath: path).lastPathComponent
      self = .custom(path: path, name: name)
    default:
      let soundId = try container.decode(String.self, forKey: .id)
      self = .builtin(soundId)
    }
  }

  func encode(to encoder: Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    switch self {
    case .builtin(let soundId):
      try container.encode("builtin", forKey: .type)
      try container.encode(soundId, forKey: .id)
    case .custom(let path, let name):
      try container.encode("custom", forKey: .type)
      try container.encode(path, forKey: .path)
      try container.encode(name, forKey: .name)
    }
  }
}

struct AgentIslandDisplayState: Codable {
  let visible: Bool
  let mode: String
  let notchStatus: String
  let displayPolicy: String
  let displaySurface: String
  let layoutMode: String
  let appFocused: Bool
  let smartSuppressed: Bool
  let shadowVisible: Bool
  let currentSessionId: String?
  let expandedDisplayId: Int?
  let pillSnapshot: AgentIslandPillSnapshot
  let sessions: [AgentIslandSession]
  let totalCount: Int
  let measuredContentHeight: Double
  let strings: AgentIslandStrings?
  let soundSettings: AgentIslandSoundSettings?
  let mascotSkin: String?
  let updatedAt: Double

  static let empty = AgentIslandDisplayState(
    visible: true,
    mode: "compact",
    notchStatus: "closed",
    displayPolicy: "closed",
    displaySurface: "collapsed",
    layoutMode: "compact",
    appFocused: false,
    smartSuppressed: false,
    shadowVisible: false,
    currentSessionId: nil,
    expandedDisplayId: nil,
    pillSnapshot: .empty,
    sessions: [],
    totalCount: 0,
    measuredContentHeight: 0,
    strings: .fallback,
    soundSettings: .fallback,
    mascotSkin: defaultAgentIslandMascotSkin,
    updatedAt: 0
  )

  var currentSession: AgentIslandSession? {
    if let priorityId = pillSnapshot.priorityId {
      return sessions.first { $0.sessionId == priorityId } ?? sessions.first
    }
    if let currentSessionId {
      return sessions.first { $0.sessionId == currentSessionId } ?? sessions.first
    }
    return sessions.first
  }

  var displayStrings: AgentIslandStrings {
    strings ?? .fallback
  }

  var displaySoundSettings: AgentIslandSoundSettings {
    soundSettings ?? .fallback
  }

  var displayMascotSkin: String {
    guard let skin = mascotSkin, AgentIslandMascotCatalog.skins.contains(skin) else {
      return defaultAgentIslandMascotSkin
    }
    return skin
  }
}

struct IncomingMessage: Codable {
  let type: String
  let state: AgentIslandDisplayState?
  let frame: AgentIslandCarrierFrame?
  let frames: [AgentIslandCarrierFrame]?
  let statesByDisplayId: [String: AgentIslandDisplayState]?
  let soundId: String?
  let soundPath: String?
}

final class AgentIslandModel: ObservableObject {
  @Published var state = AgentIslandDisplayState.empty
  @Published var carrierWidth: CGFloat = 680
  @Published var preferredContentWidth: CGFloat?
  @Published var notchBaselineHeight: CGFloat = 24
  @Published var screenMetrics = AgentIslandScreenMetrics.fallback
  @Published var hardwareNotchLayoutEnabled = false
  @Published var mascotAnimationsActive = false
  @Published var mascotAnimationEpoch = 0
  @Published var locallyHovered = false
  @Published var layoutDragActive = false
  @Published var layoutSnapAnimating = false
  @Published var layoutDragMode: String?

  var currentSession: AgentIslandSession? { state.currentSession }
}

private let expandedIslandMaxVisibleRows = 5
private let expandedIslandMultiRowSlotHeight: CGFloat = 90
private let expandedIslandMultiRowHeight: CGFloat = 84
private let expandedIslandMultiRowGap: CGFloat = 6
private let expandedIslandMultiVerticalPadding: CGFloat = 60
private let expandedIslandCardHorizontalPadding: CGFloat = 18
private let expandedIslandTopBarHeight: CGFloat = 24
private let expandedIslandTopPadding: CGFloat = 7
private let expandedIslandBodySpacing: CGFloat = 4
private let expandedIslandBottomPadding: CGFloat = 16
private let compactIslandBaseWidth: CGFloat = 210
private let compactIslandMinContentWidth: CGFloat = 80
private let compactIslandBadgeCollapseContentThreshold: CGFloat = 152
private let compactIslandDetailCollapseContentThreshold: CGFloat = 190
private let compactIslandCjkTitleMinimumWidth: CGFloat = 32
private let compactIslandLatinTitleMinimumWidth: CGFloat = 40
private let compactIslandTitleMaxWidthFraction: CGFloat = 0.44
private let compactIslandDetailMinimumWidth: CGFloat = 64
private let compactIslandStatusIconWidth: CGFloat = 18
private let compactIslandCarrierInset: CGFloat = 20
private let expandedIslandCarrierExpandedInset: CGFloat = 80
private let expandedIslandMinContentWidth: CGFloat = 360
private let expandedIslandDefaultContentWidth: CGFloat = 640
private let expandedIslandMaxContentWidth: CGFloat = 920
private let expandedIslandHardwareNotchSideWidth: CGFloat = 96
private let expandedIslandHardwareNotchHorizontalPadding: CGFloat = 36
private let expandedIslandScreenEdgeGutter: CGFloat = 112
private let compactIslandResizeHitWidth: CGFloat = 18
private let expandedIslandTopResizeInnerHitWidth: CGFloat = 16
private let expandedIslandPanelResizeInnerHitWidth: CGFloat = 12
private let expandedIslandResizeOuterHitWidth: CGFloat = 8
private let expandedIslandMeasuredMinHeight: CGFloat = 118
private let expandedIslandCenterSnapDistance: CGFloat = 30
private let expandedIslandLayoutEmitInterval: TimeInterval = 0.033
private let hardwareNotchTextRevealStartSideWidth: CGFloat = 44
private let hardwareNotchTextRevealDistance: CGFloat = 38
// Upper bound of `hardwareNotchSideInset`, i.e. the trailing gap the notch layout keeps
// beside the count badge. Reserving this much guarantees the badge is never clipped at
// the default compact width.
private let hardwareNotchBadgeReservedInset: CGFloat = 9
// How close a compact width must be to a snap point to count as sitting on it.
private let compactWidthSnapTolerance: CGFloat = 1.5
private let agentIslandTopDragHitSlop: CGFloat = 2
private let agentIslandClickDragTolerance: CGFloat = 4
private let hardwareNotchCenterTolerance: CGFloat = 2
private let agentIslandCarrierShrinkDelay: TimeInterval = 0.42
private let agentIslandDebugLoggingEnabled =
  ProcessInfo.processInfo.environment["XDT_AGENT_ISLAND_DEBUG_LOGS"] == "1"
// 状态语义色 —— 与 app 内 renderer 的全端统一色表对齐(themes/colors.ts):
//   running = Thinking Orange #FF6600(--status-bar-accent)
//   needs-interaction = TapTap 蓝 #00D9C5(--card-status-awaiting dark 值)
//   error = 红 #EF4444(--card-status-error)
//   完成未读 = 绿 #22C55E(--card-status-done)
private let agentIslandOrange = Color(red: 1.0, green: 0.4, blue: 0.0)
private let agentIslandBlue = Color(red: 0.0, green: 0.851, blue: 0.773)
private let agentIslandErrorRed = Color(red: 0.937, green: 0.267, blue: 0.267)
private let agentIslandUnreadGreen = Color(red: 0.133, green: 0.773, blue: 0.369)
private let runningAgentGifFileName = "running-agent.gif"
private let tararaMascotFileName = "tarara.png"
private let boliMascotFileName = "boli.png"
private let whitesnowMascotFileName = "whitesnow.png"
private let annieMascotFileName = "annie.png"
private let chakuMascotFileName = "chaku.png"
private let muffinMascotFileName = "muffin.png"
private let cindyMascotFileName = "cindy.png"
private let blackcatMascotFileName = "blackcat.png"
private let erikaMascotFileName = "erika.png"
private let defaultAgentIslandMascotSkin = "pululu"
// Keep these mono Agent identity marks aligned with renderer ClaudeMark/CodexMark.
// The native copies remain template images so Agent Island can apply status colors.
private let agentIslandCodexMarkSVG = """
<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">
  <g transform="translate(12 12) scale(1.1) translate(-12 -12)">
    <path fill="none" stroke="black" stroke-width="2" stroke-linejoin="round" d="M9.064 3.344a4.6 4.6 0 0 1 2.285-.312q1.5.173 2.673 1.275.016.015.037.021a.1.1 0 0 0 .043 0 4.55 4.55 0 0 1 3.046.275l.047.022.116.057a4.58 4.58 0 0 1 2.188 2.399q.313.765.315 1.595a4.2 4.2 0 0 1-.134 1.223.12.12 0 0 0 .03.115q.89.91 1.183 2.17.433 2.138-.887 3.854l-.136.166a4.55 4.55 0 0 1-2.201 1.388.12.12 0 0 0-.081.076c-.191.551-.383 1.023-.74 1.494-.9 1.187-2.222 1.846-3.711 1.838q-1.78-.009-3.157-1.302a.11.11 0 0 0-.105-.024c-.388.125-.78.143-1.204.138a4.44 4.44 0 0 1-1.945-.466 4.54 4.54 0 0 1-1.61-1.335c-.152-.202-.303-.392-.414-.617a6 6 0 0 1-.37-.961 4.6 4.6 0 0 1-.014-2.298.1.1 0 0 0 .006-.056.1.1 0 0 0-.027-.048 4.5 4.5 0 0 1-1.034-1.651 3.9 3.9 0 0 1-.251-1.192 5.2 5.2 0 0 1 .141-1.6Q3.659 7.92 5.086 6.97q.318-.212.601-.33a6 6 0 0 1 .646-.227.1.1 0 0 0 .065-.066 4.5 4.5 0 0 1 .829-1.615 4.54 4.54 0 0 1 1.837-1.388z"/>
    <path fill="black" stroke="black" stroke-width="0.5" stroke-linejoin="round" d="M12.546 13.909a.637.637 0 0 0 0 1.272h3.636a.637.637 0 1 0 0-1.272zM8.462 9.23a.637.637 0 0 0-1.106.631l1.272 2.224-1.266 2.136a.636.636 0 1 0 1.095.649l1.454-2.455a.64.64 0 0 0 .005-.64z"/>
  </g>
</svg>
"""
private let agentIslandClaudeMarkSVG = """
<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">
  <path fill="black" fill-rule="evenodd" clip-rule="evenodd" d="M20.998 10.949H24v3.102h-3v3.028h-1.487V20H18v-2.921h-1.487V20H15v-2.921H9V20H7.488v-2.921H6V20H4.487v-2.921H3V14.05H0v-3.1h3V5h17.998zM6 10.949h1.488V8.102H6zm10.51 0H18V8.102h-1.49z"/>
</svg>
"""

private enum AgentIslandTopBarHeightMode {
  case matchNotch
  case matchMenuBar
  case custom
}

/// Internal screen/notch knobs. These mirror the TypeScript defaults in
/// shared/agentIsland.ts and are intentionally not user-facing yet.
private enum AgentIslandScreenMetricsConfig {
  static let topBarHeightMode: AgentIslandTopBarHeightMode = .matchNotch
  static let customTopBarHeight: CGFloat = 37
  static let simulatedNotchWidthRatio: CGFloat = 0.14
  static let simulatedNotchMinWidth: CGFloat = 160
  static let simulatedNotchMaxWidth: CGFloat = 240
  static let compactSimulatedActiveExtraWidth: CGFloat = 88
  static let compactHardwareIdleExtraWidth: CGFloat = 64
  static let compactHardwareActiveExtraWidth: CGFloat = 64
  static let compactHardwareHiddenPullDistance: CGFloat = 48
}

private enum AgentIslandResizeEdge {
  case left
  case right
}

private func agentIslandFrameResizeCursor(edge: AgentIslandResizeEdge) -> NSCursor {
  #if compiler(>=6.0)
  if #available(macOS 15.0, *) {
    return NSCursor.frameResize(
      position: edge == .left ? .left : .right,
      directions: .all
    )
  }
  #endif
  return .resizeLeftRight
}

private enum AgentIslandAssets {
  static let runningAgentGifImage: NSImage? = {
    for url in runningAgentGifCandidateURLs() {
      if let image = NSImage(contentsOf: url) {
        image.size = NSSize(width: 128, height: 128)
        return image
      }
    }
    return nil
  }()

  static let tararaMascotImage: NSImage? = {
    mascotImage(fileName: tararaMascotFileName, size: NSSize(width: 128, height: 128))
  }()

  static let boliMascotImage: NSImage? = {
    mascotImage(fileName: boliMascotFileName, size: NSSize(width: 128, height: 128))
  }()

  static let whitesnowMascotImage: NSImage? = {
    mascotImage(fileName: whitesnowMascotFileName, size: NSSize(width: 134, height: 134))
  }()

  static let annieMascotImage: NSImage? = {
    mascotImage(fileName: annieMascotFileName, size: NSSize(width: 128, height: 128))
  }()

  static let chakuMascotImage: NSImage? = {
    mascotImage(fileName: chakuMascotFileName, size: NSSize(width: 128, height: 128))
  }()

  static let muffinMascotImage: NSImage? = {
    mascotImage(fileName: muffinMascotFileName, size: NSSize(width: 128, height: 128))
  }()

  static let cindyMascotImage: NSImage? = {
    mascotImage(fileName: cindyMascotFileName, size: NSSize(width: 128, height: 128))
  }()

  static let blackcatMascotImage: NSImage? = {
    mascotImage(fileName: blackcatMascotFileName, size: NSSize(width: 128, height: 128))
  }()

  static let erikaMascotImage: NSImage? = {
    mascotImage(fileName: erikaMascotFileName, size: NSSize(width: 128, height: 128))
  }()

  private static func runningAgentGifCandidateURLs() -> [URL] {
    var urls: [URL] = []
    let environment = ProcessInfo.processInfo.environment
    if let assetDir = environment["XDT_AGENT_ISLAND_ASSET_DIR"], !assetDir.isEmpty {
      urls.append(URL(fileURLWithPath: assetDir).appendingPathComponent(runningAgentGifFileName))
    }
    if let executablePath = CommandLine.arguments.first, !executablePath.isEmpty {
      urls.append(
        URL(fileURLWithPath: executablePath)
          .deletingLastPathComponent()
          .appendingPathComponent(runningAgentGifFileName)
      )
    }
    urls.append(
      URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
        .appendingPathComponent("apps")
        .appendingPathComponent("desktop")
        .appendingPathComponent("native")
        .appendingPathComponent("agent-island")
        .appendingPathComponent(runningAgentGifFileName)
    )
    return urls
  }

  private static func mascotImage(fileName: String, size: NSSize) -> NSImage? {
    for url in mascotCandidateURLs(fileName: fileName) {
      if let image = NSImage(contentsOf: url) {
        image.size = size
        return image
      }
    }
    return nil
  }

  private static func mascotCandidateURLs(fileName: String) -> [URL] {
    var urls: [URL] = []
    let environment = ProcessInfo.processInfo.environment
    if let assetDir = environment["XDT_AGENT_ISLAND_ASSET_DIR"], !assetDir.isEmpty {
      urls.append(
        URL(fileURLWithPath: assetDir)
          .appendingPathComponent("mascots", isDirectory: true)
          .appendingPathComponent(fileName)
      )
    }
    if let executablePath = CommandLine.arguments.first, !executablePath.isEmpty {
      urls.append(
        URL(fileURLWithPath: executablePath)
          .deletingLastPathComponent()
          .appendingPathComponent("mascots", isDirectory: true)
          .appendingPathComponent(fileName)
      )
    }
    urls.append(
      URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
        .appendingPathComponent("apps")
        .appendingPathComponent("desktop")
        .appendingPathComponent("native")
        .appendingPathComponent("agent-island")
        .appendingPathComponent("mascots", isDirectory: true)
        .appendingPathComponent(fileName)
    )
    return urls
  }
}

private enum AgentIslandScreenMetricsProvider {
  static func allMetrics() -> [AgentIslandScreenMetrics] {
    NSScreen.screens.map { metrics(for: $0) }
  }

  static func metrics(for screen: NSScreen?) -> AgentIslandScreenMetrics {
    guard let screen else {
      return .fallback
    }
    let frame = screen.frame.integral
    let menuBarHeight = max(0, screen.frame.maxY - screen.visibleFrame.maxY)
    let safeAreaTop: CGFloat
    if #available(macOS 12.0, *) {
      safeAreaTop = screen.safeAreaInsets.top
    } else {
      safeAreaTop = 0
    }
    return AgentIslandScreenMetrics(
      displayId: displayId(for: screen),
      frame: AgentIslandRect(
        x: Double(frame.minX),
        y: Double(frame.minY),
        width: Double(frame.width),
        height: Double(frame.height)
      ),
      hasNotch: screenHasNotch(screen),
      notchWidth: Double(notchWidth(for: screen)),
      topBarHeight: Double(topBarHeight(menuBarHeight: menuBarHeight, safeAreaTop: safeAreaTop)),
      menuBarHeight: Double(menuBarHeight),
      safeAreaTop: Double(safeAreaTop),
      isMain: NSScreen.main == screen,
      signature: signature(for: screen)
    )
  }

  static func preferredDisplayId() -> Int? {
    guard let screen = preferredScreen() else {
      return nil
    }
    return displayId(for: screen)
  }

  static func screenHasNotch(_ screen: NSScreen) -> Bool {
    if #available(macOS 12.0, *) {
      return screen.auxiliaryTopLeftArea != nil || screen.auxiliaryTopRightArea != nil
    }
    return false
  }

  static func notchWidth(for screen: NSScreen) -> CGFloat {
    if #available(macOS 12.0, *) {
      let leftWidth = screen.auxiliaryTopLeftArea?.width ?? 0
      let rightWidth = screen.auxiliaryTopRightArea?.width ?? 0
      if leftWidth > 0 || rightWidth > 0 {
        return max(1, screen.frame.width - leftWidth - rightWidth)
      }
    }
    return simulatedNotchWidth(for: screen)
  }

  static func displayId(for screen: NSScreen) -> Int {
    (screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.intValue ?? 0
  }

  static func signature(for screen: NSScreen) -> String {
    let frame = screen.frame.integral
    return "\(Int(frame.minX)):\(Int(frame.minY)):\(Int(frame.width)):\(Int(frame.height)):\(displayId(for: screen))"
  }

  private static func topBarHeight(menuBarHeight: CGFloat, safeAreaTop: CGFloat) -> CGFloat {
    func resolvedMenuBarHeight() -> CGFloat {
      if menuBarHeight > 5 {
        return menuBarHeight
      }
      if let main = NSScreen.main {
        let mainMenuBarHeight = main.frame.maxY - main.visibleFrame.maxY
        if mainMenuBarHeight > 5 {
          return mainMenuBarHeight
        }
      }
      return 25
    }

    switch AgentIslandScreenMetricsConfig.topBarHeightMode {
    case .matchNotch:
      if safeAreaTop > 0 {
        return safeAreaTop
      }
      return resolvedMenuBarHeight()
    case .matchMenuBar:
      return resolvedMenuBarHeight()
    case .custom:
      return max(15, min(AgentIslandScreenMetricsConfig.customTopBarHeight, 60))
    }
  }

  private static func simulatedNotchWidth(for screen: NSScreen) -> CGFloat {
    min(
      AgentIslandScreenMetricsConfig.simulatedNotchMaxWidth,
      max(
        AgentIslandScreenMetricsConfig.simulatedNotchMinWidth,
        screen.frame.width * AgentIslandScreenMetricsConfig.simulatedNotchWidthRatio
      )
    )
  }

  private static func preferredScreen() -> NSScreen? {
    let screens = NSScreen.screens
    guard !screens.isEmpty else {
      return NSScreen.main
    }
    if let activeWindowBounds = frontmostApplicationWindowBounds() {
      let center = CGPoint(x: activeWindowBounds.midX, y: activeWindowBounds.midY)
      if let screen = screens.first(where: { $0.frame.contains(center) }) {
        return screen
      }
      let bestOverlap = screens
        .map { screen in (screen, overlapArea(lhs: screen.frame, rhs: activeWindowBounds)) }
        .max { lhs, rhs in lhs.1 < rhs.1 }
      if let bestOverlap, bestOverlap.1 > 0 {
        return bestOverlap.0
      }
    }
    if let notchedScreen = screens.first(where: { screenHasNotch($0) }) {
      return notchedScreen
    }
    return NSScreen.main ?? screens.first
  }

  private static func overlapArea(lhs: CGRect, rhs: CGRect) -> CGFloat {
    let intersection = lhs.intersection(rhs)
    guard !intersection.isNull, !intersection.isEmpty else {
      return 0
    }
    return intersection.width * intersection.height
  }

  private static func frontmostApplicationWindowBounds() -> CGRect? {
    guard let frontApp = NSWorkspace.shared.frontmostApplication else {
      return nil
    }
    let ownPID = ProcessInfo.processInfo.processIdentifier
    let preferredPID: pid_t? = frontApp.processIdentifier == ownPID ? nil : frontApp.processIdentifier

    guard let windowList = CGWindowListCopyWindowInfo(
      [.optionOnScreenOnly, .excludeDesktopElements],
      kCGNullWindowID
    ) as? [[String: Any]] else {
      return nil
    }

    for window in windowList {
      guard let pid = window[kCGWindowOwnerPID as String] as? pid_t,
        pid != ownPID,
        let layer = window[kCGWindowLayer as String] as? Int,
        layer == 0,
        let bounds = window[kCGWindowBounds as String] as? [String: Any],
        let rect = CGRect(dictionaryRepresentation: bounds as CFDictionary),
        rect.width > 0,
        rect.height > 0
      else {
        continue
      }
      if let preferredPID, pid != preferredPID {
        continue
      }
      return rect
    }

    guard preferredPID != nil else {
      return nil
    }
    for window in windowList {
      guard let pid = window[kCGWindowOwnerPID as String] as? pid_t,
        pid != ownPID,
        let layer = window[kCGWindowLayer as String] as? Int,
        layer == 0,
        let bounds = window[kCGWindowBounds as String] as? [String: Any],
        let rect = CGRect(dictionaryRepresentation: bounds as CFDictionary),
        rect.width > 0,
        rect.height > 0
      else {
        continue
      }
      return rect
    }
    return nil
  }
}

struct AgentIslandLayout: Equatable {
  let width: CGFloat
  let height: CGFloat
  let carrierInset: CGFloat
  let menuBarZoneHeight: CGFloat
  let topExtension: CGFloat
  let bottomRadius: CGFloat
  let shadowRadius: CGFloat
  let shadowY: CGFloat
  let shadowOpacity: Double
  let expanded: Bool
  let hasHardwareNotch: Bool
  let notchWidth: CGFloat

  var hardwareNotchHidden: Bool {
    hasHardwareNotch && !expanded && width <= notchWidth + 1
  }

  static func compute(
    state: AgentIslandDisplayState,
    availableFrameWidth: CGFloat,
    locallyHovered: Bool,
    notchBaselineHeight: CGFloat,
    screenMetrics: AgentIslandScreenMetrics = .fallback,
    hardwareNotchLayoutEnabled: Bool = true,
    preferredContentWidth: CGFloat? = nil
  ) -> AgentIslandLayout {
    let expanded = state.mode == "expanded"
    let hasSession = state.totalCount > 0
    let notchStatus = state.notchStatus
    let layoutScreenMetrics = hardwareNotchLayoutEnabled
      ? screenMetrics
      : screenMetrics.disablingHardwareNotchLayout()
    // Only the compact hardware-notch layout reserves room for the badge; every other
    // layout tick skips the reservation entirely and passes 0.
    let compactBadgeWidth = !expanded && layoutScreenMetrics.hasNotch && hasSession
      ? PillBadge.intrinsicWidth(pillSnapshot: state.pillSnapshot, compact: true)
      : 0
    let width = computeWidth(
      expanded: expanded,
      hasSession: hasSession,
      availableFrameWidth: availableFrameWidth,
      screenMetrics: layoutScreenMetrics,
      preferredContentWidth: preferredContentWidth,
      compactBadgeWidth: compactBadgeWidth
    )
    let height = computeHeight(state: state, expanded: expanded, notchBaselineHeight: notchBaselineHeight)
    let shape = shapeForStatus(notchStatus)
    let shadow = shadowForStatus(notchStatus)
    let shadowVisible = state.shadowVisible || locallyHovered
    return AgentIslandLayout(
      width: width,
      height: height,
      carrierInset: expanded ? expandedIslandCarrierExpandedInset : compactIslandCarrierInset,
      menuBarZoneHeight: max(8, notchBaselineHeight),
      topExtension: shape.topExtension,
      bottomRadius: shape.bottomRadius,
      shadowRadius: shadow.radius,
      shadowY: shadow.y,
      shadowOpacity: shadowVisible ? shadow.opacity : 0,
      expanded: expanded,
      hasHardwareNotch: layoutScreenMetrics.hasNotch,
      notchWidth: CGFloat(layoutScreenMetrics.notchWidth)
    )
  }

  private static func computeWidth(
    expanded: Bool,
    hasSession: Bool,
    availableFrameWidth: CGFloat,
    screenMetrics: AgentIslandScreenMetrics,
    preferredContentWidth: CGFloat?,
    compactBadgeWidth: CGFloat
  ) -> CGFloat {
    let idleExpandedWidth: CGFloat = 340
    let carrierInset = expanded ? expandedIslandCarrierExpandedInset : compactIslandCarrierInset
    let availableWidth = max(1, availableFrameWidth - carrierInset * 2)
    if expanded {
      let preferred = preferredContentWidth.map {
        min(expandedIslandMaxContentWidth, max(expandedIslandMinContentWidth, $0))
      }
      return min(preferred ?? (hasSession ? expandedIslandDefaultContentWidth : idleExpandedWidth), availableWidth)
    }
    let preferred = preferredContentWidth.map { desiredWidth in
      let maxWidth = min(expandedIslandMaxContentWidth, availableWidth)
      let minWidth = min(minContentWidth(expanded: false, screenMetrics: screenMetrics), maxWidth)
      let clampedWidth = min(maxWidth, max(minWidth, desiredWidth))
      return snappedCompactHardwareWidth(
        desiredWidth: desiredWidth,
        clampedWidth: clampedWidth,
        maxWidth: maxWidth,
        hasSession: hasSession,
        screenMetrics: screenMetrics,
        compactBadgeWidth: compactBadgeWidth
      )
    }
    let defaultWidth = defaultCompactWidth(
      hasSession: hasSession,
      screenMetrics: screenMetrics,
      compactBadgeWidth: compactBadgeWidth
    )
    return min(preferred ?? defaultWidth, availableWidth)
  }

  static func minContentWidth(expanded: Bool, screenMetrics: AgentIslandScreenMetrics) -> CGFloat {
    if expanded {
      if screenMetrics.hasNotch {
        return max(
          expandedIslandMinContentWidth,
          CGFloat(screenMetrics.notchWidth)
            + expandedIslandHardwareNotchSideWidth * 2
            + expandedIslandHardwareNotchHorizontalPadding
        )
      }
      return expandedIslandMinContentWidth
    }
    if screenMetrics.hasNotch {
      return max(1, CGFloat(screenMetrics.notchWidth))
    }
    return compactIslandMinContentWidth
  }

  /// Side width the trailing notch content needs so `compactBadgeWidth` survives
  /// `hardwareNotchTrailingContent`'s `.clipped()` frame. Mirrors the largest inset
  /// `hardwareNotchSideInset` can return, so a two-digit count stays readable.
  static func hardwareNotchBadgeSideWidth(compactBadgeWidth: CGFloat) -> CGFloat {
    compactBadgeWidth + hardwareNotchBadgeReservedInset
  }

  static func defaultCompactWidth(
    hasSession: Bool,
    screenMetrics: AgentIslandScreenMetrics,
    compactBadgeWidth: CGFloat = 0
  ) -> CGFloat {
    let notchWidth = CGFloat(screenMetrics.notchWidth)
    if screenMetrics.hasNotch {
      let baseExtra = hasSession
        ? AgentIslandScreenMetricsConfig.compactHardwareActiveExtraWidth
        : AgentIslandScreenMetricsConfig.compactHardwareIdleExtraWidth
      // A wide badge (multi-digit counts) must widen the island rather than get
      // clipped: both notch sides are symmetric, hence the doubling.
      let badgeExtra = hasSession
        ? hardwareNotchBadgeSideWidth(compactBadgeWidth: compactBadgeWidth) * 2
        : 0
      let extra = max(baseExtra, badgeExtra)
      return max(compactIslandBaseWidth, notchWidth + extra)
    }
    let extra = hasSession ? AgentIslandScreenMetricsConfig.compactSimulatedActiveExtraWidth : 0
    return max(compactIslandBaseWidth, notchWidth + extra)
  }

  static func snappedCompactHardwareWidth(
    desiredWidth: CGFloat,
    clampedWidth: CGFloat,
    maxWidth: CGFloat,
    hasSession: Bool,
    screenMetrics: AgentIslandScreenMetrics,
    compactBadgeWidth: CGFloat = 0
  ) -> CGFloat {
    guard screenMetrics.hasNotch else {
      return clampedWidth
    }
    let hiddenWidth = min(maxWidth, max(1, CGFloat(screenMetrics.notchWidth)))
    // The hidden/basic classification stays anchored to the badge-independent basic
    // width. Otherwise a persisted basic width silently falls below the hidden
    // threshold once a wider badge enlarges `basicWidth`, collapsing the whole island.
    let baseBasicWidth = min(
      maxWidth,
      max(hiddenWidth, defaultCompactWidth(hasSession: hasSession, screenMetrics: screenMetrics))
    )
    let basicWidth = min(
      maxWidth,
      max(
        hiddenWidth,
        defaultCompactWidth(
          hasSession: hasSession,
          screenMetrics: screenMetrics,
          compactBadgeWidth: compactBadgeWidth
        )
      )
    )
    let gap = baseBasicWidth - hiddenWidth
    guard gap > 8 else {
      return hiddenWidth
    }
    let hiddenThreshold = baseBasicWidth - min(
      AgentIslandScreenMetricsConfig.compactHardwareHiddenPullDistance,
      max(24, gap * 0.5)
    )
    if desiredWidth <= hiddenThreshold {
      return hiddenWidth
    }
    // Only widths at or below the badge-independent basic snap upgrade to the current
    // (possibly wider) basic. Comparing against `basicWidth` would swallow free widths
    // sitting between the two snap points, and `persistedCompactContentWidth` would then
    // canonicalize them away — permanently overwriting the user's preference.
    if desiredWidth <= baseBasicWidth {
      return basicWidth
    }
    return clampedWidth
  }

  private static func computeHeight(
    state: AgentIslandDisplayState,
    expanded: Bool,
    notchBaselineHeight: CGFloat
  ) -> CGFloat {
    if !expanded {
      return max(8, notchBaselineHeight)
    }
    if state.totalCount == 0 {
      return 154
    }
    if state.measuredContentHeight > 0 {
      return min(560, max(expandedIslandMeasuredMinHeight, CGFloat(ceil(state.measuredContentHeight + 8))))
    }
    if state.displaySurface == "sessionList" && state.totalCount > 1 {
      let visibleRows = min(state.totalCount, expandedIslandMaxVisibleRows)
      return min(
        560,
        max(
          176,
          expandedIslandMultiVerticalPadding
            + CGFloat(visibleRows) * expandedIslandMultiRowSlotHeight
        )
      )
    }
    return 190
  }

  private static func shapeForStatus(_ status: String) -> (topExtension: CGFloat, bottomRadius: CGFloat) {
    switch status {
    case "expanded":
      return (14, 24)
    default:
      return (3, 12)
    }
  }

  private static func shadowForStatus(_ status: String) -> (radius: CGFloat, y: CGFloat, opacity: Double) {
    switch status {
    case "peek":
      return (7, 2, 0.46)
    case "expanded":
      return (6, 0, 0.7)
    default:
      return (6, 0, 0.7)
    }
  }
}

private let expandedIslandHorizontalPadding: CGFloat = 38
private let agentIslandOpenAnimation = Animation.spring(response: 0.42, dampingFraction: 0.82)
private let agentIslandCompactSnapAnimation = Animation.spring(response: 0.18, dampingFraction: 0.76)
private let agentIslandCompactSnapFrameDuration: TimeInterval = 0.16
private let agentIslandTextWaveDuration: Double = 2.45
private let agentIslandTextWaveBandWidth: CGFloat = 72
private let expandedIslandToolbarRevealDelay: TimeInterval = 0.14
private let agentIslandRunningMascotGeometryId = "agent-island-running-mascot"

private struct ExpandedContentHeightPreferenceKey: PreferenceKey {
  static var defaultValue: CGFloat = 0

  static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
    value = max(value, nextValue())
  }
}

private struct ExpandedContentHeightReader: View {
  var body: some View {
    GeometryReader { proxy in
      Color.clear.preference(key: ExpandedContentHeightPreferenceKey.self, value: proxy.size.height)
    }
  }
}

/// Panel silhouette adapted from Code Island's MIT-licensed NotchPanelShape
/// (Copyright (c) 2026 wxtsky).
/// It uses inverse top shoulders and continuous-curvature bottom corners.
struct NotchShape: Shape {
  var topExtension: CGFloat
  var bottomRadius: CGFloat
  var minHeight: CGFloat

  var animatableData: AnimatablePair<CGFloat, CGFloat> {
    get { AnimatablePair(topExtension, bottomRadius) }
    set {
      topExtension = newValue.first
      bottomRadius = newValue.second
    }
  }

  func path(in rect: CGRect) -> Path {
    let ext = topExtension
    let maxY = max(rect.maxY, rect.minY + minHeight)
    let br = min(bottomRadius, rect.width / 4, (maxY - rect.minY) / 2)
    let k: CGFloat = 0.62

    var path = Path()
    path.move(to: CGPoint(x: rect.minX - ext, y: rect.minY))
    path.addLine(to: CGPoint(x: rect.maxX + ext, y: rect.minY))
    path.addCurve(
      to: CGPoint(x: rect.maxX, y: rect.minY + ext),
      control1: CGPoint(x: rect.maxX + ext * 0.35, y: rect.minY),
      control2: CGPoint(x: rect.maxX, y: rect.minY + ext * 0.35)
    )
    path.addLine(to: CGPoint(x: rect.maxX, y: maxY - br))
    path.addCurve(
      to: CGPoint(x: rect.maxX - br, y: maxY),
      control1: CGPoint(x: rect.maxX, y: maxY - br * (1 - k)),
      control2: CGPoint(x: rect.maxX - br * (1 - k), y: maxY)
    )
    path.addLine(to: CGPoint(x: rect.minX + br, y: maxY))
    path.addCurve(
      to: CGPoint(x: rect.minX, y: maxY - br),
      control1: CGPoint(x: rect.minX + br * (1 - k), y: maxY),
      control2: CGPoint(x: rect.minX, y: maxY - br * (1 - k))
    )
    path.addLine(to: CGPoint(x: rect.minX, y: rect.minY + ext))
    path.addCurve(
      to: CGPoint(x: rect.minX - ext, y: rect.minY),
      control1: CGPoint(x: rect.minX, y: rect.minY + ext * 0.35),
      control2: CGPoint(x: rect.minX - ext * 0.35, y: rect.minY)
    )
    path.closeSubpath()
    return path
  }
}

struct AgentIslandRootView: View {
  @ObservedObject var model: AgentIslandModel
  let eventSink: ([String: Any]) -> Void
  @Namespace private var runningMascotNamespace

  var body: some View {
    GeometryReader { proxy in
      let layout = AgentIslandLayout.compute(
        state: model.state,
        availableFrameWidth: proxy.size.width,
        locallyHovered: model.locallyHovered,
        notchBaselineHeight: model.notchBaselineHeight,
        screenMetrics: model.screenMetrics,
        hardwareNotchLayoutEnabled: model.hardwareNotchLayoutEnabled,
        preferredContentWidth: model.preferredContentWidth
      )
      ZStack(alignment: .top) {
        islandBody(layout: layout)
          .frame(width: layout.width, height: layout.height)
          .position(x: proxy.size.width / 2, y: layout.height / 2)
          .transaction { transaction in
            if model.layoutDragActive && !model.layoutSnapAnimating {
              transaction.animation = nil
              transaction.disablesAnimations = true
            }
          }
          .animation(
            model.layoutSnapAnimating
              ? agentIslandCompactSnapAnimation
              : (model.layoutDragActive ? nil : agentIslandOpenAnimation),
            value: layout
          )
          .onTapGesture {
            if !layout.expanded {
              eventSink(["type": "expand"])
            }
          }

        TrackingLayer(
          layout: layout,
          state: model.state,
          dragActive: model.layoutDragActive,
          dragMode: model.layoutDragMode
        ) { menuBar, panel in
          model.locallyHovered = menuBar || panel
          eventSink(["type": "hover", "menuBar": menuBar, "panel": panel])
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
      .opacity(model.state.visible ? 1 : 0)
      .agentIslandMascotAnimationsActive(model.mascotAnimationsActive)
      .agentIslandMascotAnimationEpoch(model.mascotAnimationEpoch)
    }
  }

  private func islandBody(layout: AgentIslandLayout) -> some View {
    ZStack(alignment: .top) {
      NotchShape(
        topExtension: layout.topExtension,
        bottomRadius: layout.bottomRadius,
        minHeight: layout.menuBarZoneHeight
      )
        .fill(Color.black)
        .shadow(
          color: Color.black.opacity(layout.shadowOpacity),
          radius: layout.shadowRadius,
          x: 0,
          y: layout.shadowY
        )

      content(layout: layout)
        .frame(width: layout.width, height: layout.height, alignment: .top)
        .clipShape(NotchShape(
          topExtension: layout.topExtension,
          bottomRadius: layout.bottomRadius,
          minHeight: layout.menuBarZoneHeight
        ))
    }
  }

  @ViewBuilder
  private func content(layout: AgentIslandLayout) -> some View {
    if let current = model.currentSession {
      if layout.expanded {
        ExpandedSessionsView(
          current: current,
          sessions: model.state.sessions,
          displaySurface: model.state.displaySurface,
          totalCount: model.state.totalCount,
          updatedAt: model.state.updatedAt,
          layout: layout,
          strings: model.state.displayStrings,
          soundEnabled: model.state.displaySoundSettings.enabled,
          mascotSkin: model.state.displayMascotSkin,
          runningMascotNamespace: runningMascotNamespace,
          eventSink: eventSink
        )
          .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
      } else {
        CompactSessionView(
          session: current,
          pillSnapshot: model.state.pillSnapshot,
          layout: layout,
          mascotSkin: model.state.displayMascotSkin,
          runningMascotNamespace: runningMascotNamespace
        )
          .frame(height: layout.height)
      }
    } else {
      IdleIslandView(
        layout: layout,
        strings: model.state.displayStrings,
        soundEnabled: model.state.displaySoundSettings.enabled,
        mascotSkin: model.state.displayMascotSkin,
        eventSink: eventSink
      )
        .frame(height: layout.height)
    }
  }
}

struct CompactSessionView: View {
  let session: AgentIslandSession
  let pillSnapshot: AgentIslandPillSnapshot
  let layout: AgentIslandLayout
  let mascotSkin: String
  let runningMascotNamespace: Namespace.ID

  var body: some View {
    if layout.hardwareNotchHidden {
      Color.clear
    } else if layout.hasHardwareNotch && !layout.expanded {
      hardwareNotchBody
    } else {
      regularBody
    }
  }

  private var regularBody: some View {
    HStack(spacing: layout.expanded ? 9 : 7) {
      compactTitleLine(showsSubtitle: showsRegularDetail)
        .layoutPriority(2)
      if showsRegularBadge {
        Spacer(minLength: 0)
        PillBadge(pillSnapshot: pillSnapshot)
          .layoutPriority(0)
      }
    }
    .padding(.horizontal, compactHorizontalPadding)
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  private var compactHorizontalPadding: CGFloat {
    layout.expanded ? expandedIslandHorizontalPadding : (layout.width <= 96 ? 7 : 11)
  }

  private var showsRegularDetail: Bool {
    !layout.expanded
      && !layout.hasHardwareNotch
      && layout.width >= compactIslandDetailCollapseContentThreshold
      && !session.subtitle.isEmpty
  }

  private var showsRegularBadge: Bool {
    !layout.expanded
      && !layout.hasHardwareNotch
      && layout.width >= compactIslandBadgeCollapseContentThreshold
  }

  private var hardwareNotchBody: some View {
    let sideWidth = max(32, (layout.width - layout.notchWidth) / 2)
    return HStack(spacing: 0) {
      hardwareNotchLeadingContent(sideWidth: sideWidth)

      Spacer(minLength: layout.notchWidth)

      hardwareNotchTrailingContent(sideWidth: sideWidth)
    }
  }

  private func hardwareNotchLeadingContent(sideWidth: CGFloat) -> some View {
    let textOpacity = hardwareNotchTextOpacity(sideWidth: sideWidth)
    return HStack(spacing: 6) {
      StatusDot(session: session, compact: true, mascotSkin: mascotSkin, runningMascotNamespace: runningMascotNamespace)
        .frame(width: 18, height: 18)

      compactTextView(
        compactTitle,
        fontSize: 10,
        weight: .semibold,
        color: sessionIdentityColor(for: session),
        baseOpacity: session.phase == "running" ? 0.66 : 1
      )
        .lineLimit(1)
        .truncationMode(.tail)
        .fixedSize(horizontal: true, vertical: false)
        .opacity(textOpacity)
    }
    .padding(.leading, hardwareNotchSideInset(sideWidth: sideWidth, compactWidth: 18))
    .frame(width: sideWidth, alignment: .leading)
    .clipped()
  }

  private func hardwareNotchTrailingContent(sideWidth: CGFloat) -> some View {
    let textOpacity = hardwareNotchTextOpacity(sideWidth: sideWidth)
    return HStack(spacing: 5) {
      if !session.subtitle.isEmpty {
        compactTextView(
          session.subtitle,
          fontSize: 9,
          weight: .regular,
          color: .white,
          baseOpacity: 0.56
        )
          .lineLimit(1)
          .truncationMode(.tail)
          // No fixedSize here: the subtitle must yield width (and truncate) so the
          // count badge keeps its full intrinsic width instead of being clipped.
          .opacity(textOpacity)
      }

      PillBadge(pillSnapshot: pillSnapshot, compact: true)
        .layoutPriority(1)
    }
    .padding(.trailing, hardwareNotchSideInset(sideWidth: sideWidth, compactWidth: 22))
    .frame(width: sideWidth, alignment: .trailing)
    .clipped()
  }

  private func hardwareNotchSideInset(sideWidth: CGFloat, compactWidth: CGFloat) -> CGFloat {
    max(7, (min(sideWidth, 40) - compactWidth) / 2)
  }

  private func hardwareNotchTextOpacity(sideWidth: CGFloat) -> Double {
    let progress = (sideWidth - hardwareNotchTextRevealStartSideWidth)
      / hardwareNotchTextRevealDistance
    return Double(min(1, max(0, progress)))
  }

  @ViewBuilder
  private func compactTitleLine(showsSubtitle: Bool = true) -> some View {
    let spacing: CGFloat = layout.expanded ? 9 : 7
    if showsSubtitle && !session.subtitle.isEmpty {
      GeometryReader { proxy in
        let titleMaxWidth = compactTitleMaxWidth(containerWidth: proxy.size.width, spacing: spacing)
        let titleWidth = compactTitleWidth(maxWidth: titleMaxWidth)
        HStack(spacing: spacing) {
          StatusDot(session: session, compact: true, mascotSkin: mascotSkin, runningMascotNamespace: runningMascotNamespace)
            .frame(width: compactIslandStatusIconWidth, height: compactIslandStatusIconWidth)
          compactTextView(
            compactTitle,
            fontSize: 11,
            weight: .semibold,
            color: sessionIdentityColor(for: session),
            baseOpacity: session.phase == "running" ? 0.66 : 1
          )
            .lineLimit(1)
            .truncationMode(.tail)
            .frame(width: titleWidth, alignment: .leading)
          compactTextView(
            session.subtitle,
            fontSize: 10,
            weight: .regular,
            color: .white,
            baseOpacity: 0.58
          )
            .lineLimit(1)
            .truncationMode(.tail)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(width: proxy.size.width, height: proxy.size.height, alignment: .leading)
      }
      .frame(height: compactIslandStatusIconWidth)
    } else {
      HStack(spacing: spacing) {
        StatusDot(session: session, compact: true, mascotSkin: mascotSkin, runningMascotNamespace: runningMascotNamespace)
        compactTextView(
          compactTitle,
          fontSize: 11,
          weight: .semibold,
          color: sessionIdentityColor(for: session),
          baseOpacity: session.phase == "running" ? 0.66 : 1
        )
          .lineLimit(1)
          .truncationMode(.tail)
          .frame(minWidth: compactTitleMinimumWidth, maxWidth: .infinity, alignment: .leading)
      }
      .frame(maxWidth: .infinity, alignment: .leading)
    }
  }

  private func compactTitleMaxWidth(containerWidth: CGFloat, spacing: CGFloat) -> CGFloat {
    let availableTextWidth = max(0, containerWidth - compactIslandStatusIconWidth - spacing * 2)
    let minTitleWidth = min(compactTitleMinimumWidth, availableTextWidth)
    let minDetailWidth = min(compactIslandDetailMinimumWidth, max(0, availableTextWidth - minTitleWidth))
    let ratioMaxWidth = max(minTitleWidth, availableTextWidth * compactIslandTitleMaxWidthFraction)
    let absoluteMaxWidth = max(minTitleWidth, availableTextWidth - minDetailWidth)
    return min(ratioMaxWidth, absoluteMaxWidth)
  }

  private func compactTitleWidth(maxWidth: CGFloat) -> CGFloat {
    let idealWidth = measuredCompactTitleWidth()
    return min(maxWidth, idealWidth)
  }

  private func measuredCompactTitleWidth() -> CGFloat {
    let font = NSFont.monospacedSystemFont(ofSize: 11, weight: .semibold)
    let width = (compactTitle as NSString).size(withAttributes: [.font: font]).width
    return max(1, ceil(width + 1))
  }

  private var compactTitleMinimumWidth: CGFloat {
    compactTitleContainsCjk ? compactIslandCjkTitleMinimumWidth : compactIslandLatinTitleMinimumWidth
  }

  private var compactTitleContainsCjk: Bool {
    compactTitle.unicodeScalars.contains { scalar in
      (0x3400...0x9FFF).contains(scalar.value)
        || (0xF900...0xFAFF).contains(scalar.value)
        || (0x3040...0x30FF).contains(scalar.value)
        || (0xAC00...0xD7AF).contains(scalar.value)
    }
  }

  @ViewBuilder
  private func compactTextView(
    _ text: String,
    fontSize: CGFloat,
    weight: Font.Weight,
    color: Color,
    baseOpacity: Double
  ) -> some View {
    let font = Font.system(size: fontSize, weight: weight, design: .monospaced)
    if session.phase == "running" {
      AgentIslandWaveText(
        text: text,
        font: font,
        color: color,
        baseOpacity: baseOpacity,
        lineLimit: 1
      )
    } else {
      Text(text)
        .font(font)
        .foregroundColor(color.opacity(baseOpacity))
        .lineLimit(1)
        .truncationMode(.tail)
    }
  }

  private var compactTitle: String {
    pillSnapshot.priorityCompactTitle.isEmpty ? session.displayTitle : pillSnapshot.priorityCompactTitle
  }
}

struct IdleIslandView: View {
  let layout: AgentIslandLayout
  let strings: AgentIslandStrings
  let soundEnabled: Bool
  let mascotSkin: String
  let eventSink: ([String: Any]) -> Void

  var body: some View {
    ZStack(alignment: .top) {
      idleContent

      if layout.expanded {
        idleCreateEntry

        HStack {
          Spacer(minLength: 0)
          ExpandedIslandToolbarControls(strings: strings, soundEnabled: soundEnabled, eventSink: eventSink)
        }
        .padding(.horizontal, expandedIslandCardHorizontalPadding)
        .frame(height: layout.menuBarZoneHeight, alignment: .center)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
      }
    }
  }

  private var idleCreateEntry: some View {
    VStack(spacing: 0) {
      Color.clear
        .frame(height: layout.menuBarZoneHeight + 7)

      IdleCreateConversationRow(strings: strings) {
        eventSink(["type": "new-message"])
      }
      .padding(.horizontal, expandedIslandCardHorizontalPadding)

      Spacer(minLength: 0)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
  }

  @ViewBuilder
  private var idleContent: some View {
    if layout.hardwareNotchHidden {
      Color.clear
    } else if layout.hasHardwareNotch {
      hardwareNotchBody
    } else {
      idleMark()
        .frame(height: layout.expanded ? layout.menuBarZoneHeight : nil)
        .frame(
          maxWidth: .infinity,
          maxHeight: .infinity,
          alignment: layout.expanded ? .top : .center
        )
    }
  }

  private var hardwareNotchBody: some View {
    let sideWidth = max(0, (layout.width - layout.notchWidth) / 2)
    let textOpacity = hardwareNotchTextOpacity(sideWidth: sideWidth)
    return HStack(spacing: 0) {
      idleMark(textOpacity: textOpacity)
        .frame(width: sideWidth, alignment: .leading)
        .clipped()
      Spacer(minLength: layout.notchWidth)
      Color.clear
        .frame(width: sideWidth)
    }
    .frame(height: layout.expanded ? layout.menuBarZoneHeight : nil)
    .frame(
      maxWidth: .infinity,
      maxHeight: .infinity,
      alignment: layout.expanded ? .top : .center
    )
  }

  private func idleMark(textOpacity: Double = 1) -> some View {
    HStack(spacing: 5) {
      AgentIslandMascotView(skin: mascotSkin, state: .idle, size: 16)
        .frame(width: 16, height: 16)
      Text(strings.displayAppName)
        .font(.system(size: 10, weight: .semibold, design: .monospaced))
        .foregroundColor(Color.white.opacity(0.24))
        .opacity(textOpacity)
        .lineLimit(1)
        .fixedSize(horizontal: true, vertical: false)
    }
  }

  private func hardwareNotchTextOpacity(sideWidth: CGFloat) -> Double {
    let progress = (sideWidth - hardwareNotchTextRevealStartSideWidth)
      / hardwareNotchTextRevealDistance
    return Double(min(1, max(0, progress)))
  }
}

struct IdleCreateConversationRow: View {
  let strings: AgentIslandStrings
  let action: () -> Void
  @State private var isHovered = false

  var body: some View {
    let shape = RoundedRectangle(cornerRadius: 13, style: .continuous)
    Button(action: action) {
      HStack(alignment: .center, spacing: 10) {
        ZStack {
          Circle()
            .fill(Color.white.opacity(isHovered ? 0.13 : 0.075))
          Image(systemName: "plus")
            .font(.system(size: 12, weight: .semibold))
            .foregroundColor(Color.white.opacity(isHovered ? 0.78 : 0.58))
        }
        .frame(width: 28, height: 28)

        VStack(alignment: .leading, spacing: 4) {
          Text(strings.newConversationTitle)
            .font(.system(size: 12, weight: .bold, design: .monospaced))
            .foregroundColor(Color.white.opacity(isHovered ? 0.88 : 0.76))
            .lineLimit(1)
            .truncationMode(.tail)

          Text(strings.newConversationHint)
            .font(.system(size: 10, weight: .regular, design: .monospaced))
            .foregroundColor(Color.white.opacity(isHovered ? 0.50 : 0.36))
            .lineLimit(1)
            .truncationMode(.tail)
        }

        Spacer(minLength: 8)

        Image(systemName: "arrow.up.right")
          .font(.system(size: 10, weight: .semibold))
          .foregroundColor(Color.white.opacity(isHovered ? 0.48 : 0.28))
      }
      .frame(maxWidth: .infinity, minHeight: expandedIslandMultiRowHeight, alignment: .leading)
      .padding(.horizontal, 14)
      .background(
        shape
          .fill(Color.white.opacity(isHovered ? 0.085 : 0.045))
          .overlay(
            shape.stroke(Color.white.opacity(isHovered ? 0.14 : 0.045), lineWidth: 1)
          )
      )
      .contentShape(shape)
    }
    .buttonStyle(.plain)
    .onHover { isHovered = $0 }
    .animation(.easeOut(duration: 0.12), value: isHovered)
  }
}

struct ExpandedIslandTopBar: View {
  var title: String? = nil
  let mascotState: AgentIslandMascotAnimationState?
  let layout: AgentIslandLayout
  let strings: AgentIslandStrings
  let soundEnabled: Bool
  let mascotSkin: String
  let runningMascotNamespace: Namespace.ID
  let eventSink: ([String: Any]) -> Void

  var body: some View {
    if shouldAvoidHardwareNotch {
      hardwareNotchBody
    } else {
      regularBody
    }
  }

  private var shouldAvoidHardwareNotch: Bool {
    layout.expanded && layout.hasHardwareNotch
  }

  private var regularBody: some View {
    HStack(spacing: 8) {
      leadingContent
      Spacer(minLength: 8)
      ExpandedIslandToolbarControls(strings: strings, soundEnabled: soundEnabled, eventSink: eventSink)
    }
    .frame(maxWidth: .infinity, minHeight: expandedIslandTopBarHeight, alignment: .center)
  }

  private var hardwareNotchBody: some View {
    GeometryReader { proxy in
      let notchWidth = min(layout.notchWidth, max(0, proxy.size.width))
      let sideWidth = max(0, (proxy.size.width - notchWidth) / 2)
      HStack(spacing: 0) {
        leadingContent
          .frame(width: sideWidth, alignment: .leading)
          .clipped()

        Color.clear
          .frame(width: notchWidth)

        ExpandedIslandToolbarControls(strings: strings, soundEnabled: soundEnabled, eventSink: eventSink)
          .frame(width: sideWidth, alignment: .trailing)
          .clipped()
      }
      .frame(width: proxy.size.width, height: proxy.size.height, alignment: .center)
    }
    .frame(
      maxWidth: .infinity,
      minHeight: expandedIslandTopBarHeight,
      maxHeight: expandedIslandTopBarHeight,
      alignment: .center
    )
  }

  @ViewBuilder
  private var leadingContent: some View {
    if mascotState != nil || title != nil {
      HStack(spacing: 8) {
        if let mascotState {
          RunningMascotIcon(skin: mascotSkin, state: mascotState, size: 18, namespace: runningMascotNamespace)
        }

        if let title {
          Text(title)
            .font(.system(size: 10, weight: .semibold, design: .monospaced))
            .foregroundColor(Color.white.opacity(0.34))
            .lineLimit(1)
            .truncationMode(.tail)
        }
      }
    }
  }
}

struct ExpandedIslandToolbarControls: View {
  let strings: AgentIslandStrings
  let soundEnabled: Bool
  let eventSink: ([String: Any]) -> Void
  @State private var controlsVisible = false

  var body: some View {
    HStack(spacing: 5) {
      ExpandedIslandToolbarButton(
        systemName: soundEnabled ? "speaker.wave.2.fill" : "speaker.slash.fill",
        help: soundEnabled ? strings.muteSound : strings.enableSound,
        iconOpacity: soundEnabled ? 0.64 : 0.48
      ) {
        eventSink(["type": "toggle-sound"])
      }

      ExpandedIslandToolbarButton(
        systemName: "gearshape.fill",
        help: strings.settings
      ) {
        eventSink(["type": "open-settings"])
      }

      ExpandedIslandToolbarButton(
        systemName: "square.and.pencil",
        help: strings.newMessage
      ) {
        eventSink(["type": "new-message"])
      }
    }
    .opacity(controlsVisible ? 1 : 0)
    .allowsHitTesting(controlsVisible)
    .onAppear {
      controlsVisible = false
      DispatchQueue.main.asyncAfter(deadline: .now() + expandedIslandToolbarRevealDelay) {
        withAnimation(.easeOut(duration: 0.12)) {
          controlsVisible = true
        }
      }
    }
    .onDisappear {
      controlsVisible = false
    }
  }
}

struct ExpandedIslandToolbarButton: View {
  let systemName: String
  let help: String
  var iconOpacity: Double = 0.60
  let action: () -> Void
  @State private var isHovered = false

  var body: some View {
    Button(action: action) {
      Image(systemName: systemName)
        .font(.system(size: 10.5, weight: .semibold))
        .foregroundColor(Color.white.opacity(isHovered ? min(0.82, iconOpacity + 0.18) : iconOpacity))
        .frame(width: 23, height: 23)
        .background(
          Circle()
            .fill(Color.white.opacity(isHovered ? 0.12 : 0.045))
            .overlay(
              Circle()
                .stroke(Color.white.opacity(isHovered ? 0.12 : 0.045), lineWidth: 1)
            )
        )
        .contentShape(Circle())
    }
    .buttonStyle(.plain)
    .help(help)
    .onHover { hovering in
      withAnimation(.easeOut(duration: 0.12)) {
        isHovered = hovering
      }
    }
  }
}

struct PillBadge: View {
  let pillSnapshot: AgentIslandPillSnapshot
  var compact: Bool = false

  /// Text runs and minimum capsule width for the badge variant a snapshot renders.
  /// Shared by `body` and `intrinsicWidth` so reserved layout width can never
  /// drift away from what actually gets drawn.
  struct Metrics {
    /// One entry per rendered `Text`; each is laid out (and rounded) separately.
    let segments: [String]
    let minWidth: CGFloat
    let fontSize: CGFloat
  }

  static func metrics(pillSnapshot: AgentIslandPillSnapshot, compact: Bool) -> Metrics {
    let fontSize: CGFloat = compact ? 10 : 11
    if pillSnapshot.activeSessionCount > 0 && pillSnapshot.sessionCount > 1 {
      return Metrics(
        segments: ["\(pillSnapshot.activeSessionCount)", "/", "\(pillSnapshot.sessionCount)"],
        minWidth: compact ? 30 : 34,
        fontSize: fontSize
      )
    }
    return Metrics(
      segments: ["\(max(1, pillSnapshot.sessionCount))"],
      minWidth: compact ? 22 : 24,
      fontSize: fontSize
    )
  }

  /// Width the hardware-notch layout reserves for the capsule so a multi-digit count is
  /// never clipped.
  ///
  /// This is deliberately a *nominal* width computed from digit counts, not an `NSFont`
  /// measurement: main computes the carrier width from the very same formula in
  /// `getAgentIslandCompactBadgeWidth` (`shared/agentIsland.ts`), and the two must agree
  /// exactly. A measured value here would sit a few points below the TS estimate, and
  /// every snap comparison against the delivered width would silently miss.
  /// `nominalCharWidth` is an upper bound on the real advance, so the reserved width is
  /// always at least what SwiftUI draws — `badge-probe` harness asserts that.
  static func intrinsicWidth(pillSnapshot: AgentIslandPillSnapshot, compact: Bool) -> CGFloat {
    let metrics = metrics(pillSnapshot: pillSnapshot, compact: compact)
    let segmentsWidth = metrics.segments.reduce(CGFloat(0)) { total, segment in
      total + CGFloat(segment.count) * nominalCharWidth + segmentRoundingSlack
    }
    let spacing = activeTotalSpacing * CGFloat(max(0, metrics.segments.count - 1))
    return max(metrics.minWidth, segmentsWidth + spacing + contentInset * 2)
  }

  private static let activeTotalSpacing: CGFloat = 1
  private static let contentInset: CGFloat = 2
  /// Upper bound for one monospaced 10pt digit (real advance is ~6pt). Mirrors
  /// `AGENT_ISLAND_COMPACT_BADGE_CHAR_WIDTH_BOUND` on the TS side.
  private static let nominalCharWidth: CGFloat = 7
  /// Per-segment rounding slack; SwiftUI lays out and rounds every `Text` run
  /// separately. Mirrors `AGENT_ISLAND_COMPACT_BADGE_SEGMENT_ROUNDING_SLACK`.
  private static let segmentRoundingSlack: CGFloat = 1

  var body: some View {
    if pillSnapshot.activeSessionCount > 0 && pillSnapshot.sessionCount > 1 {
      activeTotalBadge(
        active: pillSnapshot.activeSessionCount,
        total: pillSnapshot.sessionCount,
        emphasized: isEmphasized
      )
    } else {
      badge("\(max(1, pillSnapshot.sessionCount))", emphasized: isEmphasized)
    }
  }

  private func badge(_ text: String, emphasized: Bool) -> some View {
    Text(text)
      .font(badgeFont)
      .foregroundColor(Color.white.opacity(0.92))
      // Multi-digit counts must widen the capsule instead of wrapping into two lines.
      .lineLimit(1)
      .fixedSize(horizontal: true, vertical: false)
      .padding(.horizontal, Self.contentInset)
      .frame(minWidth: metrics.minWidth, minHeight: compact ? 18 : 20)
      .background(Color.white.opacity(emphasized ? 0.11 : 0.065))
      .clipShape(Capsule())
  }

  private func activeTotalBadge(active: Int, total: Int, emphasized: Bool) -> some View {
    HStack(spacing: Self.activeTotalSpacing) {
      Text("\(active)")
        .foregroundColor(emphasized ? agentIslandBlue : agentIslandOrange)
      Text("/")
        .foregroundColor(Color.white.opacity(0.42))
      Text("\(total)")
        .foregroundColor(Color.white.opacity(0.92))
    }
    .font(badgeFont)
    // Multi-digit counts must widen the capsule instead of wrapping into two lines.
    .lineLimit(1)
    .fixedSize(horizontal: true, vertical: false)
    .padding(.horizontal, Self.contentInset)
    .frame(minWidth: metrics.minWidth, minHeight: compact ? 18 : 20)
    .background(Color.white.opacity(emphasized ? 0.11 : 0.065))
    .clipShape(Capsule())
  }

  private var metrics: Metrics {
    Self.metrics(pillSnapshot: pillSnapshot, compact: compact)
  }

  private var badgeFont: Font {
    .system(size: metrics.fontSize, weight: .semibold, design: .monospaced)
  }

  private var isEmphasized: Bool {
    pillSnapshot.pendingInteractionCount > 0 || pillSnapshot.attentionCount > 0
  }
}

struct AgentIslandWaveText: View {
  let text: String
  let font: Font
  let color: Color
  var baseOpacity: Double = 0.58
  var lineLimit: Int? = 1
  var truncationMode: Text.TruncationMode = .tail
  var lineSpacing: CGFloat = 0
  var bandWidth: CGFloat = agentIslandTextWaveBandWidth

  @State private var phase: CGFloat = -agentIslandTextWaveBandWidth

  var body: some View {
    baseText
      .overlay(alignment: .leading) {
        GeometryReader { proxy in
          Color.clear
            .overlay(alignment: .leading) {
              waveBand
                .frame(width: bandWidth)
                .offset(x: phase)
            }
            .mask(
              baseText
                .foregroundColor(.white)
                .frame(width: proxy.size.width, height: proxy.size.height, alignment: .leading)
            )
            .onAppear {
              restartWave(width: proxy.size.width)
            }
            .onChange(of: proxy.size.width) { _, width in
              restartWave(width: width)
            }
        }
        .allowsHitTesting(false)
      }
      .onDisappear {
        phase = -bandWidth
      }
  }

  private var baseText: some View {
    Text(text)
      .font(font)
      .foregroundColor(color.opacity(baseOpacity))
      .lineLimit(lineLimit)
      .truncationMode(truncationMode)
      .lineSpacing(lineSpacing)
  }

  private var waveBand: some View {
    LinearGradient(
      stops: [
        .init(color: .clear, location: 0),
        .init(color: color.opacity(0.22), location: 0.34),
        .init(color: .white.opacity(0.88), location: 0.50),
        .init(color: color.opacity(0.30), location: 0.66),
        .init(color: .clear, location: 1),
      ],
      startPoint: .leading,
      endPoint: .trailing
    )
  }

  private func restartWave(width: CGFloat) {
    guard width > 1 else {
      return
    }
    phase = -bandWidth
    withAnimation(.easeInOut(duration: agentIslandTextWaveDuration).repeatForever(autoreverses: false)) {
      phase = width + bandWidth
    }
  }
}

struct ExpandedSessionsView: View {
  let current: AgentIslandSession
  let sessions: [AgentIslandSession]
  let displaySurface: String
  let totalCount: Int
  let updatedAt: Double
  let layout: AgentIslandLayout
  let strings: AgentIslandStrings
  let soundEnabled: Bool
  let mascotSkin: String
  let runningMascotNamespace: Namespace.ID
  let eventSink: ([String: Any]) -> Void
  @State private var lastReportedContentHeight: CGFloat = 0

  private var allSessions: [AgentIslandSession] {
    // The main process owns session priority and freezes this order while expanded.
    sessions.isEmpty ? [current] : sessions
  }

  private var sessionListNeedsScroll: Bool {
    allSessions.count >= expandedIslandMaxVisibleRows
  }

  private var sessionListViewportHeight: CGFloat {
    let reservedHeight = expandedIslandTopPadding
      + expandedIslandTopBarHeight
      + expandedIslandBodySpacing
      + expandedIslandBottomPadding
    let availableHeight = max(
      expandedIslandMultiRowSlotHeight,
      layout.height - reservedHeight
    )
    let maxVisibleRowsHeight = CGFloat(expandedIslandMaxVisibleRows) * expandedIslandMultiRowSlotHeight
    return min(availableHeight, maxVisibleRowsHeight)
  }

  private var currentMascotState: AgentIslandMascotAnimationState? {
    mascotAnimationState(for: current)
  }

  var body: some View {
    VStack(spacing: expandedIslandBodySpacing) {
      ExpandedIslandTopBar(
        mascotState: currentMascotState,
        layout: layout,
        strings: strings,
        soundEnabled: soundEnabled,
        mascotSkin: mascotSkin,
        runningMascotNamespace: runningMascotNamespace,
        eventSink: eventSink
      )
        .padding(.horizontal, expandedIslandCardHorizontalPadding)
        .padding(.top, expandedIslandTopPadding)

      Group {
        if displaySurface == "sessionList" && allSessions.count > 1 {
          multiSessionBody
        } else {
          singleSessionBody
        }
      }
    }
    .transition(.opacity)
    .background(ExpandedContentHeightReader())
    .onPreferenceChange(ExpandedContentHeightPreferenceKey.self) { height in
      reportContentHeight(height)
    }
  }

  private func reportContentHeight(_ height: CGFloat) {
    let rounded = ceil(height)
    guard rounded > 0, abs(lastReportedContentHeight - rounded) >= 1 else {
      return
    }
    lastReportedContentHeight = rounded
    eventSink(["type": "content-height", "height": Double(rounded)])
  }

  private var singleSessionBody: some View {
    VStack(alignment: .leading, spacing: 10) {
      ExpandedSessionRow(
        session: current,
        updatedAt: updatedAt,
        strings: strings,
        mascotSkin: mascotSkin,
        onFocus: {
          eventSink(["type": "focus-session", "sessionId": current.sessionId])
        },
        onPermissionAction: emitPermissionAction
      )
      .equatable()
      .frame(maxWidth: .infinity, alignment: .leading)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(.horizontal, expandedIslandCardHorizontalPadding)
    .padding(.bottom, expandedIslandBottomPadding)
  }

  private var multiSessionBody: some View {
    let rows = sessionRows
    return VStack(alignment: .leading, spacing: 0) {
      if sessionListNeedsScroll {
        ScrollView(.vertical, showsIndicators: false) {
          rows
            .frame(maxWidth: .infinity, alignment: .topLeading)
        }
        .frame(height: sessionListViewportHeight, alignment: .top)
        .frame(maxWidth: .infinity, alignment: .top)
      } else {
        rows
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(.horizontal, expandedIslandCardHorizontalPadding)
    .padding(.bottom, expandedIslandBottomPadding)
  }

  private var sessionRows: some View {
    VStack(alignment: .leading, spacing: expandedIslandMultiRowGap) {
      ForEach(allSessions) { session in
        ExpandedSessionRow(
          session: session,
          updatedAt: updatedAt,
          strings: strings,
          mascotSkin: mascotSkin,
          onFocus: {
            eventSink(["type": "focus-session", "sessionId": session.sessionId])
          },
          onPermissionAction: emitPermissionAction
        )
        .equatable()
        .frame(maxWidth: .infinity, alignment: .leading)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  private func emitPermissionAction(_ permissionAction: AgentIslandPermissionAction, _ action: String) {
    eventSink([
      "type": "permission-action",
      "requestId": permissionAction.requestId,
      "action": action,
    ])
  }
}

struct ExpandedSessionRow: View, Equatable {
  let session: AgentIslandSession
  let updatedAt: Double
  let strings: AgentIslandStrings
  let mascotSkin: String
  let onFocus: () -> Void
  let onPermissionAction: (AgentIslandPermissionAction, String) -> Void
  @State private var isHovered = false

  static func == (lhs: ExpandedSessionRow, rhs: ExpandedSessionRow) -> Bool {
    // Callbacks are intentionally excluded: onFocus is keyed by sessionId and
    // onPermissionAction only forwards to eventSink. Re-evaluate new callbacks here.
    lhs.session == rhs.session
      && lhs.updatedAt == rhs.updatedAt
      && lhs.strings == rhs.strings
      && lhs.mascotSkin == rhs.mascotSkin
  }

  var body: some View {
    let shape = RoundedRectangle(cornerRadius: 13, style: .continuous)
    VStack(alignment: .leading, spacing: rowSpacing) {
      if session.permissionAction == nil {
        rowMainContent
      } else {
        Button(action: onFocus) {
          rowMainContent
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .frame(maxWidth: .infinity, alignment: .leading)
      }

      if let permissionAction = session.permissionAction {
        PermissionApprovalActions(action: permissionAction, strings: strings) { action in
          onPermissionAction(permissionAction, action)
        }
        .padding(.top, 4)
      }
    }
    .frame(maxWidth: .infinity, minHeight: expandedIslandMultiRowHeight, alignment: .leading)
    .padding(.horizontal, 14)
    .padding(.vertical, 10)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(
      shape
        .fill(Color.white.opacity(expandedCardFillOpacity(session: session, hovered: isHovered)))
        .overlay(
          shape.stroke(
            statusAccentColor(for: session).opacity(expandedCardStrokeOpacity(session: session, hovered: isHovered)),
            lineWidth: 1
          )
        )
    )
    .contentShape(Rectangle())
    .onHover { isHovered = $0 }
    .onTapGesture {
      if session.permissionAction == nil {
        onFocus()
      }
    }
    .animation(.easeOut(duration: 0.12), value: isHovered)
  }

  private var rowSpacing: CGFloat {
    session.permissionAction == nil ? 5 : 8
  }

  private var rowMainContent: some View {
    VStack(alignment: .leading, spacing: rowSpacing) {
      ExpandedSessionHeaderLine(
        session: session,
        strings: strings,
        titleFontSize: 12,
        mascotSkin: mascotSkin,
        onFocus: onFocus
      )
      ExpandedRowSummaryLine(session: session, strings: strings)
      ExpandedSessionMetaLine(session: session, updatedAt: updatedAt, fontSize: 9.5)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }
}

func expandedCardFillOpacity(session: AgentIslandSession, hovered: Bool) -> Double {
  let base = session.phase == "needs-interaction" ? 0.075 : 0.055
  return hovered ? base + 0.035 : base
}

func expandedCardStrokeOpacity(session: AgentIslandSession, hovered: Bool) -> Double {
  let base = session.phase == "needs-interaction" ? 0.18 : 0.045
  return hovered ? max(base, 0.18) : base
}

struct ExpandedSessionHeaderLine: View {
  let session: AgentIslandSession
  let strings: AgentIslandStrings
  let titleFontSize: CGFloat
  let mascotSkin: String
  let onFocus: () -> Void

  private var showsMascot: Bool {
    switch session.phase {
    case "needs-interaction", "completed":
      return false
    default:
      return true
    }
  }

  var body: some View {
    HStack(alignment: .center, spacing: 8) {
      StatusDot(
        session: session,
        compact: false,
        showsRunningAnimation: showsMascot,
        mascotSkin: mascotSkin
      )

      Text(expandedPrimaryTitle(for: session, strings: strings))
        .font(.system(size: titleFontSize, weight: .bold, design: .monospaced))
        .foregroundColor(sessionIdentityColor(for: session))
        .lineLimit(1)
        .truncationMode(.tail)
        .layoutPriority(1)

      Spacer(minLength: 8)

      if session.phase == "needs-interaction", session.permissionAction == nil {
        InteractionInlineButton(label: strings.review, action: onFocus)
      } else {
        SessionStatusCapsule(session: session, strings: strings)
      }
    }
  }
}

struct ExpandedSessionMetaLine: View {
  let session: AgentIslandSession
  let updatedAt: Double
  let fontSize: CGFloat

  var body: some View {
    Text(expandedMetaText(for: session, updatedAt: updatedAt))
      .font(.system(size: fontSize, weight: .regular, design: .monospaced))
      .foregroundColor(Color.white.opacity(0.34))
      .lineLimit(1)
      .truncationMode(.tail)
  }
}

struct ExpandedRowSummaryLine: View {
  let session: AgentIslandSession
  let strings: AgentIslandStrings
  var fontSize: CGFloat = 11

  var body: some View {
    let summary = expandedRowSummary(for: session, strings: strings)
    HStack(alignment: .firstTextBaseline, spacing: 5) {
      if !summary.prefix.isEmpty {
        Text(summary.prefix)
          .font(.system(size: fontSize, weight: .bold, design: .monospaced))
          .foregroundColor(summary.accent)
      }

      summaryTextView(summary)
    }
  }

  @ViewBuilder
  private func summaryTextView(_ summary: ExpandedRowSummary) -> some View {
    let font = Font.system(size: fontSize, weight: summary.isUser ? .medium : .regular, design: .monospaced)
    if session.phase == "running" && !summary.isUser {
      AgentIslandWaveText(
        text: summary.text,
        font: font,
        color: .white,
        baseOpacity: 0.62,
        lineLimit: 2,
        lineSpacing: 1,
        bandWidth: 96
      )
    } else {
      Text(summary.text)
        .font(font)
        .foregroundColor(Color.white.opacity(summary.isUser ? 0.88 : 0.76))
        .lineLimit(2)
        .truncationMode(.tail)
        .lineSpacing(1)
    }
  }
}

struct SessionStatusCapsule: View {
  let session: AgentIslandSession
  let strings: AgentIslandStrings

  var body: some View {
    let accent = statusAccentColor(for: session)
    Text(expandedStatusBadgeText(for: session, strings: strings))
      .font(.system(size: 10, weight: .medium, design: .monospaced))
      .foregroundColor(accent.opacity(session.attention ? 0.95 : 0.72))
      .lineLimit(1)
      .fixedSize(horizontal: true, vertical: false)
      .padding(.horizontal, 8)
      .frame(height: 20)
      .background(accent.opacity(session.attention ? 0.16 : 0.08))
      .clipShape(Capsule())
      .layoutPriority(2)
  }
}

struct InteractionInlineButton: View {
  let label: String
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      HStack(spacing: 4) {
        Image(systemName: "arrowshape.turn.up.right.fill")
          .font(.system(size: 9, weight: .bold))
        Text(label)
          .font(.system(size: 10, weight: .semibold, design: .monospaced))
          .lineLimit(1)
      }
      .foregroundColor(agentIslandBlue.opacity(0.98))
      .fixedSize(horizontal: true, vertical: false)
      .padding(.horizontal, 8)
      .frame(height: 22)
      .background(agentIslandBlue.opacity(0.16))
      .clipShape(Capsule())
    }
    .buttonStyle(.plain)
    .layoutPriority(2)
  }
}

struct PermissionApprovalActions: View {
  let action: AgentIslandPermissionAction
  let strings: AgentIslandStrings
  let onAction: (String) -> Void

  var body: some View {
    HStack(spacing: 7) {
      PermissionActionButton(
        label: strings.deny,
        systemImage: "xmark",
        role: .secondary,
        action: { onAction("deny") }
      )

      Spacer(minLength: 4)

      if action.canAllowForSession {
        PermissionActionButton(
          label: strings.alwaysAllowForSession,
          systemImage: "checkmark.seal",
          role: .secondary,
          action: { onAction("allowForSession") }
        )
      }

      PermissionActionButton(
        label: strings.allowOnce,
        systemImage: "checkmark",
        role: .primary,
        action: { onAction("allow") }
      )
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }
}

struct PermissionActionButton: View {
  enum Role {
    case primary
    case secondary
  }

  let label: String
  let systemImage: String
  let role: Role
  let action: () -> Void
  @State private var isHovered = false

  var body: some View {
    Button(action: action) {
      HStack(spacing: 5) {
        Image(systemName: systemImage)
          .font(.system(size: 9, weight: .bold))
        Text(label)
          .font(.system(size: 10, weight: .semibold, design: .monospaced))
          .lineLimit(1)
      }
      .foregroundColor(foregroundColor)
      .fixedSize(horizontal: true, vertical: false)
      .padding(.horizontal, 9)
      .frame(height: 24)
      .background(backgroundColor)
      .clipShape(Capsule())
    }
    .buttonStyle(.plain)
    .onHover { isHovered = $0 }
  }

  private var foregroundColor: Color {
    switch role {
    case .primary:
      return agentIslandBlue.opacity(0.98)
    case .secondary:
      return Color.white.opacity(0.76)
    }
  }

  private var backgroundColor: Color {
    switch role {
    case .primary:
      return agentIslandBlue.opacity(isHovered ? 0.24 : 0.16)
    case .secondary:
      return Color.white.opacity(isHovered ? 0.16 : 0.08)
    }
  }
}

struct ExpandedRowSummary {
  let prefix: String
  let text: String
  let accent: Color
  let isUser: Bool
}

func expandedPrimaryTitle(for session: AgentIslandSession, strings: AgentIslandStrings) -> String {
  if session.permissionAction != nil {
    return strings.permissionPromptTitle
  }
  let title = session.title.trimmingCharacters(in: .whitespacesAndNewlines)
  if isMeaningfulExpandedTitle(title) {
    return title
  }
  let project = session.projectName?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
  if !project.isEmpty {
    return project
  }
  return "#\(String(session.sessionId.prefix(8)))"
}

func isMeaningfulExpandedTitle(_ title: String) -> Bool {
  if title.isEmpty { return false }
  let normalized = title.lowercased()
  return normalized != "new maker"
    && normalized != "untitled"
    && normalized != "codex"
    && normalized != "claude"
    && normalized != "claude code"
    && normalized != "agent"
}

func sessionIdentityColor(for session: AgentIslandSession) -> Color {
  switch session.phase {
  case "running":
    return agentIslandOrange
  case "needs-interaction":
    return agentIslandBlue
  case "error":
    return agentIslandErrorRed
  default:
    return Color.white.opacity(0.92)
  }
}

func statusAccentColor(for session: AgentIslandSession) -> Color {
  switch session.phase {
  case "running":
    return agentIslandOrange
  case "needs-interaction":
    return agentIslandBlue
  case "error":
    return agentIslandErrorRed
  default:
    return Color.white.opacity(0.68)
  }
}

func expandedRowSummary(for session: AgentIslandSession, strings: AgentIslandStrings) -> ExpandedRowSummary {
  switch session.phase {
  case "needs-interaction":
    return ExpandedRowSummary(
      prefix: session.permissionAction == nil ? "!" : "?",
      text: bestInteractionSummary(for: session, strings: strings),
      accent: agentIslandBlue,
      isUser: false
    )
  case "completed":
    if let preview = messagePreviewSummary(for: session) {
      return preview
    }
    return ExpandedRowSummary(
      prefix: "",
      text: bestCompletedSummary(for: session, strings: strings),
      accent: Color.white.opacity(0.72),
      isUser: false
    )
  case "error":
    return ExpandedRowSummary(
      prefix: "!",
      text: bestErrorSummary(for: session, strings: strings),
      accent: agentIslandErrorRed,
      isUser: false
    )
  default:
    return bestRunningSummary(for: session, strings: strings)
  }
}

func bestRunningSummary(for session: AgentIslandSession, strings: AgentIslandStrings) -> ExpandedRowSummary {
  if let preview = messagePreviewSummary(for: session) {
    return preview
  }

  let detail = stripLeadingPromptSymbol(session.detail)
  if !detail.isEmpty && !isGenericRunningStatusDetail(detail) {
    return ExpandedRowSummary(
      prefix: "$",
      text: detail,
      accent: statusAccentColor(for: session),
      isUser: false
    )
  }
  if let line = latestActivityLine(for: session, kinds: ["assistant", "status", "tool"]) {
    return ExpandedRowSummary(
      prefix: line.kind == "assistant" ? "" : "$",
      text: stripLeadingPromptSymbol(compactText(line.text)),
      accent: line.kind == "assistant" ? Color.white.opacity(0.72) : agentIslandOrange,
      isUser: false
    )
  }
  if let line = latestActivityLine(for: session, kinds: ["user"]) {
    return ExpandedRowSummary(
      prefix: ">",
      text: stripLeadingPromptSymbol(compactText(line.text)),
      accent: agentIslandBlue,
      isUser: true
    )
  }
  if !detail.isEmpty {
    return ExpandedRowSummary(
      prefix: "$",
      text: detail,
      accent: statusAccentColor(for: session),
      isUser: false
    )
  }
  return ExpandedRowSummary(
    prefix: "$",
    text: expandedStatusText(for: session, strings: strings),
    accent: statusAccentColor(for: session),
    isUser: false
  )
}

func messagePreviewSummary(for session: AgentIslandSession) -> ExpandedRowSummary? {
  guard let line = session.messagePreview else { return nil }
  let text = stripLeadingPromptSymbol(compactText(line.text))
  if text.isEmpty { return nil }
  if line.kind == "user" {
    return ExpandedRowSummary(
      prefix: ">",
      text: text,
      accent: agentIslandBlue,
      isUser: true
    )
  }
  if line.kind == "assistant" {
    return ExpandedRowSummary(
      prefix: "",
      text: text,
      accent: Color.white.opacity(0.72),
      isUser: false
    )
  }
  return nil
}

func bestInteractionSummary(for session: AgentIslandSession, strings: AgentIslandStrings) -> String {
  if !session.detail.isEmpty {
    return stripLeadingPromptSymbol(session.detail)
  }
  // detail 为空时不再兜底捞 status/tool 活动行 —— 那是上一个 tool 的过期状态
  // (典型 'ask_user_question running...'),与"在等你"的语义打架。改为按
  // interactionKind 出人话,与 app 侧栏卡片 awaitingText 同一策略与文案。
  switch session.interactionKind {
  case "permission":
    return strings.awaitingPermission
  case "plan_review":
    return strings.awaitingPlan
  case "ask_user_question":
    return strings.awaitingQuestion
  default:
    return strings.needsInput
  }
}

func bestCompletedSummary(for session: AgentIslandSession, strings: AgentIslandStrings) -> String {
  if let line = latestActivityLine(for: session, kinds: ["assistant"]) {
    return stripLeadingPromptSymbol(compactText(line.text))
  }
  if let line = latestActivityLine(for: session, kinds: ["status", "tool"]) {
    let text = stripLeadingPromptSymbol(compactText(line.text))
    if text.lowercased() != "done" {
      return text
    }
  }
  if !session.compactDetail.isEmpty {
    return stripLeadingPromptSymbol(session.compactDetail)
  }
  return strings.completed
}

func bestErrorSummary(for session: AgentIslandSession, strings: AgentIslandStrings) -> String {
  if !session.detail.isEmpty {
    return stripLeadingPromptSymbol(session.detail)
  }
  if let line = latestActivityLine(for: session, kinds: ["status", "assistant", "tool"]) {
    return stripLeadingPromptSymbol(compactText(line.text))
  }
  return strings.error
}

func latestActivityLine(for session: AgentIslandSession, kinds: Set<String>) -> AgentIslandActivityLine? {
  for line in session.activityLines.reversed() {
    if kinds.contains(line.kind), !compactText(line.text).isEmpty {
      return line
    }
  }
  return nil
}

func stripLeadingPromptSymbol(_ text: String) -> String {
  let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
  if trimmed.hasPrefix("$ ") || trimmed.hasPrefix("> ") {
    return String(trimmed.dropFirst(2))
  }
  return trimmed
}

func isGenericRunningStatusDetail(_ text: String) -> Bool {
  let normalized = text
    .trimmingCharacters(in: .whitespacesAndNewlines)
    .trimmingCharacters(in: CharacterSet(charactersIn: "."))
    .lowercased()
  return normalized == "generating"
    || normalized == "thinking"
    || normalized == "running"
    || normalized == "still running"
}

func expandedMetaText(for session: AgentIslandSession, updatedAt: Double) -> String {
  var parts: [String] = []
  if session.permissionAction != nil {
    let title = session.title.trimmingCharacters(in: .whitespacesAndNewlines)
    if isMeaningfulExpandedTitle(title) {
      parts.append(title)
    }
  }
  if let project = session.projectName?.trimmingCharacters(in: .whitespacesAndNewlines), !project.isEmpty {
    parts.append(project)
  }
  parts.append(sourceLabel(for: session.agentKind))
  parts.append(elapsedLabel(startedAt: session.startedAt, updatedAt: updatedAt))
  return parts.joined(separator: " · ")
}

func expandedStatusBadgeText(for session: AgentIslandSession, strings: AgentIslandStrings) -> String {
  switch session.phase {
  case "needs-interaction":
    return strings.input
  case "completed":
    return strings.done
  case "error":
    return strings.error
  default:
    return strings.running
  }
}

func expandedStatusText(for session: AgentIslandSession, strings: AgentIslandStrings) -> String {
  switch session.phase {
  case "needs-interaction":
    return session.detail.isEmpty ? strings.needsInput : session.detail
  case "completed":
    return strings.completed
  case "error":
    return session.detail.isEmpty ? strings.error : session.detail
  default:
    return session.detail.isEmpty ? strings.running : session.detail
  }
}

func sourceLabel(for agentKind: String) -> String {
  let lower = agentKind.lowercased()
  if lower.contains("codex") { return "Codex" }
  if lower.contains("claude") { return "Claude" }
  return agentKind.isEmpty ? "Agent" : agentKind
}

func elapsedLabel(startedAt: Double, updatedAt: Double) -> String {
  let elapsedMs = max(0, updatedAt - startedAt)
  let seconds = Int(elapsedMs / 1000)
  if seconds < 60 { return "\(max(1, seconds))s" }
  let minutes = seconds / 60
  if minutes < 60 { return "\(minutes)m" }
  return "\(minutes / 60)h"
}

func compactText(_ text: String) -> String {
  text
    .components(separatedBy: .newlines)
    .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
    .filter { !$0.isEmpty }
    .joined(separator: " ")
}

struct StatusDot: View {
  let session: AgentIslandSession
  let compact: Bool
  var showsRunningAnimation = true
  var mascotSkin = defaultAgentIslandMascotSkin
  var runningMascotNamespace: Namespace.ID?

  var body: some View {
    let accent = statusAccentColor(for: session)
    ZStack {
      if usesExpandedVendorStatusIcon {
        AgentIslandSessionVendorIcon(
          session: session,
          running: isRunningSession(session),
          highlighted: session.phase == "completed" && session.attention
        )
      } else if let mascotState = mascotAnimationState(for: session), showsRunningAnimation {
        if let runningMascotNamespace {
          RunningMascotIcon(
            skin: mascotSkin,
            state: mascotState,
            size: compact ? 18 : 20,
            namespace: runningMascotNamespace
          )
        } else {
          AgentIslandMascotView(skin: mascotSkin, state: mascotState, size: compact ? 18 : 20)
            .frame(width: compact ? 18 : 20, height: compact ? 18 : 20)
        }
      } else {
        Circle().fill(accent.opacity(session.phase == "completed" ? 0.08 : 0.13))
        icon
          .foregroundColor(accent.opacity(session.phase == "completed" ? 0.78 : 0.96))
      }
    }
    .frame(width: compact ? 18 : 20, height: compact ? 18 : 20)
  }

  private var usesExpandedVendorStatusIcon: Bool {
    !compact && showsRunningAnimation && isRunningSession(session)
  }


  @ViewBuilder
  private var icon: some View {
    switch session.phase {
    case "needs-interaction":
      Image(systemName: "questionmark.bubble")
        .font(.system(size: 11, weight: .semibold))
    case "completed":
      Image(systemName: "checkmark")
        .font(.system(size: 11, weight: .semibold))
    case "error":
      Image(systemName: "exclamationmark.triangle")
        .font(.system(size: 10, weight: .semibold))
    default:
      EmptyView()
    }
  }
}

enum AgentIslandSessionVendor {
  case cc
  case codex
}

func agentIslandSessionVendor(for session: AgentIslandSession) -> AgentIslandSessionVendor {
  session.agentKind.lowercased().contains("codex") ? .codex : .cc
}

final class AgentIslandVendorMarkImageStore {
  static let shared = AgentIslandVendorMarkImageStore()

  private var cache: [AgentIslandSessionVendor: NSImage] = [:]

  func image(for vendor: AgentIslandSessionVendor) -> NSImage? {
    if let cached = cache[vendor] { return cached }
    let svg = vendor == .codex ? agentIslandCodexMarkSVG : agentIslandClaudeMarkSVG
    guard let data = svg.data(using: .utf8), let image = NSImage(data: data) else {
      return nil
    }
    image.isTemplate = true
    cache[vendor] = image
    return image
  }
}

struct AgentIslandSessionVendorIcon: View {
  let session: AgentIslandSession
  let running: Bool
  let highlighted: Bool
  @State private var isBreathing = false
  @Environment(\.agentIslandMascotAnimationsActive) private var animationsActive

  private var vendor: AgentIslandSessionVendor {
    agentIslandSessionVendor(for: session)
  }

  private var markSize: CGFloat {
    vendor == .codex ? 12 : 13
  }

  var body: some View {
    Group {
      if let image = AgentIslandVendorMarkImageStore.shared.image(for: vendor) {
        Image(nsImage: image)
          .resizable()
          .renderingMode(.template)
          .aspectRatio(contentMode: .fit)
      } else {
        fallbackIcon
      }
    }
    .frame(width: markSize, height: markSize)
    // running = 橙(在干活);highlighted(completed 未读)= 绿 —— 橙专职 running,
    // 完成未读全端统一走绿(与 app 侧 AttentionDot 'done' 同语义)。
    .foregroundColor(running ? agentIslandOrange : highlighted ? agentIslandUnreadGreen : Color.white.opacity(0.52))
    .opacity(running && animationsActive ? (isBreathing ? 1.0 : 0.3) : 1.0)
    .animation(
      running && animationsActive ? .easeInOut(duration: 0.75).repeatForever(autoreverses: true) : .default,
      value: isBreathing
    )
    .onAppear {
      guard running && animationsActive else { return }
      isBreathing = true
    }
    .onChange(of: animationsActive) { _, active in
      isBreathing = running && active
    }
    .onChange(of: running) { _, isRunning in
      isBreathing = isRunning && animationsActive
    }
    .frame(width: 20, height: 20)
  }

  @ViewBuilder
  private var fallbackIcon: some View {
    if vendor == .codex {
      Circle()
        .stroke(lineWidth: 1.4)
    } else {
      Text("XD")
        .font(.system(size: 8.5, weight: .bold, design: .rounded))
    }
  }
}

struct RunningMascotIcon: View {
  let skin: String
  let state: AgentIslandMascotAnimationState
  let size: CGFloat
  let namespace: Namespace.ID

  var body: some View {
    AgentIslandMascotView(skin: skin, state: state, size: size)
      .frame(width: size, height: size)
      .matchedGeometryEffect(id: agentIslandRunningMascotGeometryId, in: namespace)
  }
}

struct AgentIslandMascotView: View {
  let skin: String
  let state: AgentIslandMascotAnimationState
  let size: CGFloat

  var body: some View {
    if let config = AgentIslandMascotCatalog.spriteConfig(for: skin) {
      SpriteMascotView(size: size, state: state, config: config)
    } else {
      PululuMascotView(size: size, state: state)
    }
  }
}

private func mascotAnimationState(for session: AgentIslandSession) -> AgentIslandMascotAnimationState? {
  switch session.phase {
  case "needs-interaction":
    return .waitingApproval
  case "completed":
    return .completed
  case "error":
    return nil
  default:
    return .working
  }
}

func isRunningSession(_ session: AgentIslandSession) -> Bool {
  switch session.phase {
  case "needs-interaction", "completed", "error":
    return false
  default:
    return true
  }
}

struct RunningAgentGifIcon: View {
  let size: CGFloat

  var body: some View {
    RunningAgentGifImageView()
      .allowsHitTesting(false)
      .frame(width: size, height: size)
  }
}

struct RunningAgentGifImageView: NSViewRepresentable {
  func makeNSView(context: Context) -> RunningAgentGifContainerView {
    let view = RunningAgentGifContainerView()
    view.setImage(AgentIslandAssets.runningAgentGifImage)
    return view
  }

  func updateNSView(_ view: RunningAgentGifContainerView, context: Context) {
    view.setImage(AgentIslandAssets.runningAgentGifImage)
  }
}

final class RunningAgentGifContainerView: NSView {
  private let imageView = NSImageView()

  override init(frame frameRect: NSRect) {
    super.init(frame: frameRect)
    wantsLayer = true
    layer?.masksToBounds = true
    imageView.imageAlignment = .alignCenter
    imageView.imageFrameStyle = .none
    imageView.imageScaling = .scaleProportionallyUpOrDown
    imageView.animates = true
    imageView.frame = bounds
    imageView.autoresizingMask = [.width, .height]
    addSubview(imageView)
  }

  required init?(coder: NSCoder) {
    fatalError("init(coder:) has not been implemented")
  }

  override var intrinsicContentSize: NSSize {
    NSSize(width: NSView.noIntrinsicMetric, height: NSView.noIntrinsicMetric)
  }

  override func layout() {
    super.layout()
    imageView.frame = bounds
    layer?.cornerRadius = min(bounds.width, bounds.height) / 2
  }

  func setImage(_ image: NSImage?) {
    imageView.imageScaling = .scaleProportionallyUpOrDown
    imageView.animates = true
    if imageView.image !== image {
      imageView.image = image
    }
  }
}


struct TrackingLayer: NSViewRepresentable {
  let layout: AgentIslandLayout
  let state: AgentIslandDisplayState
  let dragActive: Bool
  let dragMode: String?
  let onHover: (Bool, Bool) -> Void

  func makeNSView(context: Context) -> TrackingView {
    let view = TrackingView()
    view.layout = layout
    view.state = state
    view.dragActive = dragActive
    view.dragMode = dragMode
    view.onHover = onHover
    return view
  }

  func updateNSView(_ nsView: TrackingView, context: Context) {
    nsView.layout = layout
    nsView.state = state
    nsView.dragActive = dragActive
    nsView.dragMode = dragMode
    nsView.onHover = onHover
    nsView.window?.invalidateCursorRects(for: nsView)
  }
}

final class TrackingView: NSView {
  var layout = AgentIslandLayout.compute(
    state: .empty,
    availableFrameWidth: 680,
    locallyHovered: false,
    notchBaselineHeight: 24,
    screenMetrics: .fallback
  )
  var state = AgentIslandDisplayState.empty
  var dragActive = false
  var dragMode: String?
  var onHover: ((Bool, Bool) -> Void)?
  private var lastMenuBar = false
  private var lastPanel = false

  override var isFlipped: Bool { true }

  override func hitTest(_ point: NSPoint) -> NSView? {
    guard state.visible, isResizable else {
      return nil
    }
    if dragActive {
      return self
    }
    if isResizeHit(point, edge: .left) || isResizeHit(point, edge: .right) {
      return self
    }
    return nil
  }

  override func acceptsFirstMouse(for event: NSEvent?) -> Bool {
    true
  }

  override func resetCursorRects() {
    super.resetCursorRects()
    guard state.visible, isResizable else {
      return
    }
    if dragActive, let cursor = cursorForDragMode() {
      addCursorRect(bounds, cursor: cursor)
      return
    }
    for rect in resizeHitRects(edge: .left) {
      addCursorRect(rect, cursor: agentIslandFrameResizeCursor(edge: .left))
    }
    for rect in resizeHitRects(edge: .right) {
      addCursorRect(rect, cursor: agentIslandFrameResizeCursor(edge: .right))
    }
  }

  override func cursorUpdate(with event: NSEvent) {
    if dragActive, let cursor = cursorForDragMode() {
      cursor.set()
      return
    }
    let point = convert(event.locationInWindow, from: nil)
    if isResizeHit(point, edge: .left) {
      agentIslandFrameResizeCursor(edge: .left).set()
      return
    }
    if isResizeHit(point, edge: .right) {
      agentIslandFrameResizeCursor(edge: .right).set()
      return
    }
    super.cursorUpdate(with: event)
  }

  private func cursorForDragMode() -> NSCursor? {
    switch dragMode {
    case "move":
      return nil
    case "resize-left":
      return agentIslandFrameResizeCursor(edge: .left)
    case "resize-right":
      return agentIslandFrameResizeCursor(edge: .right)
    default:
      return nil
    }
  }

  override func updateTrackingAreas() {
    super.updateTrackingAreas()
    for area in trackingAreas {
      removeTrackingArea(area)
    }
    let area = NSTrackingArea(
      rect: bounds,
      options: [.activeAlways, .inVisibleRect, .mouseEnteredAndExited, .mouseMoved, .cursorUpdate],
      owner: self,
      userInfo: nil
    )
    addTrackingArea(area)
  }

  override func viewDidMoveToWindow() {
    super.viewDidMoveToWindow()
    window?.acceptsMouseMovedEvents = true
  }

  override func mouseMoved(with event: NSEvent) {
    updateHover(with: event)
  }

  override func mouseEntered(with event: NSEvent) {
    updateHover(with: event)
  }

  override func mouseExited(with event: NSEvent) {
    emitHover(menuBar: false, panel: false)
  }

  private func updateHover(with event: NSEvent) {
    let point = convert(event.locationInWindow, from: nil)
    if isResizable && (isResizeHit(point, edge: .left) || isResizeHit(point, edge: .right)) {
      emitHover(menuBar: false, panel: layout.expanded)
      return
    }
    let rect = visualRect()
    let insideVisualIsland = point.x >= rect.minX
      && point.x <= rect.maxX
      && point.y >= 0
      && point.y <= layout.height
    if !insideVisualIsland {
      emitHover(menuBar: false, panel: false)
      return
    }
    if layout.expanded {
      emitHover(menuBar: point.y <= layout.menuBarZoneHeight, panel: point.y > layout.menuBarZoneHeight)
      return
    }
    emitHover(menuBar: true, panel: false)
  }

  private func emitHover(menuBar: Bool, panel: Bool) {
    if menuBar == lastMenuBar && panel == lastPanel {
      return
    }
    lastMenuBar = menuBar
    lastPanel = panel
    onHover?(menuBar, panel)
  }

  private func visualRect() -> CGRect {
    let originX = (bounds.width - layout.width) / 2
    return CGRect(
      x: originX - layout.topExtension,
      y: 0,
      width: layout.width + layout.topExtension * 2,
      height: layout.height
    )
  }

  private func isResizeHit(_ point: NSPoint, edge: AgentIslandResizeEdge) -> Bool {
    resizeHitRects(edge: edge).contains { $0.contains(point) }
  }

  private func resizeHitRects(edge: AgentIslandResizeEdge) -> [CGRect] {
    let rect = visualRect()
    if !layout.expanded {
      return [resizeHitRect(edge: edge, rect: rect, innerWidth: compactIslandResizeHitWidth, y: 0, height: rect.height)]
    }
    let topHeight = min(rect.height, max(0, layout.menuBarZoneHeight))
    let panelHeight = max(0, rect.height - topHeight)
    var rects: [CGRect] = []
    if topHeight > 0 {
      rects.append(
        resizeHitRect(edge: edge, rect: rect, innerWidth: expandedIslandTopResizeInnerHitWidth, y: 0, height: topHeight)
      )
    }
    if panelHeight > 0 {
      rects.append(
        resizeHitRect(
          edge: edge,
          rect: rect,
          innerWidth: expandedIslandPanelResizeInnerHitWidth,
          y: topHeight,
          height: panelHeight
        )
      )
    }
    return rects
  }

  private func resizeHitRect(
    edge: AgentIslandResizeEdge,
    rect: CGRect,
    innerWidth: CGFloat,
    y: CGFloat,
    height: CGFloat
  ) -> CGRect {
    switch edge {
    case .left:
      return CGRect(
        x: rect.minX - expandedIslandResizeOuterHitWidth,
        y: y,
        width: innerWidth + expandedIslandResizeOuterHitWidth,
        height: height
      )
    case .right:
      return CGRect(
        x: rect.maxX - innerWidth,
        y: y,
        width: innerWidth + expandedIslandResizeOuterHitWidth,
        height: height
      )
    }
  }

  private func moveHitRect() -> CGRect {
    let rect = visualRect()
    if layout.expanded {
      let minX = rect.minX + expandedIslandTopResizeInnerHitWidth
      let maxX = rect.maxX - expandedIslandTopResizeInnerHitWidth
      return CGRect(
        x: minX,
        y: 0,
        width: max(0, maxX - minX),
        height: layout.menuBarZoneHeight
      )
    }
    return CGRect(
      x: rect.minX + compactIslandResizeHitWidth,
      y: 0,
      width: max(0, rect.width - compactIslandResizeHitWidth * 2),
      height: rect.height
    )
  }

  private var isResizable: Bool {
    state.visible && layout.width > 0
  }
}

final class AgentIslandPanel: NSPanel {
  // Agent Island is ambient UI. Showing it, hovering resize affordances, or
  // interacting with pointer-only controls must never take keyboard focus
  // from the user's current app.
  override var canBecomeKey: Bool { false }
  override var canBecomeMain: Bool { false }
}

private final class AgentIslandContentRootView: NSView {
  override func acceptsFirstMouse(for event: NSEvent?) -> Bool {
    true
  }
}

private final class AgentIslandHostingView<Content: View>: NSHostingView<Content> {
  override func acceptsFirstMouse(for event: NSEvent?) -> Bool {
    true
  }
}

final class AgentIslandController {
  private enum PanelDragMode {
    case move
    case resizeLeft
    case resizeRight

    var eventName: String {
      switch self {
      case .move:
        return "move"
      case .resizeLeft:
        return "resize-left"
      case .resizeRight:
        return "resize-right"
      }
    }
  }

  private enum PanelCursorKind: Equatable {
    case system
    case frameResizeLeft
    case frameResizeRight

    var cursor: NSCursor {
      switch self {
      case .frameResizeLeft:
        return agentIslandFrameResizeCursor(edge: .left)
      case .frameResizeRight:
        return agentIslandFrameResizeCursor(edge: .right)
      case .system:
        return NSCursor.arrow
      }
    }

    func set() {
      cursor.set()
    }
  }

  private enum PanelPointerHit: Equatable {
    case resizeLeft
    case resizeRight
    case menuBar
    case panel
    case outside

    var resizeMode: PanelDragMode? {
      switch self {
      case .resizeLeft:
        return .resizeLeft
      case .resizeRight:
        return .resizeRight
      default:
        return nil
      }
    }
  }

  private enum CompactWidthSnapMode: Equatable {
    case free
    case hidden
    case basic
  }

  private struct PanelDragInteraction {
    let mode: PanelDragMode
    let startMouseX: CGFloat
    let startMouseY: CGFloat
    let startFrame: NSRect
    let startLayout: AgentIslandLayout
    let startContentWidth: CGFloat
  }

  private let model = AgentIslandModel()
  private let panel: AgentIslandPanel
  private let contentRoot = AgentIslandContentRootView()
  private let eventSink: ([String: Any]) -> Void
  private let containsAnyPanel: (NSPoint) -> Bool
  private var lastCarrierFrame: AgentIslandCarrierFrame?
  private var lastCocoaFrame: NSRect?
  private var lastLayout = AgentIslandLayout.compute(
    state: .empty,
    availableFrameWidth: 680,
    locallyHovered: false,
    notchBaselineHeight: 24,
    screenMetrics: .fallback
  )
  private var globalClickMonitor: Any?
  private var localClickMonitor: Any?
  private var globalMoveMonitor: Any?
  private var localMoveMonitor: Any?
  private var globalMouseUpMonitor: Any?
  private var localMouseUpMonitor: Any?
  private var screenParameterObserver: NSObjectProtocol?
  private var activeSpaceObserver: NSObjectProtocol?
  private var activeApplicationObserver: NSObjectProtocol?
  private var screenMetricsTimer: Timer?
  private var dragInteraction: PanelDragInteraction?
  private var pendingMoveInteraction: PanelDragInteraction?
  private var lastMoveTime: TimeInterval = 0
  private var lastLayoutEmitTime: TimeInterval = 0
  private var lastMenuBarHover = false
  private var lastPanelHover = false
  private var interactionPollTimer: Timer?
  private var pendingCarrierFrameTimer: Timer?
  private var pendingCarrierFrame: NSRect?
  private var deferredInteractionUpdate: (state: AgentIslandDisplayState, frame: AgentIslandCarrierFrame)?
  private var lastPollLeftMouseDown = false
  private var activeCursorKind: PanelCursorKind = .system
  private var pushedCursorKind: PanelCursorKind?
  private var lastDragDebugTime: TimeInterval = 0
  private var lastInteractiveSnapMode: CompactWidthSnapMode = .free
  private var snapAnimationGeneration = 0
  private var activeSnapAnimationTargetFrame: NSRect?

  init(
    eventSink: @escaping ([String: Any]) -> Void = emitJson,
    containsAnyPanel: @escaping (NSPoint) -> Bool = { _ in false }
  ) {
    self.eventSink = eventSink
    self.containsAnyPanel = containsAnyPanel
    panel = AgentIslandPanel(
      contentRect: NSRect(x: 0, y: 0, width: 680, height: 54),
      styleMask: [.borderless, .nonactivatingPanel],
      backing: .buffered,
      defer: false
    )
    panel.isOpaque = false
    panel.backgroundColor = .clear
    panel.hasShadow = false
    panel.level = NSWindow.Level(rawValue: Int(CGWindowLevelForKey(.statusWindow)) + 2)
    panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
    panel.isReleasedWhenClosed = false
    panel.hidesOnDeactivate = false
    panel.acceptsMouseMovedEvents = true
    contentRoot.frame = NSRect(x: 0, y: 0, width: 680, height: 54)
    let hostingView = AgentIslandHostingView(rootView: AgentIslandRootView(model: model, eventSink: eventSink))
    hostingView.frame = contentRoot.bounds
    hostingView.autoresizingMask = [.width, .height]
    contentRoot.addSubview(hostingView)
    panel.contentView = contentRoot
    installEventMonitors()
  }

  deinit {
    close()
  }

  func close() {
    cancelPendingCarrierFrame()
    stopInteractionPoller()
    stopGlobalMoveMonitor()
    deferredInteractionUpdate = nil
    model.mascotAnimationsActive = false
    emitHover(menuBar: false, panel: false)
    panel.orderOut(nil)
    removeEventMonitors()
  }

  func contains(screenPoint: NSPoint) -> Bool {
    hitTestInteraction(screenPoint: screenPoint) != .outside
  }

  func apply(state: AgentIslandDisplayState, frame: AgentIslandCarrierFrame) {
    lastCarrierFrame = frame
    let screen = screenForFrame(frame)
    let screenMetrics = AgentIslandScreenMetricsProvider.metrics(for: screen)
    let notchBaselineHeight = CGFloat(screenMetrics.topBarHeight)
    let preferredContentWidth = frame.contentWidth.map { CGFloat($0) }
    let hardwareNotchLayoutEnabled = isHardwareNotchLayoutEnabled(
      frame: convertToCocoaFrame(frame, screen: screen, carrierHeight: CGFloat(frame.height)),
      expanded: state.mode == "expanded",
      screenMetrics: screenMetrics,
      screen: screen
    )
    let layout = AgentIslandLayout.compute(
      state: state,
      availableFrameWidth: CGFloat(frame.width),
      locallyHovered: model.locallyHovered,
      notchBaselineHeight: notchBaselineHeight,
      screenMetrics: screenMetrics,
      hardwareNotchLayoutEnabled: hardwareNotchLayoutEnabled,
      preferredContentWidth: preferredContentWidth
    )
    let cocoaFrame = convertToCocoaFrame(
      frame,
      screen: screen,
      carrierHeight: ceil(layout.height + layout.carrierInset)
    )
    emitFrameDebug(
      event: "apply-frame",
      previousState: model.state,
      nextState: state,
      incomingFrame: frame,
      cocoaFrame: cocoaFrame,
      layout: layout,
      panelFrame: panel.frame
    )
    if let interaction = pendingMoveInteraction {
      deferredInteractionUpdate = (state, frame)
      cancelPendingCarrierFrame()
      emitDragDebug(
        event: "apply-during-pending-move",
        interaction: interaction,
        frame: panel.frame,
        contentWidth: currentContentWidth(frame: panel.frame, layout: lastLayout),
        screenPoint: nil,
        force: true
      )
      return
    }
    if let interaction = dragInteraction {
      deferredInteractionUpdate = (state, frame)
      cancelPendingCarrierFrame()
      emitDragDebug(
        event: "apply-during-drag",
        interaction: interaction,
        frame: panel.frame,
        contentWidth: currentContentWidth(frame: panel.frame, layout: lastLayout),
        screenPoint: nil,
        force: true
      )
      return
    }
    lastLayout = layout
    if state.mode == "expanded" {
      cancelPendingCarrierFrame()
    }
    let shouldResizeCarrierBeforeState = state.mode == "expanded" && lastCocoaFrame != cocoaFrame
    let shouldDelayCarrierShrink = state.visible
      && model.state.mode == "expanded"
      && state.mode != "expanded"
      && lastCocoaFrame != cocoaFrame
    if shouldResizeCarrierBeforeState {
      setPanelFrame(cocoaFrame, animated: lastCocoaFrame != nil)
      lastCocoaFrame = cocoaFrame
    }
    let nextMascotAnimationsActive = state.visible
    let shouldRestartMascotAnimations = nextMascotAnimationsActive && !model.mascotAnimationsActive
    withAnimation(agentIslandOpenAnimation) {
      model.carrierWidth = CGFloat(frame.width)
      model.preferredContentWidth = preferredContentWidth
      model.notchBaselineHeight = notchBaselineHeight
      model.screenMetrics = screenMetrics
      model.hardwareNotchLayoutEnabled = hardwareNotchLayoutEnabled
      model.mascotAnimationsActive = nextMascotAnimationsActive
      if shouldRestartMascotAnimations {
        model.mascotAnimationEpoch += 1
      }
      model.state = state
    }
    if shouldDelayCarrierShrink {
      scheduleCarrierFrame(cocoaFrame, after: agentIslandCarrierShrinkDelay)
    } else if !shouldResizeCarrierBeforeState
      && lastCocoaFrame != cocoaFrame
      && pendingCarrierFrame != cocoaFrame
    {
      cancelPendingCarrierFrame()
      setPanelFrame(cocoaFrame, animated: lastCocoaFrame != nil)
      lastCocoaFrame = cocoaFrame
    }
    if state.visible {
      panel.orderFrontRegardless()
      handleMouseMoved(screenPoint: NSEvent.mouseLocation, force: true)
      refreshInteractionPoller()
    } else {
      stopInteractionPoller()
      stopGlobalMoveMonitor()
      emitHover(menuBar: false, panel: false)
      panel.orderOut(nil)
    }
  }

  private func installEventMonitors() {
    let clickMask: NSEvent.EventTypeMask = [.leftMouseDown, .rightMouseDown, .otherMouseDown]
    globalClickMonitor = NSEvent.addGlobalMonitorForEvents(matching: clickMask) { [weak self] event in
      DispatchQueue.main.async {
        self?.handleGlobalMouseDown(event: event)
      }
    }
    localClickMonitor = NSEvent.addLocalMonitorForEvents(matching: clickMask) { [weak self] event in
      self?.handleMouseDown(event: event)
      if self?.dragInteraction != nil {
        return nil
      }
      return event
    }

    refreshGlobalMoveMonitor()
    let moveMask: NSEvent.EventTypeMask = [.mouseMoved, .leftMouseDragged, .rightMouseDragged, .otherMouseDragged]
    localMoveMonitor = NSEvent.addLocalMonitorForEvents(matching: moveMask) { [weak self] event in
      self?.handleMouseEvent(event)
      if self?.dragInteraction != nil {
        return nil
      }
      return event
    }

    let mouseUpMask: NSEvent.EventTypeMask = [.leftMouseUp]
    globalMouseUpMonitor = NSEvent.addGlobalMonitorForEvents(matching: mouseUpMask) { [weak self] event in
      DispatchQueue.main.async {
        self?.handleMouseUp(event: event)
      }
    }
    localMouseUpMonitor = NSEvent.addLocalMonitorForEvents(matching: mouseUpMask) { [weak self] event in
      self?.handleMouseUp(event: event)
      return event
    }

    screenParameterObserver = NotificationCenter.default.addObserver(
      forName: NSApplication.didChangeScreenParametersNotification,
      object: nil,
      queue: .main
    ) { [weak self] _ in
      self?.scheduleScreenMetricsPublish()
    }
    activeSpaceObserver = NSWorkspace.shared.notificationCenter.addObserver(
      forName: NSWorkspace.activeSpaceDidChangeNotification,
      object: nil,
      queue: .main
    ) { [weak self] _ in
      self?.scheduleScreenMetricsPublish()
    }
    activeApplicationObserver = NSWorkspace.shared.notificationCenter.addObserver(
      forName: NSWorkspace.didActivateApplicationNotification,
      object: nil,
      queue: .main
    ) { [weak self] _ in
      self?.scheduleScreenMetricsPublish()
    }
  }

  private func removeEventMonitors() {
    for monitor in [
      globalClickMonitor,
      localClickMonitor,
      globalMoveMonitor,
      localMoveMonitor,
      globalMouseUpMonitor,
      localMouseUpMonitor,
    ] {
      if let monitor {
        NSEvent.removeMonitor(monitor)
      }
    }
    globalClickMonitor = nil
    localClickMonitor = nil
    globalMoveMonitor = nil
    localMoveMonitor = nil
    globalMouseUpMonitor = nil
    localMouseUpMonitor = nil
    if let screenParameterObserver {
      NotificationCenter.default.removeObserver(screenParameterObserver)
    }
    if let activeSpaceObserver {
      NSWorkspace.shared.notificationCenter.removeObserver(activeSpaceObserver)
    }
    if let activeApplicationObserver {
      NSWorkspace.shared.notificationCenter.removeObserver(activeApplicationObserver)
    }
    screenParameterObserver = nil
    activeSpaceObserver = nil
    activeApplicationObserver = nil
    screenMetricsTimer?.invalidate()
    screenMetricsTimer = nil
  }

  private func refreshGlobalMoveMonitor() {
    if shouldRunGlobalMoveMonitor() {
      startGlobalMoveMonitor()
    } else {
      stopGlobalMoveMonitor()
    }
  }

  private func startGlobalMoveMonitor() {
    if globalMoveMonitor != nil {
      return
    }
    let moveMask: NSEvent.EventTypeMask = [.mouseMoved, .leftMouseDragged, .rightMouseDragged, .otherMouseDragged]
    globalMoveMonitor = NSEvent.addGlobalMonitorForEvents(matching: moveMask) { [weak self] event in
      DispatchQueue.main.async {
        self?.handleMouseEvent(event)
      }
    }
  }

  private func stopGlobalMoveMonitor() {
    if let globalMoveMonitor {
      NSEvent.removeMonitor(globalMoveMonitor)
      self.globalMoveMonitor = nil
    }
  }

  private func shouldRunGlobalMoveMonitor() -> Bool {
    if dragInteraction != nil || pendingMoveInteraction != nil {
      return true
    }
    guard model.state.visible, panel.isVisible else {
      return false
    }
    return true
  }

  func publishScreenMetrics() {
    var payload: [String: Any] = [
      "type": "screen-metrics",
      "screens": AgentIslandScreenMetricsProvider.allMetrics().map { $0.dictionary },
    ]
    if let preferredDisplayId = AgentIslandScreenMetricsProvider.preferredDisplayId() {
      payload["preferredDisplayId"] = preferredDisplayId
    }
    eventSink(payload)
  }

  private func scheduleScreenMetricsPublish() {
    screenMetricsTimer?.invalidate()
    screenMetricsTimer = Timer.scheduledTimer(withTimeInterval: 0.2, repeats: false) { [weak self] _ in
      self?.screenMetricsTimer = nil
      self?.publishScreenMetrics()
    }
    RunLoop.main.add(screenMetricsTimer!, forMode: .common)
  }

  private func startInteractionPoller() {
    if interactionPollTimer != nil {
      return
    }
    interactionPollTimer = Timer.scheduledTimer(withTimeInterval: 1.0 / 60.0, repeats: true) { [weak self] _ in
      self?.pollPointerInteraction()
    }
    RunLoop.main.add(interactionPollTimer!, forMode: .common)
  }

  private func refreshInteractionPoller() {
    refreshGlobalMoveMonitor()
    if shouldRunInteractionPoller() {
      startInteractionPoller()
    } else {
      stopInteractionPoller(resetCursor: false)
    }
  }

  private func shouldRunInteractionPoller() -> Bool {
    dragInteraction != nil || pendingMoveInteraction != nil
  }

  private func stopInteractionPoller(resetCursor: Bool = true) {
    interactionPollTimer?.invalidate()
    interactionPollTimer = nil
    lastPollLeftMouseDown = false
    guard resetCursor else {
      return
    }
    popPushedCursor()
    if activeCursorKind != .system {
      PanelCursorKind.system.set()
      activeCursorKind = .system
    }
  }

  private func pollPointerInteraction() {
    guard model.state.visible, panel.isVisible else {
      return
    }

    let screenPoint = NSEvent.mouseLocation
    let leftMouseDown = (NSEvent.pressedMouseButtons & 1) == 1

    if dragInteraction != nil {
      updateCursor(for: .outside, screenPoint: screenPoint)
      if leftMouseDown {
        continueDrag(screenPoint: screenPoint)
      } else {
        finishDrag(screenPoint: screenPoint)
      }
      lastPollLeftMouseDown = leftMouseDown
      return
    }

    if let pendingMoveInteraction {
      if leftMouseDown {
        if shouldPromotePendingMove(interaction: pendingMoveInteraction, screenPoint: screenPoint) {
          activateDragInteraction(pendingMoveInteraction, screenPoint: screenPoint)
          continueDrag(screenPoint: screenPoint, interaction: pendingMoveInteraction)
        }
      } else {
        finishPendingMove(screenPoint: screenPoint)
      }
      lastPollLeftMouseDown = leftMouseDown
      return
    }

    let hit = hitTestInteraction(screenPoint: screenPoint)
    updateCursor(for: hit, screenPoint: screenPoint)

    let now = ProcessInfo.processInfo.systemUptime
    if now - lastMoveTime >= 0.016 {
      lastMoveTime = now
      if let zones = hoverZones(for: hit) {
        emitHover(menuBar: zones.menuBar, panel: zones.panel)
      } else {
        emitHover(menuBar: false, panel: false)
      }
    }
    lastPollLeftMouseDown = leftMouseDown
  }

  private func handleGlobalMouseDown(event: NSEvent) {
    let screenPoint = NSEvent.mouseLocation
    if dragInteraction != nil {
      handleMouseMoved(screenPoint: screenPoint, force: true)
      return
    }

    let hit = hitTestInteraction(screenPoint: screenPoint)
    if hit == .outside {
      guard model.state.visible, panel.isVisible else {
        return
      }
      if !containsAnyPanel(screenPoint) {
        eventSink(["type": "outside-click"])
      }
      emitHover(menuBar: false, panel: false)
      return
    }

    handleMouseMoved(screenPoint: screenPoint, hit: hit, force: true)
    if event.type == .leftMouseDown {
      _ = beginDragInteraction(screenPoint: screenPoint, hit: hit)
    }
  }

  private func handleMouseEvent(_ event: NSEvent) {
    if event.type == .leftMouseDragged {
      handleMouseDragged(event: event)
      return
    }
    handleMouseMoved(screenPoint: NSEvent.mouseLocation)
  }

  private func handleMouseDown(event: NSEvent) {
    let screenPoint = NSEvent.mouseLocation
    if dragInteraction != nil {
      handleMouseMoved(screenPoint: screenPoint, force: true)
      return
    }

    let hit = hitTestInteraction(screenPoint: screenPoint)
    if hit == .outside {
      guard model.state.visible, panel.isVisible else {
        return
      }
      if !containsAnyPanel(screenPoint) {
        eventSink(["type": "outside-click"])
      }
      emitHover(menuBar: false, panel: false)
      return
    }
    if event.type == .leftMouseDown {
      _ = beginDragInteraction(screenPoint: screenPoint, hit: hit)
    }
    handleMouseMoved(screenPoint: screenPoint, hit: hit, force: true)
  }

  private func handleMouseDragged(event: NSEvent) {
    if let pendingMoveInteraction {
      let screenPoint = NSEvent.mouseLocation
      if shouldPromotePendingMove(interaction: pendingMoveInteraction, screenPoint: screenPoint) {
        activateDragInteraction(pendingMoveInteraction, screenPoint: screenPoint)
        continueDrag(screenPoint: screenPoint, interaction: pendingMoveInteraction)
      } else {
        handleMouseMoved(screenPoint: screenPoint)
      }
      return
    }
    guard let interaction = dragInteraction else {
      handleMouseMoved(screenPoint: NSEvent.mouseLocation)
      return
    }
    continueDrag(screenPoint: NSEvent.mouseLocation, interaction: interaction)
  }

  private func continueDrag(screenPoint: NSPoint) {
    guard let interaction = dragInteraction else {
      handleMouseMoved(screenPoint: screenPoint)
      return
    }
    continueDrag(screenPoint: screenPoint, interaction: interaction)
  }

  private func continueDrag(screenPoint: NSPoint, interaction: PanelDragInteraction) {
    pushDragCursor(for: interaction)
    let nextFrame: NSRect
    let contentWidth: CGFloat
    switch interaction.mode {
    case .move:
      var frame = interaction.startFrame
      let desiredCenter = interaction.startFrame.midX + screenPoint.x - interaction.startMouseX
      let tentativeCenter = snappedConstrainedCenterX(
        desiredCenter,
        contentWidth: interaction.startContentWidth
      )
      contentWidth = constrainedContentWidth(
        interaction.startContentWidth,
        expanded: interaction.startLayout.expanded,
        fixedCenterX: tentativeCenter
      )
      frame.size.width = contentWidth + interaction.startLayout.carrierInset * 2
      frame.origin.x = snappedConstrainedCenterX(desiredCenter, contentWidth: contentWidth) - frame.width / 2
      nextFrame = frame
    case .resizeRight:
      let delta = screenPoint.x - interaction.startMouseX
      contentWidth = constrainedContentWidth(
        interaction.startContentWidth + delta * 2,
        expanded: interaction.startLayout.expanded,
        fixedCenterX: interaction.startFrame.midX
      )
      nextFrame = centeredFrameForResize(
        contentWidth: contentWidth,
        inset: interaction.startLayout.carrierInset,
        startFrame: interaction.startFrame
      )
    case .resizeLeft:
      let delta = interaction.startMouseX - screenPoint.x
      contentWidth = constrainedContentWidth(
        interaction.startContentWidth + delta * 2,
        expanded: interaction.startLayout.expanded,
        fixedCenterX: interaction.startFrame.midX
      )
      nextFrame = centeredFrameForResize(
        contentWidth: contentWidth,
        inset: interaction.startLayout.carrierInset,
        startFrame: interaction.startFrame
      )
    }
    let nextSnapMode = compactWidthSnapMode(contentWidth: contentWidth, interaction: interaction)
    let shouldAnimateSnap = shouldAnimateCompactSnapTransition(
      from: lastInteractiveSnapMode,
      to: nextSnapMode
    )
    applyInteractiveFrame(nextFrame, animatedSnap: shouldAnimateSnap)
    lastInteractiveSnapMode = nextSnapMode
    emitDragDebug(
      event: "drag-sample",
      interaction: interaction,
      frame: nextFrame,
      contentWidth: contentWidth,
      screenPoint: screenPoint,
      force: false
    )
    emitLayoutPreference(
      frame: nextFrame,
      contentWidth: contentWidth,
      force: false,
      snapCenter: interaction.mode == .move
    )
  }

  private func handleMouseUp(event: NSEvent) {
    if pendingMoveInteraction != nil {
      finishPendingMove(screenPoint: NSEvent.mouseLocation)
      return
    }
    finishDrag(screenPoint: NSEvent.mouseLocation)
  }

  private func finishDrag(screenPoint: NSPoint) {
    guard let interaction = dragInteraction else {
      return
    }
    emitDragDebug(
      event: "drag-finish",
      interaction: interaction,
      frame: panel.frame,
      contentWidth: currentContentWidth(frame: panel.frame, layout: lastLayout),
      screenPoint: screenPoint,
      force: true
    )
    dragInteraction = nil
    model.layoutDragActive = false
    model.layoutDragMode = nil
    lastInteractiveSnapMode = .free
    popPushedCursor()
    eventSink(["type": "drag", "active": false])
    emitLayoutPreference(
      frame: panel.frame,
      contentWidth: currentContentWidth(frame: panel.frame, layout: lastLayout),
      force: true,
      snapCenter: interaction.mode == .move
    )
    handleMouseMoved(screenPoint: screenPoint, force: true)
    replayDeferredInteractionUpdateIfNeeded(preservingCurrentPanelFrame: true)
  }

  private func finishPendingMove(screenPoint: NSPoint) {
    guard let interaction = pendingMoveInteraction else {
      return
    }
    pendingMoveInteraction = nil
    if shouldTreatAsCompactClick(interaction: interaction, screenPoint: screenPoint) {
      eventSink(["type": "expand"])
    }
    handleMouseMoved(screenPoint: screenPoint, force: true)
    replayDeferredInteractionUpdateIfNeeded()
  }

  private func beginDragInteraction(screenPoint: NSPoint, hit: PanelPointerHit) -> Bool {
    guard dragInteraction == nil, pendingMoveInteraction == nil else {
      return false
    }
    guard let interaction = dragInteractionForMouseDown(screenPoint: screenPoint, hit: hit) else {
      return false
    }
    if interaction.mode == .move {
      pendingMoveInteraction = interaction
      deferredInteractionUpdate = nil
      emitHover(menuBar: false, panel: false)
      refreshInteractionPoller()
      lastDragDebugTime = 0
      return true
    }
    activateDragInteraction(interaction, screenPoint: screenPoint)
    return true
  }

  private func activateDragInteraction(_ interaction: PanelDragInteraction, screenPoint: NSPoint) {
    pendingMoveInteraction = nil
    dragInteraction = interaction
    model.layoutDragActive = true
    model.layoutDragMode = interaction.mode.eventName
    lastInteractiveSnapMode = compactWidthSnapMode(
      contentWidth: interaction.startContentWidth,
      interaction: interaction
    )
    cancelPendingCarrierFrame()
    pushDragCursor(for: interaction)
    refreshInteractionPoller()
    lastDragDebugTime = 0
    emitDragDebug(
      event: "drag-begin",
      interaction: interaction,
      frame: interaction.startFrame,
      contentWidth: interaction.startContentWidth,
      screenPoint: screenPoint,
      force: true
    )
    eventSink(["type": "drag", "active": true, "mode": interaction.mode.eventName])
  }

  private func emitDragDebug(
    event: String,
    interaction: PanelDragInteraction,
    frame: NSRect,
    contentWidth: CGFloat,
    screenPoint: NSPoint?,
    force: Bool
  ) {
    guard agentIslandDebugLoggingEnabled else {
      return
    }
    let now = ProcessInfo.processInfo.systemUptime
    if !force && now - lastDragDebugTime < 0.08 {
      return
    }
    lastDragDebugTime = now
    var payload: [String: Any] = [
      "type": "debug",
      "event": event,
      "mode": interaction.mode.eventName,
      "centerX": Double(frame.midX),
      "startCenterX": Double(interaction.startFrame.midX),
      "centerDelta": Double(frame.midX - interaction.startFrame.midX),
      "frameX": Double(frame.minX),
      "left": Double(frame.minX),
      "right": Double(frame.maxX),
      "width": Double(frame.width),
      "height": Double(frame.height),
      "contentWidth": Double(contentWidth),
    ]
    if let screenPoint {
      payload["x"] = Double(screenPoint.x)
      payload["y"] = Double(screenPoint.y)
    }
    eventSink(payload)
  }

  private func emitFrameDebug(
    event: String,
    previousState: AgentIslandDisplayState,
    nextState: AgentIslandDisplayState,
    incomingFrame: AgentIslandCarrierFrame,
    cocoaFrame: NSRect,
    layout: AgentIslandLayout,
    panelFrame: NSRect
  ) {
    guard agentIslandDebugLoggingEnabled else {
      return
    }
    let stateChanged = previousState.mode != nextState.mode
      || previousState.notchStatus != nextState.notchStatus
      || previousState.displayPolicy != nextState.displayPolicy
    let frameChanged = abs(panelFrame.midX - cocoaFrame.midX) >= 0.5
      || abs(panelFrame.width - cocoaFrame.width) >= 0.5
      || abs(panelFrame.height - cocoaFrame.height) >= 0.5
    guard stateChanged || frameChanged else {
      return
    }
    eventSink([
      "type": "debug",
      "event": event,
      "fromMode": previousState.mode,
      "toMode": nextState.mode,
      "fromNotchStatus": previousState.notchStatus,
      "toNotchStatus": nextState.notchStatus,
      "fromDisplayPolicy": previousState.displayPolicy,
      "toDisplayPolicy": nextState.displayPolicy,
      "incomingCenterX": Double(cocoaFrame.midX),
      "panelCenterX": Double(panelFrame.midX),
      "centerDelta": Double(cocoaFrame.midX - panelFrame.midX),
      "frameX": Double(cocoaFrame.minX),
      "width": Double(cocoaFrame.width),
      "height": Double(cocoaFrame.height),
      "layoutWidth": Double(layout.width),
      "carrierWidth": incomingFrame.width,
      "contentWidth": incomingFrame.contentWidth ?? -1,
      "panelFrameX": Double(panelFrame.minX),
      "panelWidth": Double(panelFrame.width),
    ])
  }

  private func dragInteractionForMouseDown(
    screenPoint: NSPoint,
    hit: PanelPointerHit? = nil
  ) -> PanelDragInteraction? {
    guard model.state.visible, panel.isVisible else {
      return nil
    }
    let frame = panel.frame
    let resolvedHit = hit ?? hitTestInteraction(screenPoint: screenPoint)
    if let resizeMode = resolvedHit.resizeMode {
      let contentWidth = constrainedContentWidth(lastLayout.width, expanded: lastLayout.expanded)
      return PanelDragInteraction(
        mode: resizeMode,
        startMouseX: screenPoint.x,
        startMouseY: screenPoint.y,
        startFrame: frame,
        startLayout: lastLayout,
        startContentWidth: contentWidth
      )
    }
    guard resolvedHit == .menuBar else {
      return nil
    }
    let contentWidth = currentContentWidth(frame: frame, layout: lastLayout)
    return PanelDragInteraction(
      mode: .move,
      startMouseX: screenPoint.x,
      startMouseY: screenPoint.y,
      startFrame: frame,
      startLayout: lastLayout,
      startContentWidth: contentWidth
    )
  }

  private func shouldTreatAsCompactClick(interaction: PanelDragInteraction, screenPoint: NSPoint) -> Bool {
    guard interaction.mode == .move, !interaction.startLayout.expanded else {
      return false
    }
    return abs(screenPoint.x - interaction.startMouseX) <= agentIslandClickDragTolerance
      && abs(screenPoint.y - interaction.startMouseY) <= agentIslandClickDragTolerance
  }

  private func shouldPromotePendingMove(interaction: PanelDragInteraction, screenPoint: NSPoint) -> Bool {
    abs(screenPoint.x - interaction.startMouseX) > agentIslandClickDragTolerance
      || abs(screenPoint.y - interaction.startMouseY) > agentIslandClickDragTolerance
  }

  private func isResizable(layout: AgentIslandLayout) -> Bool {
    model.state.visible && layout.width > 0
  }

  private func visualIslandRect(frame: NSRect, layout: AgentIslandLayout) -> NSRect {
    NSRect(
      x: frame.midX - layout.width / 2,
      y: frame.maxY - layout.height,
      width: layout.width,
      height: layout.height
    )
  }

  private func visualIslandHitRect(frame: NSRect, layout: AgentIslandLayout) -> NSRect {
    let rect = visualIslandRect(frame: frame, layout: layout)
    return NSRect(
      x: rect.minX - layout.topExtension,
      y: rect.minY,
      width: rect.width + layout.topExtension * 2,
      height: rect.height
    )
  }

  private func centeredFrameForResize(
    contentWidth: CGFloat,
    inset: CGFloat,
    startFrame: NSRect
  ) -> NSRect {
    var frame = startFrame
    frame.size.width = contentWidth + inset * 2
    frame.origin.x = startFrame.midX - frame.width / 2
    return frame
  }

  private func applyInteractiveFrame(_ frame: NSRect, animatedSnap: Bool = false) {
    if animatedSnap {
      animateCompactSnapFrame(frame)
    } else if !isActiveSnapAnimationTarget(frame) {
      panel.setFrame(frame, display: true)
    }
    lastCocoaFrame = frame
    let hardwareNotchLayoutEnabled = isHardwareNotchLayoutEnabled(
      frame: frame,
      expanded: lastLayout.expanded
    )
    lastLayout = AgentIslandLayout.compute(
      state: model.state,
      availableFrameWidth: frame.width,
      locallyHovered: model.locallyHovered,
      notchBaselineHeight: model.notchBaselineHeight,
      screenMetrics: model.screenMetrics,
      hardwareNotchLayoutEnabled: hardwareNotchLayoutEnabled,
      preferredContentWidth: currentContentWidth(frame: frame, layout: lastLayout)
    )
    let nextContentWidth = currentContentWidth(frame: frame, layout: lastLayout)
    if animatedSnap {
      beginCompactSnapLayoutAnimation()
      withAnimation(agentIslandCompactSnapAnimation) {
        model.carrierWidth = frame.width
        model.preferredContentWidth = nextContentWidth
      }
    } else {
      model.carrierWidth = frame.width
      model.preferredContentWidth = nextContentWidth
    }
    model.hardwareNotchLayoutEnabled = hardwareNotchLayoutEnabled
  }

  private func animateCompactSnapFrame(_ frame: NSRect) {
    activeSnapAnimationTargetFrame = frame
    NSAnimationContext.runAnimationGroup { context in
      context.duration = agentIslandCompactSnapFrameDuration
      context.timingFunction = CAMediaTimingFunction(controlPoints: 0.18, 0.95, 0.22, 1.0)
      panel.animator().setFrame(frame, display: true)
    }
  }

  private func beginCompactSnapLayoutAnimation() {
    snapAnimationGeneration += 1
    let generation = snapAnimationGeneration
    model.layoutSnapAnimating = true
    DispatchQueue.main.asyncAfter(deadline: .now() + agentIslandCompactSnapFrameDuration + 0.04) { [weak self] in
      guard let self, self.snapAnimationGeneration == generation else {
        return
      }
      self.model.layoutSnapAnimating = false
      self.activeSnapAnimationTargetFrame = nil
    }
  }

  private func isActiveSnapAnimationTarget(_ frame: NSRect) -> Bool {
    guard let target = activeSnapAnimationTargetFrame, model.layoutSnapAnimating else {
      return false
    }
    return abs(target.minX - frame.minX) < 0.5
      && abs(target.minY - frame.minY) < 0.5
      && abs(target.width - frame.width) < 0.5
      && abs(target.height - frame.height) < 0.5
  }

  private func currentContentWidth(frame: NSRect, layout: AgentIslandLayout) -> CGFloat {
    constrainedContentWidth(
      frame.width - layout.carrierInset * 2,
      expanded: layout.expanded,
      fixedCenterX: frame.midX
    )
  }

  private func isHardwareNotchLayoutEnabled(
    frame: NSRect,
    expanded: Bool,
    screenMetrics: AgentIslandScreenMetrics? = nil,
    screen: NSScreen? = nil
  ) -> Bool {
    isHardwareNotchLayoutEnabled(
      expanded: expanded,
      centerX: frame.midX,
      screenMetrics: screenMetrics,
      screen: screen
    )
  }

  private func isHardwareNotchLayoutEnabled(
    expanded: Bool,
    centerX: CGFloat?,
    screenMetrics: AgentIslandScreenMetrics? = nil,
    screen: NSScreen? = nil
  ) -> Bool {
    let metrics = screenMetrics ?? model.screenMetrics
    guard metrics.hasNotch, let centerX else {
      return false
    }
    let screenCenterX = screen?.frame.midX ?? CGFloat(metrics.frame.x + metrics.frame.width / 2)
    return abs(centerX - screenCenterX) <= hardwareNotchCenterTolerance
  }

  private func shouldAnimateCompactSnapTransition(
    from previous: CompactWidthSnapMode,
    to next: CompactWidthSnapMode
  ) -> Bool {
    (previous == .hidden && next == .basic) || (previous == .basic && next == .hidden)
  }

  private func compactWidthSnapMode(
    contentWidth: CGFloat,
    interaction: PanelDragInteraction
  ) -> CompactWidthSnapMode {
    guard interaction.mode != .move,
      !interaction.startLayout.expanded,
      isHardwareNotchLayoutEnabled(
        frame: interaction.startFrame,
        expanded: interaction.startLayout.expanded
      )
    else {
      return .free
    }
    let maxWidth = maximumContentWidth(
      expanded: false,
      fixedCenterX: interaction.startFrame.midX
    )
    let hiddenWidth = min(maxWidth, max(1, CGFloat(model.screenMetrics.notchWidth)))
    let basicWidth = min(
      maxWidth,
      max(
        hiddenWidth,
        AgentIslandLayout.defaultCompactWidth(
          hasSession: model.state.totalCount > 0,
          screenMetrics: model.screenMetrics,
          compactBadgeWidth: compactBadgeWidth
        )
      )
    )
    guard basicWidth - hiddenWidth > 8 else {
      return .hidden
    }
    if abs(contentWidth - hiddenWidth) <= compactWidthSnapTolerance {
      return .hidden
    }
    if abs(contentWidth - basicWidth) <= compactWidthSnapTolerance {
      return .basic
    }
    return .free
  }

  private func constrainedContentWidth(
    _ desiredWidth: CGFloat,
    expanded: Bool,
    fixedCenterX: CGFloat? = nil
  ) -> CGFloat {
    let maxWidth = maximumContentWidth(expanded: expanded, fixedCenterX: fixedCenterX)
    let hardwareNotchLayoutEnabled = isHardwareNotchLayoutEnabled(
      expanded: expanded,
      centerX: fixedCenterX
    )
    let minWidth = min(
      minContentWidth(
        expanded: expanded,
        hardwareNotchLayoutEnabled: hardwareNotchLayoutEnabled
      ),
      maxWidth
    )
    let clampedWidth = min(maxWidth, max(minWidth, desiredWidth))
    return snappedCompactHardwareContentWidth(
      desiredWidth: desiredWidth,
      clampedWidth: clampedWidth,
      maxWidth: maxWidth,
      expanded: expanded,
      hardwareNotchLayoutEnabled: hardwareNotchLayoutEnabled
    )
  }

  private func maximumContentWidth(expanded: Bool, fixedCenterX: CGFloat? = nil) -> CGFloat {
    guard let screen = currentScreen() else {
      return expandedIslandMaxContentWidth
    }
    var maxWidth = min(
      expandedIslandMaxContentWidth,
      max(1, screen.frame.width - expandedIslandScreenEdgeGutter)
    )
    if let fixedCenterX {
      let sideAllowance = max(
        0,
        min(fixedCenterX - screen.frame.minX, screen.frame.maxX - fixedCenterX)
      )
      let fixedCenterMaxWidth = max(
        1,
        sideAllowance * 2 - expandedIslandCarrierExpandedInset * 2
      )
      maxWidth = min(maxWidth, fixedCenterMaxWidth)
    }
    return maxWidth
  }

  private func snappedCompactHardwareContentWidth(
    desiredWidth: CGFloat,
    clampedWidth: CGFloat,
    maxWidth: CGFloat,
    expanded: Bool,
    hardwareNotchLayoutEnabled: Bool
  ) -> CGFloat {
    guard !expanded, hardwareNotchLayoutEnabled, model.screenMetrics.hasNotch else {
      return clampedWidth
    }
    return AgentIslandLayout.snappedCompactHardwareWidth(
      desiredWidth: desiredWidth,
      clampedWidth: clampedWidth,
      maxWidth: maxWidth,
      hasSession: model.state.totalCount > 0,
      screenMetrics: model.screenMetrics,
      compactBadgeWidth: compactBadgeWidth
    )
  }

  /// Width reserved for the compact count badge in the current snapshot, used to keep
  /// drag snapping aligned with the reserved default width. Only the centered hardware
  /// notch layout reserves room for the badge.
  private var compactBadgeWidth: CGFloat {
    guard model.hardwareNotchLayoutEnabled,
      model.screenMetrics.hasNotch,
      model.state.totalCount > 0
    else {
      return 0
    }
    return PillBadge.intrinsicWidth(pillSnapshot: model.state.pillSnapshot, compact: true)
  }

  /// Width persisted as the user's compact preference. At the badge-aware basic snap we
  /// store the badge-independent basic width instead: the stored scalar must not encode
  /// the current count, otherwise the island keeps a wide preference after the count
  /// drops (and the snap can no longer contract).
  ///
  /// Gated on `hardwareNotchLayoutEnabled` as well as `hasNotch`: once the island is
  /// moved off the notch, the emitted frame uses the plain compact layout and its width
  /// must be persisted verbatim — rewriting it there would shrink the island mid-move.
  private func persistedCompactContentWidth(_ contentWidth: CGFloat) -> CGFloat {
    guard !lastLayout.expanded,
      model.hardwareNotchLayoutEnabled,
      model.screenMetrics.hasNotch
    else {
      return contentWidth
    }
    let hasSession = model.state.totalCount > 0
    let badgeAwareBasicWidth = AgentIslandLayout.defaultCompactWidth(
      hasSession: hasSession,
      screenMetrics: model.screenMetrics,
      compactBadgeWidth: compactBadgeWidth
    )
    guard abs(contentWidth - badgeAwareBasicWidth) <= compactWidthSnapTolerance else {
      return contentWidth
    }
    return AgentIslandLayout.defaultCompactWidth(
      hasSession: hasSession,
      screenMetrics: model.screenMetrics
    )
  }

  private func minContentWidth(expanded: Bool, hardwareNotchLayoutEnabled: Bool) -> CGFloat {
    let screenMetrics = hardwareNotchLayoutEnabled
      ? model.screenMetrics
      : model.screenMetrics.disablingHardwareNotchLayout()
    return AgentIslandLayout.minContentWidth(expanded: expanded, screenMetrics: screenMetrics)
  }

  private func constrainedCenterX(_ desiredCenterX: CGFloat, contentWidth: CGFloat) -> CGFloat {
    guard let screen = currentScreen() else {
      return desiredCenterX
    }
    let expandedCarrierWidth = contentWidth + expandedIslandCarrierExpandedInset * 2
    let minCenter = screen.frame.minX + expandedCarrierWidth / 2
    let maxCenter = screen.frame.maxX - expandedCarrierWidth / 2
    if minCenter > maxCenter {
      return screen.frame.midX
    }
    return min(maxCenter, max(minCenter, desiredCenterX))
  }

  private func snappedConstrainedCenterX(_ desiredCenterX: CGFloat, contentWidth: CGFloat) -> CGFloat {
    guard let screen = currentScreen() else {
      return constrainedCenterX(desiredCenterX, contentWidth: contentWidth)
    }
    let constrained = constrainedCenterX(desiredCenterX, contentWidth: contentWidth)
    if abs(constrained - screen.frame.midX) <= expandedIslandCenterSnapDistance {
      return constrainedCenterX(screen.frame.midX, contentWidth: contentWidth)
    }
    return constrained
  }

  private func emitLayoutPreference(
    frame: NSRect,
    contentWidth: CGFloat,
    force: Bool,
    snapCenter: Bool = true
  ) {
    let now = ProcessInfo.processInfo.systemUptime
    if !force && now - lastLayoutEmitTime < expandedIslandLayoutEmitInterval {
      return
    }
    lastLayoutEmitTime = now
    guard let screen = currentScreen(), screen.frame.width > 0 else {
      return
    }
    let centerX = snapCenter
      ? snappedConstrainedCenterX(frame.midX, contentWidth: contentWidth)
      : frame.midX
    let ratio = (centerX - screen.frame.minX) / screen.frame.width
    eventSink([
      "type": "layout",
      "displayId": AgentIslandScreenMetricsProvider.displayId(for: screen),
      "centerXRatio": Double(min(1, max(0, ratio))),
      "contentWidth": Double(persistedCompactContentWidth(
        constrainedContentWidth(contentWidth, expanded: lastLayout.expanded)
      )),
      "expanded": lastLayout.expanded,
    ])
  }

  private func currentScreen() -> NSScreen? {
    if let lastCarrierFrame {
      return screenForFrame(lastCarrierFrame)
    }
    return panel.screen ?? NSScreen.main ?? NSScreen.screens.first
  }

  private func handleMouseMoved(screenPoint: NSPoint, force: Bool = false) {
    handleMouseMoved(screenPoint: screenPoint, hit: hitTestInteraction(screenPoint: screenPoint), force: force)
  }

  private func handleMouseMoved(screenPoint: NSPoint, hit: PanelPointerHit, force: Bool = false) {
    updateCursor(for: hit, screenPoint: screenPoint)
    guard dragInteraction == nil, pendingMoveInteraction == nil else {
      return
    }
    let now = ProcessInfo.processInfo.systemUptime
    if !force && now - lastMoveTime < 0.016 {
      return
    }
    lastMoveTime = now
    guard let zones = hoverZones(for: hit) else {
      emitHover(menuBar: false, panel: false)
      return
    }
    emitHover(menuBar: zones.menuBar, panel: zones.panel)
  }

  private func pushDragCursor(for interaction: PanelDragInteraction) {
    let kind: PanelCursorKind
    switch interaction.mode {
    case .move:
      popPushedCursor()
      PanelCursorKind.system.set()
      activeCursorKind = .system
      return
    case .resizeLeft:
      kind = .frameResizeLeft
    case .resizeRight:
      kind = .frameResizeRight
    }
    claimDragCursorOwnership(kind)
    if pushedCursorKind == kind {
      activeCursorKind = kind
      reinforceDragCursor(kind)
      return
    }
    popPushedCursor()
    kind.cursor.push()
    kind.set()
    pushedCursorKind = kind
    activeCursorKind = kind
    reinforceDragCursor(kind)
  }

  private func claimDragCursorOwnership(_ kind: PanelCursorKind) {
    kind.set()
  }

  private func reinforceDragCursor(_ kind: PanelCursorKind) {
    DispatchQueue.main.async { [weak self] in
      guard self?.pushedCursorKind == kind else {
        return
      }
      self?.claimDragCursorOwnership(kind)
    }
  }

  private func popPushedCursor() {
    guard pushedCursorKind != nil else {
      return
    }
    NSCursor.pop()
    pushedCursorKind = nil
  }

  private func updateCursor(for hit: PanelPointerHit, screenPoint: NSPoint) {
    if let pushedCursorKind {
      claimDragCursorOwnership(pushedCursorKind)
      activeCursorKind = pushedCursorKind
      return
    }
    let cursorKind = cursorKind(for: hit)
    if cursorKind != .system || activeCursorKind != .system {
      cursorKind.set()
    }
    if cursorKind != activeCursorKind {
      activeCursorKind = cursorKind
    }
  }

  private func cursorKind(for hit: PanelPointerHit) -> PanelCursorKind {
    if let interaction = dragInteraction {
      switch interaction.mode {
      case .move:
        return .system
      case .resizeLeft:
        return .frameResizeLeft
      case .resizeRight:
        return .frameResizeRight
      }
    }
    switch hit {
    case .resizeLeft:
      return .frameResizeLeft
    case .resizeRight:
      return .frameResizeRight
    case .menuBar:
      return .system
    case .panel, .outside:
      return .system
    }
  }

  private func hitTestInteraction(screenPoint: NSPoint) -> PanelPointerHit {
    guard model.state.visible, panel.isVisible else {
      return .outside
    }
    let hitRect = visualIslandHitRect(frame: panel.frame, layout: lastLayout)
    let screenTopY = currentScreen()?.frame.maxY ?? hitRect.maxY
    let topHitMaxY = max(hitRect.maxY, screenTopY) + agentIslandTopDragHitSlop
    guard screenPoint.y >= hitRect.minY, screenPoint.y <= topHitMaxY else {
      return .outside
    }
    let insideVisualX = screenPoint.x >= hitRect.minX && screenPoint.x <= hitRect.maxX
    if screenPoint.y > hitRect.maxY {
      return moveHitTestAboveVisualTop(screenPoint: screenPoint, hitRect: hitRect)
    }
    if isResizable(layout: lastLayout) {
      if isResizeHit(screenPoint: screenPoint, hitRect: hitRect, edge: .left) {
        return .resizeLeft
      }
      if isResizeHit(screenPoint: screenPoint, hitRect: hitRect, edge: .right) {
        return .resizeRight
      }
    }
    guard insideVisualX else {
      return .outside
    }

    let topOffset = hitRect.maxY - screenPoint.y
    if lastLayout.expanded {
      return topOffset <= lastLayout.menuBarZoneHeight ? .menuBar : .panel
    }

    return .menuBar
  }

  private func isResizeHit(
    screenPoint: NSPoint,
    hitRect: NSRect,
    edge: AgentIslandResizeEdge
  ) -> Bool {
    let innerWidth = resizeInnerHitWidth(screenPoint: screenPoint, hitRect: hitRect)
    switch edge {
    case .left:
      return screenPoint.x >= hitRect.minX - expandedIslandResizeOuterHitWidth
        && screenPoint.x <= hitRect.minX + innerWidth
    case .right:
      return screenPoint.x >= hitRect.maxX - innerWidth
        && screenPoint.x <= hitRect.maxX + expandedIslandResizeOuterHitWidth
    }
  }

  private func resizeInnerHitWidth(screenPoint: NSPoint, hitRect: NSRect) -> CGFloat {
    guard lastLayout.expanded else {
      return compactIslandResizeHitWidth
    }
    let topHeight = min(hitRect.height, max(0, lastLayout.menuBarZoneHeight))
    let topZoneMinY = hitRect.maxY - topHeight
    if screenPoint.y >= topZoneMinY {
      return expandedIslandTopResizeInnerHitWidth
    }
    return expandedIslandPanelResizeInnerHitWidth
  }

  private func moveHitTestAboveVisualTop(screenPoint: NSPoint, hitRect: NSRect) -> PanelPointerHit {
    if lastLayout.expanded {
      let moveMinX = hitRect.minX + expandedIslandTopResizeInnerHitWidth
      let moveMaxX = hitRect.maxX - expandedIslandTopResizeInnerHitWidth
      return screenPoint.x >= moveMinX && screenPoint.x <= moveMaxX ? .menuBar : .outside
    }
    let moveMinX = hitRect.minX + compactIslandResizeHitWidth
    let moveMaxX = hitRect.maxX - compactIslandResizeHitWidth
    return screenPoint.x >= moveMinX && screenPoint.x <= moveMaxX ? .menuBar : .outside
  }

  private func hoverZones(for hit: PanelPointerHit) -> (menuBar: Bool, panel: Bool)? {
    switch hit {
    case .resizeLeft, .resizeRight:
      return lastLayout.expanded ? (false, true) : nil
    case .menuBar:
      return (true, false)
    case .panel:
      return (false, true)
    case .outside:
      return nil
    }
  }

  private func emitHover(menuBar: Bool, panel: Bool) {
    if menuBar == lastMenuBarHover && panel == lastPanelHover {
      refreshInteractionPoller()
      return
    }
    lastMenuBarHover = menuBar
    lastPanelHover = panel
    model.locallyHovered = menuBar || panel
    eventSink(["type": "hover", "menuBar": menuBar, "panel": panel])
    refreshInteractionPoller()
  }

  private func replayDeferredInteractionUpdateIfNeeded(preservingCurrentPanelFrame: Bool = false) {
    guard dragInteraction == nil, pendingMoveInteraction == nil else {
      return
    }
    guard let update = deferredInteractionUpdate else {
      return
    }
    deferredInteractionUpdate = nil
    let frame = preservingCurrentPanelFrame
      ? carrierFramePreservingCurrentPanel(from: update.frame)
      : update.frame
    apply(state: update.state, frame: frame)
  }

  private func carrierFramePreservingCurrentPanel(from frame: AgentIslandCarrierFrame) -> AgentIslandCarrierFrame {
    guard let screen = currentScreen() ?? screenForFrame(frame) else {
      return frame
    }
    return AgentIslandCarrierFrame(
      x: Double(panel.frame.minX - screen.frame.minX) + frame.displayBounds.x,
      y: Double(screen.frame.maxY - panel.frame.maxY) + frame.displayBounds.y,
      width: Double(panel.frame.width),
      height: Double(panel.frame.height),
      displayId: frame.displayId,
      displayBounds: frame.displayBounds,
      contentWidth: Double(currentContentWidth(frame: panel.frame, layout: lastLayout))
    )
  }

  private func scheduleCarrierFrame(_ frame: NSRect, after delay: TimeInterval) {
    if pendingCarrierFrame == frame && pendingCarrierFrameTimer != nil {
      return
    }
    cancelPendingCarrierFrame()
    pendingCarrierFrame = frame
    let timer = Timer.scheduledTimer(withTimeInterval: delay, repeats: false) { [weak self] _ in
      guard let self else {
        return
      }
      self.pendingCarrierFrameTimer = nil
      guard let frame = self.pendingCarrierFrame else {
        return
      }
      self.pendingCarrierFrame = nil
      guard self.dragInteraction == nil else {
        return
      }
      self.setPanelFrame(frame, animated: true)
      self.lastCocoaFrame = frame
    }
    pendingCarrierFrameTimer = timer
    RunLoop.main.add(timer, forMode: .common)
  }

  private func cancelPendingCarrierFrame() {
    pendingCarrierFrameTimer?.invalidate()
    pendingCarrierFrameTimer = nil
    pendingCarrierFrame = nil
  }

  private func setPanelFrame(_ frame: NSRect, animated: Bool) {
    let contentFrame = NSRect(origin: .zero, size: frame.size)
    if contentRoot.frame.size != frame.size {
      contentRoot.frame = contentFrame
    }
    for subview in contentRoot.subviews where subview.frame != contentFrame {
      subview.frame = contentFrame
    }
    panel.setFrame(frame, display: false)
  }

  private func convertToCocoaFrame(
    _ frame: AgentIslandCarrierFrame,
    screen: NSScreen?,
    carrierHeight: CGFloat
  ) -> NSRect {
    guard let screen else {
      return NSRect(x: frame.x, y: frame.y, width: frame.width, height: Double(carrierHeight))
    }
    let x = screen.frame.minX + CGFloat(frame.x - frame.displayBounds.x)
    let topOffset = CGFloat(frame.y - frame.displayBounds.y)
    let y = screen.frame.maxY - topOffset - carrierHeight
    return NSRect(x: x, y: y, width: frame.width, height: carrierHeight)
  }

  private func screenForFrame(_ frame: AgentIslandCarrierFrame) -> NSScreen? {
    screenForDisplayId(frame.displayId)
      ?? NSScreen.screens.first { screen in
        abs(screen.frame.minX - CGFloat(frame.displayBounds.x)) < 1
          && abs(screen.frame.width - CGFloat(frame.displayBounds.width)) < 1
          && abs(screen.frame.height - CGFloat(frame.displayBounds.height)) < 1
      }
      ?? NSScreen.screens.first { screen in
        abs(screen.frame.width - CGFloat(frame.displayBounds.width)) < 1
          && abs(screen.frame.height - CGFloat(frame.displayBounds.height)) < 1
      }
      ?? NSScreen.main
      ?? NSScreen.screens.first
  }

  private func screenForDisplayId(_ displayId: Int) -> NSScreen? {
    NSScreen.screens.first { screen in
      AgentIslandScreenMetricsProvider.displayId(for: screen) == displayId
    }
  }
}

final class AgentIslandDisplayControllerManager {
  private var controllers: [Int: AgentIslandController] = [:]

  func apply(
    state: AgentIslandDisplayState,
    frames: [AgentIslandCarrierFrame],
    statesByDisplayId: [String: AgentIslandDisplayState]? = nil
  ) {
    let nextDisplayIds = Set(frames.map(\.displayId))
    for displayId in controllers.keys where !nextDisplayIds.contains(displayId) {
      controllers.removeValue(forKey: displayId)?.close()
    }
    for frame in frames {
      let stateForDisplay = statesByDisplayId?[String(frame.displayId)] ?? state
      controller(for: frame.displayId).apply(state: stateForDisplay, frame: frame)
    }
  }

  func closeAll() {
    for controller in controllers.values {
      controller.close()
    }
    controllers.removeAll()
  }

  func publishScreenMetrics() {
    emitAgentIslandScreenMetrics()
  }

  private func controller(for displayId: Int) -> AgentIslandController {
    if let controller = controllers[displayId] {
      return controller
    }
    let controller = AgentIslandController(
      eventSink: { payload in
        var next = payload
        next["displayId"] = displayId
        emitJson(next)
      },
      containsAnyPanel: { [weak self] point in
        self?.containsAnyPanel(screenPoint: point) ?? false
      }
    )
    controllers[displayId] = controller
    return controller
  }

  private func containsAnyPanel(screenPoint: NSPoint) -> Bool {
    controllers.values.contains { controller in
      controller.contains(screenPoint: screenPoint)
    }
  }
}

func emitJson(_ payload: [String: Any]) {
  do {
    let data = try JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([0x0a]))
  } catch {
    let fallback = "{\"type\":\"error\",\"message\":\"Could not encode agent island event.\"}\n"
    FileHandle.standardError.write(Data(fallback.utf8))
  }
  fflush(stdout)
}

func emitAgentIslandScreenMetrics() {
  var payload: [String: Any] = [
    "type": "screen-metrics",
    "screens": AgentIslandScreenMetricsProvider.allMetrics().map { $0.dictionary },
  ]
  if let preferredDisplayId = AgentIslandScreenMetricsProvider.preferredDisplayId() {
    payload["preferredDisplayId"] = preferredDisplayId
  }
  emitJson(payload)
}

enum AgentIslandDebugHarness {
  static func makeUpdate() -> (state: AgentIslandDisplayState, frame: AgentIslandCarrierFrame)? {
    guard let mode = ProcessInfo.processInfo.environment["XDT_AGENT_ISLAND_DEBUG"], !mode.isEmpty else {
      return nil
    }
    let screen = NSScreen.main ?? NSScreen.screens.first
    let screenFrame = screen?.frame ?? NSRect(x: 0, y: 0, width: 1728, height: 1117)
    let displayId = (screen?.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.intValue ?? 1
    let frameWidth = min(800, max(428, screenFrame.width - 40))
    let displayBounds = AgentIslandRect(
      x: Double(screenFrame.minX),
      y: 0,
      width: Double(screenFrame.width),
      height: Double(screenFrame.height)
    )
    let frame = AgentIslandCarrierFrame(
      x: Double(screenFrame.minX + (screenFrame.width - frameWidth) / 2),
      y: 0,
      width: Double(frameWidth),
      height: 640,
      displayId: displayId,
      displayBounds: displayBounds,
      contentWidth: nil
    )
    return (debugState(mode: mode), frame)
  }

  private static func debugState(mode: String) -> AgentIslandDisplayState {
    let now = Date().timeIntervalSince1970 * 1000
    let sessions = debugSessions(now: now)
    switch mode {
    case "idle":
      return AgentIslandDisplayState.empty
    case "completion":
      return displayState(
        mode: "expanded",
        displayPolicy: "transient",
        displaySurface: "completionCard",
        currentSessionId: sessions[3].sessionId,
        sessions: sessions,
        now: now
      )
    case "interaction":
      return displayState(
        mode: "expanded",
        displayPolicy: "blocking",
        displaySurface: "interactionCard",
        currentSessionId: sessions[1].sessionId,
        sessions: sessions,
        now: now
      )
    default:
      return displayState(
        mode: "expanded",
        displayPolicy: "manualExpanded",
        displaySurface: "sessionList",
        currentSessionId: sessions[0].sessionId,
        sessions: sessions,
        now: now
      )
    }
  }

  private static func displayState(
    mode: String,
    displayPolicy: String,
    displaySurface: String,
    currentSessionId: String,
    sessions: [AgentIslandSession],
    now: Double
  ) -> AgentIslandDisplayState {
    let current = sessions.first { $0.sessionId == currentSessionId } ?? sessions[0]
    let activeCount = sessions.filter { $0.phase == "running" || $0.phase == "needs-interaction" }.count
    let pendingCount = sessions.filter { $0.phase == "needs-interaction" }.count
    let unreadDoneCount = sessions.filter { $0.phase == "completed" || $0.phase == "error" }.count
    return AgentIslandDisplayState(
      visible: true,
      mode: mode,
      notchStatus: mode == "expanded" ? "expanded" : "peek",
      displayPolicy: displayPolicy,
      displaySurface: displaySurface,
      layoutMode: mode == "expanded" ? "normal" : "compact",
      appFocused: false,
      smartSuppressed: false,
      shadowVisible: mode == "expanded",
      currentSessionId: current.sessionId,
      expandedDisplayId: nil,
      pillSnapshot: AgentIslandPillSnapshot(
        priorityId: current.sessionId,
        priorityStatus: current.phase,
        priorityMicroTitle: current.displayTitle,
        priorityCompactTitle: current.displayTitle,
        sessionCount: sessions.count,
        activeSessionCount: activeCount,
        pendingInteractionCount: pendingCount,
        unreadCompletedCount: unreadDoneCount,
        deferredRevealCount: 1,
        attentionCount: unreadDoneCount + pendingCount
      ),
      sessions: sessions,
      totalCount: sessions.count,
      measuredContentHeight: 0,
      strings: .fallback,
      soundSettings: .fallback,
      mascotSkin: defaultAgentIslandMascotSkin,
      updatedAt: now
    )
  }

  private static func debugSessions(now: Double) -> [AgentIslandSession] {
    [
      debugSession("debug-1", title: "Run island review", project: "xdt-maker", detail: "$ pnpm test", phase: "running", agent: "codex", startedAt: now - 42_000),
      debugSession("debug-2", title: "Approve file edit", project: "desktop", detail: "macos-agent-island-helper.swift", phase: "needs-interaction", agent: "claude-code", interactionKind: "permission", startedAt: now - 68_000),
      debugSession("debug-3", title: "Polish compact status", project: "maker-core", detail: "Thinking", phase: "running", agent: "codex", startedAt: now - 95_000),
      debugSession("debug-4", title: "Render mock payload", project: "native-helper", detail: "", phase: "completed", agent: "codex", startedAt: now - 132_000),
      debugSession("debug-5", title: "Fix notification edge case", project: "main", detail: "Renderer did not ACK", phase: "error", agent: "claude-code", startedAt: now - 164_000),
      debugSession("debug-6", title: "Update settings copy", project: "renderer", detail: "$ pnpm lint", phase: "running", agent: "codex", startedAt: now - 190_000),
      debugSession("debug-7", title: "Archive old task", project: "server", detail: "", phase: "completed", agent: "codex", startedAt: now - 240_000),
    ]
  }

  private static func debugSession(
    _ id: String,
    title: String,
    project: String,
    detail: String,
    phase: String,
    agent: String,
    interactionKind: String? = nil,
    startedAt: Double
  ) -> AgentIslandSession {
    AgentIslandSession(
      sessionId: id,
      title: title,
      projectName: project,
      detail: detail,
      compactDetail: detail,
      messagePreview: nil,
      phase: phase,
      agentKind: agent,
      interactionKind: interactionKind,
      permissionAction: interactionKind == "permission" ? AgentIslandPermissionAction(requestId: "\(id)-request", canAllowForSession: true) : nil,
      attention: phase == "needs-interaction" || phase == "completed" || phase == "error",
      activityLines: [
        AgentIslandActivityLine(id: "\(id)-1", kind: "user", text: title),
        AgentIslandActivityLine(id: "\(id)-2", kind: "assistant", text: detail.isEmpty ? expandedStatusTextForPhase(phase, strings: .fallback) : detail),
      ],
      startedAt: startedAt,
      lastActivityAt: startedAt + 18_000
    )
  }

  private static func expandedStatusTextForPhase(_ phase: String, strings: AgentIslandStrings) -> String {
    switch phase {
    case "completed": return strings.completed
    case "error": return strings.error
    case "needs-interaction": return strings.needsInput
    default: return strings.running
    }
  }
}

// MARK: - 角色预览网格(开发调试用，不参与产品运行路径)

private let agentIslandMascotPreviewStates: [(state: AgentIslandMascotAnimationState, label: String)] = [
  (.idle, "idle"),
  (.working, "working"),
  (.waitingApproval, "waitingApproval"),
  (.completed, "completed"),
]

private enum AgentIslandMascotPreviewAppearance: String, CaseIterable, Identifiable {
  case dark
  case light
  case both

  var id: String { rawValue }

  var title: String {
    switch self {
    case .dark: return "Dark"
    case .light: return "Light"
    case .both: return "两种模式"
    }
  }
}

/// 预览窗口的启动开关(命令行参数,不走环境变量:见 AgentIslandMascotPreview 的说明)。
private let agentIslandMascotPreviewFlag = "--mascot-preview"

private let agentIslandMascotPreviewZooms: [Double] = [1, 2, 3, 4, 6, 8]

/// 角色在产品里的真实渲染尺寸：
/// 16pt 收起 pill、18pt 紧凑行、20pt 展开态（灵动岛原生，本文件的调用点）；
/// 40pt 是设置页「图标皮肤」列表里的角色本体尺寸（renderer 的 `h-10 w-10`，
/// 见 AgentIslandSection.tsx `MascotPreviewImage` / `SpriteMascotPreview`）。
/// 设置页那套是 React/CSS 重画的，这里只作同尺寸参照，用来核对放大后的形态。
private let agentIslandMascotRealSizes: [(size: Double, label: String)] = [
  (16, "16 收起"),
  (18, "18 紧凑"),
  (20, "20 展开"),
  (40, "40 设置页"),
]

/// 单个「角色 × 状态」格子。底板只是预览用的对比背景，不代表产品视觉规范。
/// `size` 始终是产品真实渲染尺寸，`zoom` 只做视觉放大(几何比例不变)，便于肉眼看清细节。
private struct AgentIslandMascotPreviewCell: View {
  let skin: String
  let state: AgentIslandMascotAnimationState
  let label: String
  let size: CGFloat
  let zoom: CGFloat
  let isDark: Bool

  private var boxSide: CGFloat { size * zoom + 24 }

  var body: some View {
    VStack(spacing: 6) {
      ZStack {
        RoundedRectangle(cornerRadius: 12, style: .continuous)
          .fill(isDark ? Color(white: 0.06) : Color(white: 0.97))
        RoundedRectangle(cornerRadius: 12, style: .continuous)
          .strokeBorder(isDark ? Color(white: 1.0, opacity: 0.10) : Color(white: 0.0, opacity: 0.10))
        AgentIslandMascotView(skin: skin, state: state, size: size)
          .scaleEffect(zoom)
      }
      .frame(width: boxSide, height: boxSide)
      Text(label)
        .font(.system(size: 10, weight: .medium, design: .monospaced))
        .foregroundStyle(.secondary)
    }
  }
}

/// 一整块网格：行 = 角色(取自 `AgentIslandMascotCatalog.skins`)，列 = 动画状态。
private struct AgentIslandMascotPreviewGrid: View {
  let size: CGFloat
  let zoom: CGFloat
  let isDark: Bool

  var body: some View {
    VStack(alignment: .leading, spacing: 18) {
      ForEach(AgentIslandMascotCatalog.skins, id: \.self) { skin in
        HStack(alignment: .top, spacing: 16) {
          VStack(alignment: .leading, spacing: 2) {
            Text(skin)
              .font(.system(size: 12, weight: .semibold, design: .monospaced))
            Text(AgentIslandMascotCatalog.spriteConfig(for: skin) == nil ? "vector" : "sprite")
              .font(.system(size: 9))
              .foregroundStyle(.tertiary)
          }
          .frame(width: 96, alignment: .leading)
          .padding(.top, max(0, size * zoom / 2 - 8))

          ForEach(agentIslandMascotPreviewStates, id: \.label) { entry in
            AgentIslandMascotPreviewCell(
              skin: skin,
              state: entry.state,
              label: entry.label,
              size: size,
              zoom: zoom,
              isDark: isDark
            )
          }
        }
      }
    }
  }
}

/// 预览控件状态。本文件是顶层脚本(main.swift)模式，`@State` 的内联默认值在这里不可靠
/// (会退化成零值)，所以初值统一放到这个 model 的 init 里显式赋。
/// 另外这里的控件一律用 `Picker` 而不是 `Slider`：`Slider` 在本文件里出现过首帧把绑定值
/// 写回下界(初值丢失)，宽度受限时尤其容易触发。
private final class AgentIslandMascotPreviewModel: ObservableObject {
  @Published var appearance: AgentIslandMascotPreviewAppearance
  @Published var mascotSize: Double
  @Published var zoom: Double
  @Published var animationsActive: Bool
  @Published var animationEpoch: Int

  init() {
    appearance = .dark
    // 默认 = 灵动岛展开态真实尺寸 1:1，看细节再点放大档位，避免预览失真。
    mascotSize = 20
    zoom = 1
    animationsActive = true
    animationEpoch = 0
  }

  /// 首帧过后重新压一遍默认值。init 里的初值会被首帧布局改写(本文件的老毛病，
  /// 现有视图同样靠 onAppear 重置来兜)，这里补一刀保证工具条选中态与实际一致。
  func applyDefaults() {
    appearance = .dark
    mascotSize = 20
    zoom = 1
    animationsActive = true
  }
}

/// 自绘档位选择器。系统 `Picker` / `Slider` / `Toggle` 在本文件里会把绑定值改写成首项或
/// 下界(初值丢失)，这里改成 Button + 自管高亮，显示与 model 必然一致。
private struct AgentIslandPreviewChoice<Value: Equatable>: View {
  let options: [(value: Value, label: String)]
  @Binding var selection: Value

  var body: some View {
    HStack(spacing: 4) {
      ForEach(Array(options.indices), id: \.self) { index in
        let option = options[index]
        let isActive = option.value == selection
        Button {
          selection = option.value
        } label: {
          Text(option.label)
            .font(.system(size: 11, weight: isActive ? .semibold : .regular))
            .lineLimit(1)
            .fixedSize(horizontal: true, vertical: false)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(
              RoundedRectangle(cornerRadius: 6, style: .continuous)
                .fill(isActive ? Color.accentColor.opacity(0.24) : Color.primary.opacity(0.06))
            )
        }
        .buttonStyle(.plain)
      }
    }
  }
}

private struct AgentIslandMascotPreviewView: View {
  @ObservedObject var model: AgentIslandMascotPreviewModel

  private var appearance: AgentIslandMascotPreviewAppearance { model.appearance }
  private var mascotSize: CGFloat { CGFloat(model.mascotSize) }

  var body: some View {
    VStack(spacing: 0) {
      toolbar
      Divider()
      ScrollView([.vertical, .horizontal]) {
        VStack(alignment: .leading, spacing: 28) {
          switch appearance {
          case .dark:
            grid(isDark: true)
          case .light:
            grid(isDark: false)
          case .both:
            labeledGrid(title: "Dark", isDark: true)
            labeledGrid(title: "Light", isDark: false)
          }
        }
        .padding(24)
      }
    }
    .frame(minWidth: 720, minHeight: 480)
    .onAppear {
      model.applyDefaults()
    }
  }

  private var toolbar: some View {
    HStack(spacing: 14) {
      AgentIslandPreviewChoice(
        options: AgentIslandMascotPreviewAppearance.allCases.map { ($0, $0.title) },
        selection: $model.appearance
      )

      HStack(spacing: 6) {
        Text("真实尺寸")
          .font(.system(size: 11))
          .foregroundStyle(.secondary)
        AgentIslandPreviewChoice(
          options: agentIslandMascotRealSizes.map { ($0.size, $0.label) },
          selection: $model.mascotSize
        )
      }

      HStack(spacing: 6) {
        Text("放大")
          .font(.system(size: 11))
          .foregroundStyle(.secondary)
        AgentIslandPreviewChoice(
          options: agentIslandMascotPreviewZooms.map { ($0, "\(Int($0))×") },
          selection: $model.zoom
        )
      }

      AgentIslandPreviewChoice(
        options: [(true, "播放"), (false, "暂停")],
        selection: $model.animationsActive
      )

      Button("从头播放") {
        model.animationEpoch += 1
      }
      .font(.system(size: 11))

      Spacer()

      Text(
        "\(AgentIslandMascotCatalog.skins.count) 角色 × \(agentIslandMascotPreviewStates.count) 状态 · 渲染 \(Int(model.mascotSize))pt"
      )
      .font(.system(size: 11, design: .monospaced))
      .foregroundStyle(.secondary)
    }
    .padding(.horizontal, 20)
    .padding(.vertical, 12)
  }

  private func grid(isDark: Bool) -> some View {
    AgentIslandMascotPreviewGrid(size: mascotSize, zoom: CGFloat(model.zoom), isDark: isDark)
      .agentIslandMascotAnimationsActive(model.animationsActive)
      .agentIslandMascotAnimationEpoch(model.animationEpoch)
  }

  private func labeledGrid(title: String, isDark: Bool) -> some View {
    VStack(alignment: .leading, spacing: 12) {
      Text(title)
        .font(.system(size: 12, weight: .bold, design: .monospaced))
        .foregroundStyle(.secondary)
      grid(isDark: isDark)
    }
  }
}

/// 由命令行参数 `--mascot-preview` 触发的独立预览窗口。
/// 刻意**不用环境变量**做开关：主进程 spawn helper 时会继承 `process.env`
/// (见 MacAgentIslandNativeHost.ts)，用户环境里若意外设置了该变量，产品 helper 会进
/// 预览分支、不 emit ready，被主进程判定超时反复重启。而 spawn 传的 argv 是空数组，
/// 命令行参数不存在这条泄漏路径。
/// 走这条分支时 helper 不读 stdin、不创建刘海面板，只当一个纯本地预览器。
private enum AgentIslandMascotPreview {
  static var isEnabled: Bool {
    CommandLine.arguments.dropFirst().contains(agentIslandMascotPreviewFlag)
  }

  private static var window: NSWindow?
  private static var closeObserver: NSObjectProtocol?
  private static var model: AgentIslandMascotPreviewModel?

  static func present() {
    let previewModel = AgentIslandMascotPreviewModel()
    model = previewModel
    let panel = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 1120, height: 780),
      styleMask: [.titled, .closable, .miniaturizable, .resizable],
      backing: .buffered,
      defer: false
    )
    panel.title = "Agent Island — 角色动画预览"
    panel.contentView = NSHostingView(rootView: AgentIslandMascotPreviewView(model: previewModel))
    panel.center()
    panel.isReleasedWhenClosed = false
    // 预览时常要跟设计稿、素材目录来回对照，置顶省得反复找窗口。
    panel.level = .floating
    window = panel
    closeObserver = NotificationCenter.default.addObserver(
      forName: NSWindow.willCloseNotification,
      object: panel,
      queue: .main
    ) { _ in
      NSApp.terminate(nil)
    }
    NSApp.setActivationPolicy(.regular)
    panel.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
  }
}

final class AgentIslandAppDelegate: NSObject, NSApplicationDelegate {
  private let controllerManager = AgentIslandDisplayControllerManager()
  private let decoder = JSONDecoder()

  func applicationDidFinishLaunching(_ notification: Notification) {
    if AgentIslandMascotPreview.isEnabled {
      AgentIslandMascotPreview.present()
      return
    }
    controllerManager.publishScreenMetrics()
    emitJson(["type": "ready"])
    if let update = AgentIslandDebugHarness.makeUpdate() {
      controllerManager.apply(state: update.state, frames: [update.frame])
      return
    }
    startReadingStdin()
  }

  private func startReadingStdin() {
    DispatchQueue.global(qos: .userInitiated).async { [weak self] in
      while let line = readLine() {
        self?.handleLine(line)
      }
      DispatchQueue.main.async {
        NSApp.terminate(nil)
      }
    }
  }

  private func handleLine(_ line: String) {
    guard let data = line.data(using: .utf8) else { return }
    do {
      let message = try decoder.decode(IncomingMessage.self, from: data)
      if message.type == "shutdown" {
        DispatchQueue.main.async { [controllerManager] in
          controllerManager.closeAll()
          NSApp.terminate(nil)
        }
        return
      }
      if message.type == "play-sound", let soundPath = message.soundPath {
        DispatchQueue.main.async {
          AgentIslandSoundPlayer.shared.play(filePath: soundPath)
        }
        return
      }
      if message.type == "play-sound", let soundId = message.soundId {
        DispatchQueue.main.async {
          AgentIslandSoundPlayer.shared.play(soundId: soundId)
        }
        return
      }
      let frames = message.frames ?? message.frame.map { [$0] } ?? []
      guard message.type == "update", let state = message.state, !frames.isEmpty else {
        return
      }
      DispatchQueue.main.async { [controllerManager] in
        controllerManager.apply(state: state, frames: frames, statesByDisplayId: message.statesByDisplayId)
      }
    } catch {
      let message = String(describing: error)
      emitJson(["type": "error", "message": "Could not decode agent island update: \(message)"])
    }
  }
}

let app = NSApplication.shared
let delegate = AgentIslandAppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
