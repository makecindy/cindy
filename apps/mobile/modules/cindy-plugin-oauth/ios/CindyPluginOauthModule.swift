import ExpoModulesCore
import Network

struct PluginOauthListenerOptions: Record {
  @Field var id: String = ""
  @Field var callbackUrl: String = ""
  @Field var state: String = ""
  @Field var expiresAt: Double = 0
}

public class CindyPluginOauthModule: Module {
  private let queue = DispatchQueue(label: "cindy.plugin-oauth")
  private var listeners: [String: PluginOauthListener] = [:]
  public func definition() -> ModuleDefinition {
    Name("CindyPluginOauth")
    AsyncFunction("start") { (options: PluginOauthListenerOptions, promise: Promise) in
      do {
        guard self.listeners.isEmpty else { throw PluginOauthListener.Failure.invalid }
        let listener = try PluginOauthListener(options, queue: self.queue)
        self.listeners[options.id] = listener
        listener.start { ok in
          if ok { promise.resolve(nil) }
          else {
            self.listeners.removeValue(forKey: options.id)?.close()
            promise.reject("PLUGIN_OAUTH_LISTEN_FAILED", "Unable to bind callback listener")
          }
        }
      } catch { promise.reject("PLUGIN_OAUTH_LISTEN_FAILED", "Unable to bind callback listener") }
    }.runOnQueue(queue)
    AsyncFunction("wait") { (id: String, promise: Promise) in
      guard let listener = self.listeners[id] else {
        promise.reject("PLUGIN_OAUTH_CLOSED", "Authorization listener is closed"); return
      }
      listener.wait(promise)
    }.runOnQueue(queue)
    AsyncFunction("status") { (id: String) -> String in self.listeners[id]?.status() ?? "closed" }.runOnQueue(queue)
    AsyncFunction("close") { (id: String) in self.listeners.removeValue(forKey: id)?.close() }.runOnQueue(queue)
    OnDestroy { self.queue.async { self.closeAll() } }
  }
  private func closeAll() {
    let active = listeners.values
    listeners.removeAll()
    active.forEach { $0.close() }
  }
}

