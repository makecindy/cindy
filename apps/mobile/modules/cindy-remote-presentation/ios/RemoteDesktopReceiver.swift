import Foundation
import WebRTC
import UIKit

/// One lease owns one receiver. Signaling uses the existing JS adapter; media,
/// decoding and PiP challenge replies never pass through JS. All state is main-queue
/// confined, including callbacks from WebRTC's signaling and decoder threads.
final class RemoteDesktopReceiver: NSObject, RTCPeerConnectionDelegate, RTCDataChannelDelegate {
  private static let factory: RTCPeerConnectionFactory = {
    RTCInitializeSSL()
    return RTCPeerConnectionFactory(encoderFactory: RTCDefaultVideoEncoderFactory(),
                                    decoderFactory: RTCDefaultVideoDecoderFactory())
  }()
  let epoch: String
  let attempt = UUID().uuidString
  var emit: ([String: Any]) -> Void = { _ in }
  var onFrame: (RTCVideoFrame) -> Bool = { _ in false }
  var isPresenting: () -> Bool = { false }
  var isPresentationAuthorized: () -> Bool = { false }
  private var peer: RTCPeerConnection?
  private var channel: RTCDataChannel?
  private var track: RTCVideoTrack?
  private var audioTrack: RTCAudioTrack?
  private var sink: RemoteDesktopFrameSink?
  private var stopped = false
  private var audio = false
  private var trickle: Bool
  private let net: [String: Any]
  private var candidates: [[String: Any]] = []
  private var localAck = 0
  private var remoteAfter = 0
  private var exchange = 0
  private var pending: (id: Int, count: Int)?
  private var remoteSeen = Set<String>()
  private var exchangeUntil = Date.distantPast
  private var timer: Timer?
  private var iceTimer: Timer?
  private var disconnectTimer: Timer?
  private var statsTimer: Timer?
  private var statsBusy = false
  private var statsSample: (id: String, bytes: Double, time: Double)?
  private var offerSent = false
  private var frameReady = false
  private var pendingViewChallenge: String?
  private let diagnostics: Bool
  private let diagnosticStart = ProcessInfo.processInfo.systemUptime
  private var candidateCounts: [String: Int] = [:]
  private var configuredTurnCount = 0
  private var lastPairKinds: String?

