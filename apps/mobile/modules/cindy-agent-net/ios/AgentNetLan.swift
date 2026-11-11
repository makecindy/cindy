import Foundation
import Darwin

/// System Bonjour avoids a custom multicast entitlement. Records contain only
/// signed, public addressing; JavaScript verifies the pinned device certificate
/// before passing a candidate to the native Noise endpoint.
final class AgentNetLan: NSObject, NetServiceDelegate, NetServiceBrowserDelegate {
  private let browser = NetServiceBrowser()
  private let service: NetService
  private let emit: ([String: Any]) -> Void
  private let id: String
  private var peers: [String: NetService] = [:]
  private var closed = false
  init(id: String, port: Int, txt: [String: Data], emit: @escaping ([String: Any]) -> Void) {
    self.id = id; self.emit = emit
    service = NetService(domain: "local.", type: "_cindy-agentnet._udp.", name: "cindy-" + id, port: Int32(port))
    super.init()
    service.setTXTRecord(NetService.data(fromTXTRecord: txt))
    service.delegate = self; browser.delegate = self
    service.publish(); browser.searchForServices(ofType: "_cindy-agentnet._udp.", inDomain: "local.")
  }
  func update(_ txt: [String: Data]) { if !closed { service.setTXTRecord(NetService.data(fromTXTRecord: txt)) } }
  func close() {
    if closed { return }; closed = true
    browser.stop(); browser.delegate = nil; service.stop(); service.delegate = nil
    for peer in peers.values { peer.stopMonitoring(); peer.stop(); peer.delegate = nil }
    peers.removeAll()
  }
  func netServiceBrowser(_ browser: NetServiceBrowser, didFind peer: NetService, moreComing: Bool) {
    guard !closed, peer.name != service.name, peer.name.hasPrefix("cindy-"), peer.name.utf8.count <= 128,
          peers.count < 128, peers[peer.name] == nil else { return }
    peers[peer.name] = peer; peer.delegate = self; peer.resolve(withTimeout: 3); peer.startMonitoring()
  }
  func netServiceBrowser(_ browser: NetServiceBrowser, didRemove peer: NetService, moreComing: Bool) {
    if let previous = peers.removeValue(forKey: peer.name) { previous.stopMonitoring(); previous.stop(); previous.delegate = nil }
  }
  func netServiceDidResolveAddress(_ sender: NetService) { deliver(sender) }
  func netService(_ sender: NetService, didUpdateTXTRecord data: Data) { deliver(sender) }
  private func deliver(_ peer: NetService) {
    guard !closed, peer.port > 0, peer.port <= 65535, let data = peer.txtRecordData(), data.count <= 2048 else { return }
    let record = NetService.dictionary(fromTXTRecord: data)
    guard record.count <= 8 else { return }
    var txt: [String: String] = [:]
    for (key, value) in record {
      guard key.utf8.count <= 8, value.count <= 200, let text = String(data: value, encoding: .ascii) else { return }
      txt[key] = text
    }
    let addresses = (peer.addresses ?? []).prefix(16).compactMap { data -> String? in
      data.withUnsafeBytes { raw -> String? in
        guard raw.count >= MemoryLayout<sockaddr>.size, let address = raw.bindMemory(to: sockaddr.self).baseAddress else { return nil }
        var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
        guard getnameinfo(address, socklen_t(raw.count), &host, socklen_t(host.count), nil, 0, NI_NUMERICHOST) == 0 else { return nil }
        return String(cString: host)
      }
    }
    if !addresses.isEmpty { emit(["id": id, "port": peer.port, "addresses": addresses, "txt": txt]) }
  }
}
