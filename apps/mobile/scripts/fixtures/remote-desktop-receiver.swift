// Test-only framework doubles. SDP/ICE completions are explicitly controlled;
// production Timer and DispatchQueue behavior is exercised using the run loop.
final class UIApplication {
  enum State { case active, background }
  static let shared = UIApplication()
  var applicationState = State.active
}
func RTCInitializeSSL() {}
protocol RTCPeerConnectionDelegate: AnyObject {}
protocol RTCDataChannelDelegate: AnyObject {}
protocol RTCVideoRenderer: AnyObject {
  func setSize(_ size: CGSize)
  func renderFrame(_ frame: RTCVideoFrame?)
}
final class RTCDefaultVideoEncoderFactory {}
final class RTCDefaultVideoDecoderFactory {}
final class RTCPeerConnectionFactory {
  static var latest: RTCPeerConnection!
  init(encoderFactory: RTCDefaultVideoEncoderFactory, decoderFactory: RTCDefaultVideoDecoderFactory) {}
  func peerConnection(with: RTCConfiguration, constraints: RTCMediaConstraints, delegate: RTCPeerConnectionDelegate) -> RTCPeerConnection? {
    let peer = RTCPeerConnection(); peer.delegate = delegate; Self.latest = peer; return peer
  }
}
enum RTCSignalingState { case stable }
enum RTCIceConnectionState { case connected }
enum RTCIceGatheringState { case gathering, complete }
enum RTCPeerConnectionState { case new, connected, disconnected, failed, closed }
final class RTCConfiguration {
  enum Semantics { case unifiedPlan }
  var sdpSemantics = Semantics.unifiedPlan
  var iceServers: [RTCIceServer] = []
}
final class RTCIceServer {
  init(urlStrings: [String], username: String?, credential: String?) {}
}
final class RTCMediaConstraints {
  init(mandatoryConstraints: [String: String]?, optionalConstraints: [String: String]?) {}
}
final class RTCSessionDescription {
  enum Kind { case offer, answer }
  let sdp: String
  init(type: Kind, sdp: String) { self.sdp = sdp }
}
final class RTCRtpTransceiverInit {
  enum Direction { case recvOnly }
  var direction = Direction.recvOnly
}
class RTCMediaStreamTrack {}
final class RTCAudioTrack: RTCMediaStreamTrack { var isEnabled = false }
final class RTCVideoFrame {}
final class RTCVideoTrack: RTCMediaStreamTrack {
  var sink: RTCVideoRenderer?
  func add(_ sink: RTCVideoRenderer) { self.sink = sink }
  func remove(_ sink: RTCVideoRenderer) { self.sink = nil }
}
final class RTCRtpTransceiver {
  final class Receiver { var track: RTCMediaStreamTrack? }
  let receiver = Receiver()
}
final class RTCMediaStream {}
final class RTCDataChannelConfiguration {}
final class RTCDataBuffer {
  let data: Data; let isBinary: Bool
  init(data: Data, isBinary: Bool) { self.data = data; self.isBinary = isBinary }
}
final class RTCDataChannel {
  enum State { case open, closed }
  weak var delegate: RTCDataChannelDelegate?
  var readyState = State.open
  var bufferedAmount = 0
  var sent: [Data] = []
  var closes = 0
  func sendData(_ data: RTCDataBuffer) -> Bool { sent.append(data.data); return true }
  func close() { closes += 1; readyState = .closed }
}
final class RTCIceCandidate {
  let sdp: String; let sdpMLineIndex: Int32; let sdpMid: String?
  init(sdp: String, sdpMLineIndex: Int32, sdpMid: String?) {
    self.sdp = sdp; self.sdpMLineIndex = sdpMLineIndex; self.sdpMid = sdpMid
  }
}
final class RTCStatistics {
  var type = ""; var values: [String: Any] = [:]; var timestamp_us = 0.0; var id = ""
}
final class RTCStatisticsReport { var statistics: [String: RTCStatistics] = [:] }
final class RTCPeerConnection {
  enum Media { case video, audio }
  weak var delegate: RTCPeerConnectionDelegate?
  var localDescription: RTCSessionDescription?
  var remoteDescription: RTCSessionDescription?
  var iceGatheringState = RTCIceGatheringState.complete
  var connectionState = RTCPeerConnectionState.new
  let channel = RTCDataChannel()
  var offerCallback: ((RTCSessionDescription?, Error?) -> Void)?
  var answerCallback: ((Error?) -> Void)?
  var candidateCallbacks: [(Error?) -> Void] = []
  var closes = 0
  var answers = 0
  func addTransceiver(of: Media, init: RTCRtpTransceiverInit) {}
  func dataChannel(forLabel: String, configuration: RTCDataChannelConfiguration) -> RTCDataChannel? { channel }
  func offer(for: RTCMediaConstraints, completionHandler: @escaping (RTCSessionDescription?, Error?) -> Void) { offerCallback = completionHandler }
  func setLocalDescription(_ description: RTCSessionDescription, completionHandler: @escaping (Error?) -> Void) { localDescription = description; completionHandler(nil) }
  func setRemoteDescription(_ description: RTCSessionDescription, completionHandler: @escaping (Error?) -> Void) { answers += 1; remoteDescription = description; answerCallback = completionHandler }
  func add(_ candidate: RTCIceCandidate, completionHandler: @escaping (Error?) -> Void) { candidateCallbacks.append(completionHandler) }
  func statistics(_ completionHandler: @escaping (RTCStatisticsReport) -> Void) { completionHandler(RTCStatisticsReport()) }
  func close() { closes += 1; connectionState = .closed }
}