private final class PluginOauthListener {
  enum Failure: Error { case invalid }
  private let listener: NWListener
  private let queue: DispatchQueue
  private let options: PluginOauthListenerOptions
  private let path: String
  private let host: String
  private var clients: [UUID: NWConnection] = [:]
  private var pending: Promise?
  private var result: [String: String]?
  private var closed = false
  private var consumed = false
  private var deadline: DispatchWorkItem?
  init(_ options: PluginOauthListenerOptions, queue: DispatchQueue) throws {
    let now = Date().timeIntervalSince1970 * 1000
    guard options.id.range(of: "^[A-Za-z0-9_-]{16,128}$", options: .regularExpression) != nil,
      options.state.range(of: "^[A-Za-z0-9._~-]{16,512}$", options: .regularExpression) != nil,
      options.expiresAt > now, options.expiresAt <= now + 600_000,
      let url = URLComponents(string: options.callbackUrl), url.scheme == "http", url.host == "127.0.0.1",
      let port = url.port, (1024...65535).contains(port), url.user == nil, url.password == nil,
      url.query == nil, url.fragment == nil, url.path.utf8.count <= 256,
      url.path.range(of: "^/[A-Za-z0-9._~/-]*$", options: .regularExpression) != nil,
      options.callbackUrl == "http://127.0.0.1:\(port)\(url.path)"
    else { throw Failure.invalid }
    self.options = options; self.queue = queue; path = url.path; host = "127.0.0.1:\(port)"
    let parameters = NWParameters.tcp
    parameters.allowLocalEndpointReuse = false
    parameters.requiredLocalEndpoint = .hostPort(host: .ipv4(.loopback), port: NWEndpoint.Port(rawValue: UInt16(port))!)
    listener = try NWListener(using: parameters)
  }
  func start(_ ready: @escaping (Bool) -> Void) {
    var settled = false
    listener.stateUpdateHandler = { state in
      if !settled {
        if case .ready = state { settled = true; ready(true) }
        else if case .failed = state { settled = true; ready(false) }
        else if case .cancelled = state { settled = true; ready(false) }
      }
    }
    listener.newConnectionHandler = { [weak self] connection in
      guard let self, !self.closed, self.result == nil, self.clients.count < 8 else { connection.cancel(); return }
      let id = UUID(); self.clients[id] = connection
      connection.start(queue: self.queue)
      self.queue.asyncAfter(deadline: .now() + 5) { [weak self] in self?.clients.removeValue(forKey: id)?.cancel() }
      self.receive(id, Data())
    }
    let timeout = DispatchWorkItem { [weak self] in self?.close() }
    deadline = timeout
    queue.asyncAfter(deadline: .now() + max(0, (options.expiresAt - Date().timeIntervalSince1970 * 1000) / 1000), execute: timeout)
    listener.start(queue: queue)
  }
  func status() -> String { result != nil ? "received" : closed ? "closed" : "waiting" }
  func wait(_ promise: Promise) {
    guard !consumed, pending == nil else { promise.reject("PLUGIN_OAUTH_CLOSED", "Authorization listener is closed"); return }
    if let result { consumed = true; promise.resolve(result) }
    else if closed { promise.reject("PLUGIN_OAUTH_CLOSED", "Authorization listener is closed") }
    else { pending = promise }
  }
  func close() {
    closed = true; deadline?.cancel(); listener.cancel()
    clients.values.forEach { $0.cancel() }; clients.removeAll()
    pending?.reject("PLUGIN_OAUTH_CLOSED", "Authorization listener is closed"); pending = nil
    result = nil
  }
  private func receive(_ id: UUID, _ previous: Data) {
    clients[id]?.receive(minimumIncompleteLength: 1, maximumLength: 4096) { [weak self] data, _, ended, error in
      guard let self, !self.closed, self.result == nil else { return }
      var bytes = previous; if let data { bytes.append(data) }
      if bytes.count > 16384 { self.respond(id, status: 400); return }
      if let boundary = bytes.range(of: Data("\r\n\r\n".utf8)) {
        guard boundary.upperBound == bytes.endIndex, let text = String(data: bytes, encoding: .utf8),
          let value = self.parse(text) else { self.respond(id, status: 400); return }
        self.result = value
        self.listener.cancel()
        self.respond(id, status: 200)
        for other in Array(self.clients.keys) where other != id { self.clients.removeValue(forKey: other)?.cancel() }
        if let pending = self.pending { self.consumed = true; self.pending = nil; pending.resolve(value) }
      } else if ended || error != nil { self.clients.removeValue(forKey: id)?.cancel() }
      else { self.receive(id, bytes) }
    }
  }
  private func parse(_ text: String) -> [String: String]? {
    guard Date().timeIntervalSince1970 * 1000 < options.expiresAt else { return nil }
    let lines = text.components(separatedBy: "\r\n")
    let request = (lines.first ?? "").split(separator: " ", omittingEmptySubsequences: false)
    guard request.count == 3, request[0] == "GET", ["HTTP/1.1", "HTTP/1.0"].contains(String(request[2])),
      request[1].utf8.count <= 8192, request[1].hasPrefix(path + "?"),
      let url = URLComponents(string: "http://" + host + String(request[1])), url.path == path, url.fragment == nil
    else { return nil }
    var headers: [String: String] = [:]
    for line in lines.dropFirst() where !line.isEmpty {
      guard let colon = line.firstIndex(of: ":") else { return nil }
      let name = line[..<colon].lowercased()
      guard headers[name] == nil else { return nil }
      headers[name] = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
    }
    guard headers["host"] == host, headers["origin"] == nil, headers["transfer-encoding"] == nil,
      headers["content-length"] == nil || headers["content-length"] == "0" else { return nil }
    var params: [String: String] = [:]
    for item in url.queryItems ?? [] {
      guard params[item.name] == nil, let value = item.value, value.utf8.count <= 4096 else { return nil }
      params[item.name] = value
    }
    guard params["state"] == options.state, (params["code"] != nil) != (params["error"] != nil) else { return nil }
    let key = params["code"] != nil ? "code" : "error"
    guard let value = params[key], !value.isEmpty, !value.unicodeScalars.contains(where: { $0.value < 32 }) else { return nil }
    if key == "error", value.range(of: "^[A-Za-z0-9_.-]{1,128}$", options: .regularExpression) == nil { return nil }
    return ["state": options.state, key: value]
  }
  private func respond(_ id: UUID, status: Int) {
    let body = status == 200 ? "Authorization received. Return to Cindy." : "Invalid callback."
    let response = "HTTP/1.1 \(status) \(status == 200 ? "OK" : "Bad Request")\r\nContent-Type: text/plain; charset=utf-8\r\nCache-Control: no-store\r\nContent-Security-Policy: default-src 'none'\r\nConnection: close\r\nContent-Length: \(body.utf8.count)\r\n\r\n\(body)"
    clients[id]?.send(content: Data(response.utf8), completion: .contentProcessed { [weak self] _ in self?.clients.removeValue(forKey: id)?.cancel() })
  }
}