  init(epoch: String, audio: Bool, trickle: Bool, net: [String: Any], diagnostics: Bool = false) {
    self.epoch = epoch
    self.audio = audio
    self.trickle = trickle
    self.net = net
    self.diagnostics = diagnostics
    super.init()
  }
  private func seconds(_ key: String, _ fallback: Double) -> Double {
    ((net[key] as? Double) ?? fallback) / 1000
  }
  func post(_ type: String, _ payload: [String: Any] = [:]) {
    guard !stopped else { return }
    emit(payload.merging(["type": type, "epoch": epoch, "attemptId": attempt]) { _, new in new })
  }
  // Fixed enums and counts only. No SDP, addresses, URLs or TURN credentials.
  private func diagnose(_ stage: String, _ fields: [String: Any] = [:]) {
    guard diagnostics else { return }
    var values: [String: Any] = ["stage": stage,
      "elapsedMs": Int((ProcessInfo.processInfo.systemUptime - diagnosticStart) * 1000),
      "turnUrlCount": configuredTurnCount, "localAck": localAck, "remoteAfter": remoteAfter,
      "trickleEnabled": trickle]
    for (key, count) in candidateCounts { values[key] = count }
    values.merge(fields) { _, new in new }
    post("rtcDiagnostic", values)
  }
  private func serverSummary(_ servers: [[String: Any]]) -> [String: Any] {
    let urls = servers.flatMap { ($0["urls"] as? [String]) ?? ($0["urls"] as? String).map { [$0] } ?? [] }
    return ["serverCount": servers.count,
      "turnUrlCount": urls.filter { $0.hasPrefix("turn:") || $0.hasPrefix("turns:") }.count]
  }
  private func countCandidate(_ sdp: String, side: String) {
    guard diagnostics else { return }
    let parts = sdp.split(whereSeparator: { $0.isWhitespace })
    let kind = parts.firstIndex(of: "typ").flatMap { $0 + 1 < parts.count ? String(parts[$0 + 1]) : nil } ?? "unknown"
    let safeKind = ["host", "srflx", "prflx", "relay"].contains(kind) ? kind : "unknown"
    let key = side + "_" + safeKind
    candidateCounts[key, default: 0] += 1
    // First occurrence proves each candidate kind was seen without a per-candidate log flood.
    if candidateCounts[key] == 1 { diagnose("candidate-kind") }
  }
  func begin(fallbackServers: [[String: Any]]) {
    post("iceConfig")
    diagnose("config-requested")
    timer = Timer.scheduledTimer(withTimeInterval: seconds("iceConfigMs", 8_000) + seconds("iceConfigBridgeMs", 500), repeats: false) { [weak self] _ in
      self?.diagnose("config-deadline")
      self?.start(servers: fallbackServers, source: "native-deadline")
    }
  }
  func receive(_ message: [String: Any]) {
    guard !stopped, message["epoch"] as? String == epoch,
          message["attemptId"] as? String == attempt else { return }
    switch message["type"] as? String {
    case "iceConfig":
      let servers = message["iceServers"] as? [[String: Any]] ?? []
      diagnose(peer == nil ? "config-received" : "config-late-ignored", serverSummary(servers))
      start(servers: servers, source: "bridge")
    case "answer":
      guard let peer, let sdp = message["sdp"] as? String, sdp.utf8.count <= 64_000 else { return }
      peer.setRemoteDescription(RTCSessionDescription(type: .answer, sdp: sdp)) { [weak self] error in
        DispatchQueue.main.async {
          guard let self, !self.stopped else { return }
          guard error == nil else { self.fail("answer"); return }
          self.diagnose("answer-applied")
          self.deadline(self.seconds("connectMs", 15_000), "connect-timeout")
          self.exchangeUntil = Date().addingTimeInterval(self.seconds("exchangeMs", 30_000))
          self.pollIce()
        }
      }
    case "ice": receiveIce(message)
    case "fallback": fail("host", retry: message["retry"] as? Bool != false)
    default: break
    }
  }
  private func start(servers: [[String: Any]], source: String) {
    guard !stopped, peer == nil else { return }
    timer?.invalidate()
    let config = RTCConfiguration()
    config.sdpSemantics = .unifiedPlan
    config.iceServers = servers.compactMap { server in
      let urls = (server["urls"] as? [String]) ?? (server["urls"] as? String).map { [$0] } ?? []
      guard !urls.isEmpty else { return nil }
      return RTCIceServer(urlStrings: urls, username: server["username"] as? String,
                         credential: server["credential"] as? String)
    }
    configuredTurnCount = serverSummary(servers)["turnUrlCount"] as? Int ?? 0
    diagnose("config-applied", ["source": source, "serverCount": config.iceServers.count])
    let constraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
    guard let rtc = Self.factory.peerConnection(with: config, constraints: constraints, delegate: self) else {
      fail("setup"); return
    }
    peer = rtc
    // Receive-only: never create microphone or camera capture tracks.
    let direction = RTCRtpTransceiverInit()
    direction.direction = .recvOnly
    rtc.addTransceiver(of: .video, init: direction)
    rtc.addTransceiver(of: .audio, init: direction)
    channel = rtc.dataChannel(forLabel: "input-v1", configuration: RTCDataChannelConfiguration())
    channel?.delegate = self
    rtc.offer(for: constraints) { [weak self] description, error in
      DispatchQueue.main.async {
        guard let self, !self.stopped else { return }
        guard let description, error == nil else { self.fail("offer"); return }
        rtc.setLocalDescription(description) { [weak self] error in
          DispatchQueue.main.async {
            guard let self, !self.stopped else { return }
            guard error == nil else { self.fail("offer"); return }
            if self.trickle || rtc.iceGatheringState == .complete { self.sendOffer() }
            else {
              self.timer = Timer.scheduledTimer(withTimeInterval: self.seconds("legacyGatherMs", 5_000), repeats: false) { [weak self] _ in self?.sendOffer() }
            }
          }
        }
      }
    }
    statsTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in self?.reportStats() }
  }
  private func sendOffer() {
    guard !stopped, !offerSent, let sdp = peer?.localDescription?.sdp else { return }
    offerSent = true
    diagnose("offer-sent")
    deadline(seconds("answerMs", 45_000), "answer-timeout")
    post("offer", ["sdp": sdp])
  }
  private func deadline(_ duration: Double, _ reason: String) {
    timer?.invalidate()
    timer = Timer.scheduledTimer(withTimeInterval: duration, repeats: false) { [weak self] _ in
      guard let self, self.peer?.connectionState != .connected else { return }
      self.fail(reason)
    }
  }
  private func pollIce() {
    guard !stopped, trickle, peer?.remoteDescription != nil, pending == nil,
          Date() < exchangeUntil else { return }
    let batch = Array(candidates.dropFirst(localAck).prefix(16))
    exchange += 1
    pending = (exchange, batch.count)
    diagnose("exchange-sent", ["exchangeId": exchange, "batchCount": batch.count])
    post("ice", ["candidates": batch, "after": remoteAfter, "exchangeId": exchange])
    scheduleIce(4.5)
  }
  private func scheduleIce(_ seconds: Double) {
    iceTimer?.invalidate()
    iceTimer = Timer.scheduledTimer(withTimeInterval: seconds, repeats: false) { [weak self] _ in
      self?.pending = nil
      self?.pollIce()
    }
  }
  private func receiveIce(_ message: [String: Any]) {
    guard let batch = pending,
          RemoteDesktopBridgeNumber.integer(message["exchangeId"]) == batch.id, let peer else { return }
    iceTimer?.invalidate()
    if message["error"] as? Bool == true { diagnose("exchange-error"); pending = nil; scheduleIce(1); return }
    guard let values = message["candidates"] as? [[String: Any]], values.count <= 16,
          let next = RemoteDesktopBridgeNumber.integer(message["next"]), next == remoteAfter + values.count, next <= 128 else {
      fail("candidates"); return
    }
    // WebRTC serializes addIceCandidate internally. Mark the batch complete only
    // after every callback, so an old exchange cannot acknowledge a newer batch.
    func add(_ index: Int) {
      guard !stopped, pending?.id == batch.id else { return }
      if index == values.count {
        localAck += batch.count
        remoteAfter = next
        pending = nil
        if batch.count > 0 || !values.isEmpty { diagnose("exchange-applied") }
        if !(message["complete"] as? Bool == true && peer.iceGatheringState == .complete && localAck == candidates.count) {
          scheduleIce(seconds("pollMs", 250))
        }
        return
      }
      let value = values[index]
      guard let sdp = value["candidate"] as? String, sdp.utf8.count <= 4096,
            let line = RemoteDesktopBridgeNumber.integer(value["sdpMLineIndex"]), line >= 0, line <= 65535 else {
        fail("candidates"); return
      }
      let key = "\(value["sdpMid"] as? String ?? ""):\(line):\(sdp)"
      if remoteSeen.contains(key) { add(index + 1); return }
      guard remoteSeen.count < 128 else { fail("candidates"); return }
      peer.add(RTCIceCandidate(sdp: sdp, sdpMLineIndex: Int32(line), sdpMid: value["sdpMid"] as? String)) { [weak self] error in
        DispatchQueue.main.async {
          guard let self, !self.stopped else { return }
          guard error == nil else { self.fail("candidates"); return }
          self.remoteSeen.insert(key)
          self.countCandidate(sdp, side: "remote")
          add(index + 1)
        }
      }
    }
    add(0)
  }
  func stop() {
    guard !stopped else { return }
    stopped = true
    pendingViewChallenge = nil
    for task in [timer, iceTimer, disconnectTimer, statsTimer] { task?.invalidate() }
    if let sink { track?.remove(sink) }
    sink?.onFrame = nil
    sink = nil
    track = nil
    audioTrack?.isEnabled = false
    audioTrack = nil
    channel?.delegate = nil
    channel?.close()
    channel = nil
    peer?.delegate = nil
    peer?.close()
    peer = nil
    emit = { _ in }
    onFrame = { _ in false }
  }
  func sendInput(_ message: [String: Any]) -> Bool {
    guard !stopped, !isPresenting(), UIApplication.shared.applicationState == .active,
          peer?.connectionState == .connected, let channel, channel.readyState == .open,
          channel.bufferedAmount < 16384, let sequence = RemoteDesktopBridgeNumber.integer(message["sequence"]), sequence >= 0,
          let events = message["events"] as? [[String: Any]], events.count <= 64,
          let data = try? JSONSerialization.data(withJSONObject: ["sequence": sequence, "events": events]),
          data.count <= 32_768 else { return false }
    return channel.sendData(RTCDataBuffer(data: data, isBinary: false))
  }
  private func fail(_ reason: String, retry: Bool = true) {
    diagnose("failed", ["reason": reason])
    post("fallback", ["reason": reason, "retry": retry])
    stop()
  }
  private func reportStats() {
    guard !stopped, !statsBusy, UIApplication.shared.applicationState == .active, let peer else { return }
    statsBusy = true
    peer.statistics { [weak self] report in
      DispatchQueue.main.async {
        guard let self, !self.stopped else { return }
        self.statsBusy = false
        let rows = Array(report.statistics.values)
        let pairID = rows.first(where: { $0.type == "transport" })?.values["selectedCandidatePairId"] as? String
        let pair = pairID.flatMap { report.statistics[$0] }
        let local = (pair?.values["localCandidateId"] as? String).flatMap { report.statistics[$0] }?.values["candidateType"] as? String
        let remote = (pair?.values["remoteCandidateId"] as? String).flatMap { report.statistics[$0] }?.values["candidateType"] as? String
        if let local, let remote {
          let kinds = local + "/" + remote
          if kinds != self.lastPairKinds {
            self.lastPairKinds = kinds
            self.diagnose("selected-pair", ["localKind": local, "remoteKind": remote])
          }
        }
        guard let video = rows.first(where: { $0.type == "inbound-rtp" && (($0.values["kind"] as? String) ?? ($0.values["mediaType"] as? String)) == "video" }) else { return }
        var data: [String: Any] = ["transport": local == "relay" || remote == "relay" ? "relay" : (local != nil && remote != nil ? "direct" : "video")]
        if let rtt = pair?.values["currentRoundTripTime"] as? Double { data["latencyMs"] = rtt * 1000 }
        if let bytes = video.values["bytesReceived"] as? Double {
          let time = video.timestamp_us / 1_000_000
          if let previous = self.statsSample, previous.id == video.id, time > previous.time, bytes >= previous.bytes {
            data["bytesPerSecond"] = (bytes - previous.bytes) / (time - previous.time)
          }
          self.statsSample = (video.id, bytes, time)
        }
        self.post("network", data)
      }
    }
  }
  func peerConnection(_ peerConnection: RTCPeerConnection, didGenerate candidate: RTCIceCandidate) {
    DispatchQueue.main.async { [weak self] in
      guard let self, !self.stopped else { return }
      self.countCandidate(candidate.sdp, side: "local")
      guard self.trickle else { return }
      guard self.candidates.count < 128 else { self.fail("candidate-limit", retry: false); return }
      var value: [String: Any] = ["candidate": candidate.sdp, "sdpMLineIndex": Int(candidate.sdpMLineIndex)]
      if let mid = candidate.sdpMid { value["sdpMid"] = mid }
      self.candidates.append(value)
    }
  }
  func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceGatheringState) {
    DispatchQueue.main.async { [weak self] in
      self?.diagnose("gathering", ["stateCode": newState.rawValue])
      if newState == .complete && self?.trickle == false { self?.sendOffer() }
    }
  }
  func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCPeerConnectionState) {
    DispatchQueue.main.async { [weak self] in
      guard let self, !self.stopped else { return }
      self.diagnose("connection", ["stateCode": newState.rawValue])
      if newState == .failed || newState == .closed { self.fail("transport") }
      else if newState == .disconnected {
        guard self.disconnectTimer == nil else { return }
        self.post("reconnecting")
        self.disconnectTimer = Timer.scheduledTimer(withTimeInterval: self.seconds("disconnectedMs", 5_000), repeats: false) { [weak self] _ in self?.fail("disconnected") }
      } else if newState == .connected {
        self.timer?.invalidate()
        self.disconnectTimer?.invalidate()
        self.disconnectTimer = nil
        if self.frameReady { self.post("streaming") }
      }
    }
  }
  func peerConnection(_ peerConnection: RTCPeerConnection, didStartReceivingOn transceiver: RTCRtpTransceiver) {
    DispatchQueue.main.async { [weak self] in
      guard let self, !self.stopped else { return }
      if let audio = transceiver.receiver.track as? RTCAudioTrack {
        self.audioTrack = audio
        audio.isEnabled = self.audio
      }
      guard let video = transceiver.receiver.track as? RTCVideoTrack else { return }
      if let sink = self.sink { self.track?.remove(sink) }
      let sink = RemoteDesktopFrameSink()
      sink.onFrame = { [weak self] frame in
        guard let self, !self.stopped else { return }
        guard self.onFrame(frame) else { return }
        if !self.frameReady {
          self.frameReady = true
          self.diagnose("first-frame")
          self.post("videoFrameReady")
          self.post("streaming")
        }
      }
      self.sink = sink
      self.track = video
      video.add(sink)
    }
  }
  func dataChannel(_ dataChannel: RTCDataChannel, didReceiveMessageWith buffer: RTCDataBuffer) {
    guard !buffer.isBinary, buffer.data.count <= 80_000 else { return }
    DispatchQueue.main.async { [weak self] in
      guard let self, !self.stopped, self.channel === dataChannel,
            let message = try? JSONSerialization.jsonObject(with: buffer.data) as? [String: Any] else { return }
      if message["type"] as? String == "viewPing",
         let challenge = message["challenge"] as? String, challenge.utf8.count <= 64,
         dataChannel.readyState == .open {
        // The host keeps one outstanding challenge. It can arrive before PiP
        // starts, so retain it until AVKit confirms actual presentation.
        self.pendingViewChallenge = challenge
        self.replyToViewChallenge()
      } else if message["type"] as? String == "cursor", UIApplication.shared.applicationState == .active {
        self.post("nativeCursor", ["cursor": message["cursor"] ?? NSNull()])
      }
    }
  }
  func replyToViewChallenge() {
    guard !stopped, isPresenting(), isPresentationAuthorized(), let challenge = pendingViewChallenge,
          let channel, channel.readyState == .open else { return }
    if channel.sendData(RTCDataBuffer(data: Data(challenge.utf8), isBinary: false)) {
      pendingViewChallenge = nil
    }
  }
  func dataChannelDidChangeState(_ dataChannel: RTCDataChannel) {}
  func peerConnection(_ peerConnection: RTCPeerConnection, didChange stateChanged: RTCSignalingState) {}
  func peerConnection(_ peerConnection: RTCPeerConnection, didAdd stream: RTCMediaStream) {}
  func peerConnection(_ peerConnection: RTCPeerConnection, didRemove stream: RTCMediaStream) {}
  func peerConnectionShouldNegotiate(_ peerConnection: RTCPeerConnection) {}
  func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceConnectionState) {
    DispatchQueue.main.async { [weak self] in self?.diagnose("ice-state", ["stateCode": newState.rawValue]) }
  }
  func peerConnection(_ peerConnection: RTCPeerConnection, didFailToGatherIceCandidate event: RTCIceCandidateErrorEvent) {
    let code = event.errorCode
    let kind = event.url.hasPrefix("turns:") ? "turns" : (event.url.hasPrefix("turn:") ? "turn" : "stun")
    let transport = event.url.hasPrefix("turns:") ? "tls" : (event.url.contains("transport=tcp") ? "tcp" : "udp")
    DispatchQueue.main.async { [weak self] in
      self?.diagnose("ice-error", ["errorCode": code, "serverKind": kind, "transportKind": transport])
    }
  }
  func peerConnection(_ peerConnection: RTCPeerConnection, didRemove candidates: [RTCIceCandidate]) {}
  func peerConnection(_ peerConnection: RTCPeerConnection, didOpen dataChannel: RTCDataChannel) {}
}

/// A single-slot mailbox prevents decode callbacks from building a main-queue
/// frame backlog. The native receiver still consumes frames while JS is suspended.
private final class RemoteDesktopFrameSink: NSObject, RTCVideoRenderer {
  var onFrame: ((RTCVideoFrame) -> Void)?
  private let lock = NSLock()
  private var latest: RTCVideoFrame?
  private var queued = false
  func setSize(_ size: CGSize) {}
  func renderFrame(_ frame: RTCVideoFrame?) {
    guard let frame else { return }
    lock.lock()
    latest = frame
    if queued { lock.unlock(); return }
    queued = true
    lock.unlock()
    DispatchQueue.main.async { [weak self] in
      guard let self else { return }
      self.lock.lock()
      let frame = self.latest
      self.latest = nil
      self.queued = false
      self.lock.unlock()
      if let frame { self.onFrame?(frame) }
    }
  }
}