@main
struct ReceiverTests {
  static func drain(_ seconds: Double = 0.02) { RunLoop.main.run(until: Date().addingTimeInterval(seconds)) }
  static func main() {
    func message(_ receiver: RemoteDesktopReceiver, _ type: String, _ data: [String: Any] = [:]) -> [String: Any] {
      data.merging(["type": type, "epoch": receiver.epoch, "attemptId": receiver.attempt]) { _, value in value }
    }
    func start() -> (RemoteDesktopReceiver, RTCPeerConnection) {
      let receiver = RemoteDesktopReceiver(epoch: "lease", audio: false, trickle: true, net: ["disconnectedMs": 30.0])
      receiver.receive(message(receiver, "iceConfig"))
      return (receiver, RTCPeerConnectionFactory.latest)
    }
    // A replacement attempt must reject SDP and ICE from its predecessor.
    let (old, oldPeer) = start()
    old.stop(); old.stop()
    assert(oldPeer.closes == 1 && oldPeer.channel.closes == 1)
    let (current, peer) = start()
    current.receive(message(old, "answer", ["sdp": "stale"]))
    current.receive(message(old, "fallback"))
    assert(peer.answers == 0 && peer.closes == 0)
    var events: [String] = []
    current.emit = { events.append($0["type"] as! String) }
    oldPeer.offerCallback?(RTCSessionDescription(type: .offer, sdp: "late"), nil)
    drain()
    assert(events.isEmpty && oldPeer.localDescription == nil)
    // Late answer completion and disconnect timer cannot revive stopped media.
    current.receive(message(current, "answer", ["sdp": "answer"]))
    current.peerConnection(peer, didChange: RTCPeerConnectionState.disconnected)
    drain()
    current.stop(); let count = events.count
    peer.answerCallback?(nil); drain(0.06)
    assert(events.count == count && peer.closes == 1)

    let (ice, icePeer) = start()
    var iceEvents: [[String: Any]] = []
    ice.emit = { iceEvents.append($0) }
    ice.receive(message(ice, "answer", ["sdp": "answer"]))
    icePeer.answerCallback?(nil); drain()
    let exchange = iceEvents.first { $0["type"] as? String == "ice" }!["exchangeId"] as! Int
    let candidate: [String: Any] = ["candidate": "candidate:one", "sdpMLineIndex": 0]
    ice.receive(message(old, "ice", ["exchangeId": exchange, "candidates": [candidate], "next": 1]))
    assert(icePeer.candidateCallbacks.isEmpty)
    ice.receive(message(ice, "ice", ["exchangeId": exchange + 1, "candidates": [candidate], "next": 1]))
    assert(icePeer.candidateCallbacks.isEmpty)
    ice.receive(message(ice, "ice", ["exchangeId": exchange, "candidates": [candidate], "next": 1]))
    assert(icePeer.candidateCallbacks.count == 1)
    ice.stop(); let iceCount = iceEvents.count
    icePeer.candidateCallbacks[0](nil); drain()
    assert(iceEvents.count == iceCount)

    // A decoder frame already queued when stop occurs must not announce readiness.
    let (frames, framePeer) = start()
    let transceiver = RTCRtpTransceiver()
    let track = RTCVideoTrack()
    transceiver.receiver.track = track
    var rendered = 0
    frames.onFrame = { _ in rendered += 1; return true }
    frames.peerConnection(framePeer, didStartReceivingOn: transceiver); drain()
    let sink = track.sink!
    sink.renderFrame(RTCVideoFrame()); drain()
    assert(rendered == 1)
    sink.renderFrame(RTCVideoFrame())
    frames.stop(); drain()
    assert(rendered == 1 && track.sink == nil)

    // Challenges require BOTH actual PiP and current authorization; stop clears it.
    let (view, viewPeer) = start()
    var presenting = false; var authorized = false
    view.isPresenting = { presenting }; view.isPresentationAuthorized = { authorized }
    UIApplication.shared.applicationState = .background
    let ping = RTCDataBuffer(data: Data("{\"type\":\"viewPing\",\"challenge\":\"nonce\"}".utf8), isBinary: false)
    view.dataChannel(viewPeer.channel, didReceiveMessageWith: ping); drain()
    assert(viewPeer.channel.sent.isEmpty)
    authorized = true; view.replyToViewChallenge(); assert(viewPeer.channel.sent.isEmpty)
    authorized = false
    presenting = true; view.replyToViewChallenge(); assert(viewPeer.channel.sent.isEmpty)
    authorized = true; view.replyToViewChallenge(); view.replyToViewChallenge()
    assert(viewPeer.channel.sent == [Data("nonce".utf8)])
    authorized = false; view.dataChannel(viewPeer.channel, didReceiveMessageWith: ping); drain()
    view.stop(); authorized = true; view.replyToViewChallenge()
    assert(viewPeer.channel.sent.count == 1)
    UIApplication.shared.applicationState = .active

    // Recovery cancels the disconnect deadline; an unrecovered disconnect fails once.
    let (recovered, recoveredPeer) = start()
    recovered.peerConnection(recoveredPeer, didChange: RTCPeerConnectionState.disconnected)
    recoveredPeer.connectionState = .connected
    recovered.peerConnection(recoveredPeer, didChange: RTCPeerConnectionState.connected); drain(0.06)
    assert(recoveredPeer.closes == 0); recovered.stop()
    let (failed, failedPeer) = start()
    var failures = 0
    failed.emit = { if $0["type"] as? String == "fallback" { failures += 1 } }
    failed.peerConnection(failedPeer, didChange: RTCPeerConnectionState.disconnected); drain(0.08)
    assert(failures == 1 && failedPeer.closes == 1)
    failed.stop(); assert(failedPeer.closes == 1)
    print("Receiver lifecycle tests passed")
  }
}
