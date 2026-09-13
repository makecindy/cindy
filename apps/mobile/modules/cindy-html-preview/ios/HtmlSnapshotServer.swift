import Foundation
import Network

/// Intentionally HTTP/1 GET/HEAD only: one bounded request per connection, no uploads or listing.
/// Only the immutable manifest is addressable. All state runs on the supplied serial queue.
final class HtmlSnapshotServer {
  enum Failure: Error { case invalid, stopped }
  private let listener: NWListener
  private let queue: DispatchQueue
  private let root: URL
  private let entry: String
  private let token: String
  private let csp: String
  private var assets: [String: (URL, String)] = [:]
  private var clients: [UUID: NWConnection] = [:]
  private var completion: ((Result<String, Error>) -> Void)?
  private var stopped = false
  private var origin: String { "http://127.0.0.1:\(listener.port?.rawValue ?? 0)" }

  init(root: String, entry: String, token: String, csp: String, files: [[String]], queue: DispatchQueue) throws {
    guard token.range(of: "^[a-f0-9]{48}$", options: .regularExpression) != nil,
      !csp.contains("\r"), !csp.contains("\n"), files.count <= 2000 else { throw Failure.invalid }
    self.queue = queue
    self.root = URL(fileURLWithPath: root).resolvingSymlinksInPath()
    self.entry = entry
    self.token = token
    self.csp = csp
    for file in files {
      guard file.count == 3, file[1].range(of: "^[0-9]+$", options: .regularExpression) != nil,
        file[2].range(of: "^[a-z]+/[a-z0-9.+-]+$", options: .regularExpression) != nil,
        !file[0].split(separator: "/", omittingEmptySubsequences: false).contains(where: { $0.isEmpty || $0.hasPrefix(".") }),
        !file[0].contains("\\"), !file[0].contains("\0"), assets["/" + file[0]] == nil
      else { throw Failure.invalid }
      let url = self.root.appendingPathComponent(file[1])
      let values = try url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey])
      guard values.isRegularFile == true, values.isSymbolicLink != true else { throw Failure.invalid }
      assets["/" + file[0]] = (url, file[2])
    }
    guard assets["/" + entry]?.1 == "text/html" else { throw Failure.invalid }
    let params = NWParameters.tcp
    params.requiredLocalEndpoint = .hostPort(host: .ipv4(.loopback), port: .any)
    listener = try NWListener(using: params)
  }

  func start(_ completion: @escaping (Result<String, Error>) -> Void) {
    self.completion = completion
    listener.stateUpdateHandler = { [weak self] state in
      guard let self else { return }
      switch state {
      case .ready: self.finish(.success(self.origin + "/__cindy/" + self.token))
      case .failed(let error): self.finish(.failure(error)); self.stop()
      case .cancelled: self.finish(.failure(Failure.stopped))
      default: break
      }
    }
    listener.newConnectionHandler = { [weak self] connection in self?.accept(connection) }
    listener.start(queue: queue)
    queue.asyncAfter(deadline: .now() + 10) { [weak self] in
      if self?.completion != nil { self?.finish(.failure(Failure.stopped)); self?.stop() }
    }
  }

  private func finish(_ result: Result<String, Error>) {
    let callback = completion
    completion = nil
    callback?(result)
  }

  func stop() {
    guard !stopped else { return }
    stopped = true
    listener.cancel()
    clients.values.forEach { $0.cancel() }
    clients.removeAll()
    finish(.failure(Failure.stopped))
  }

  private func accept(_ connection: NWConnection) {
    guard !stopped, clients.count < 16 else { connection.cancel(); return }
    let id = UUID()
    clients[id] = connection
    connection.start(queue: queue)
    // Covers slow headers and stalled response readers. Resources are local, no indefinite sockets.
    queue.asyncAfter(deadline: .now() + 15) { [weak self] in self?.close(id) }
    receive(id, Data())
  }

  private func close(_ id: UUID) { clients.removeValue(forKey: id)?.cancel() }

  private func receive(_ id: UUID, _ previous: Data) {
    clients[id]?.receive(minimumIncompleteLength: 1, maximumLength: 4096) { [weak self] data, _, ended, error in
      guard let self, self.clients[id] != nil else { return }
      var bytes = previous
      if let data { bytes.append(data) }
      guard bytes.count <= 16384, error == nil else { self.close(id); return }
      if let end = bytes.range(of: Data("\r\n\r\n".utf8)) {
        self.respond(id, String(data: bytes[..<end.lowerBound], encoding: .utf8) ?? "")
      } else if ended { self.close(id) } else { self.receive(id, bytes) }
    }
  }

  private func respond(_ id: UUID, _ request: String) {
    let lines = request.components(separatedBy: "\r\n")
    let first = (lines.first ?? "").components(separatedBy: " ")
    guard first.count == 3, ["GET", "HEAD"].contains(first[0]),
      ["HTTP/1.0", "HTTP/1.1"].contains(first[2]), first[1].hasPrefix("/"), !first[1].hasPrefix("//")
    else { send(id, status: 400); return }
    var headers: [String: String] = [:]
    for line in lines.dropFirst() {
      guard let colon = line.firstIndex(of: ":") else { send(id, status: 400); return }
      let key = String(line[..<colon]).lowercased()
      guard !key.isEmpty, key.trimmingCharacters(in: .whitespaces) == key, headers[key] == nil else { send(id, status: 400); return }
      headers[key] = String(line[line.index(after: colon)...]).trimmingCharacters(in: .whitespaces)
    }
    guard headers["host"] == String(origin.dropFirst(7)),
      headers["origin"] == nil || headers["origin"] == origin,
      headers["sec-fetch-site"] != "cross-site",
      headers["referer"] == nil || headers["referer"]!.hasPrefix(origin + "/"),
      headers["transfer-encoding"] == nil, headers["content-length"] == nil || headers["content-length"] == "0"
    else { send(id, status: 403); return }
    let rawPath = first[1].components(separatedBy: "?")[0]
    if rawPath == "/__cindy/" + token {
      let unreserved = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")
      let escaped = entry.split(separator: "/").map { String($0).addingPercentEncoding(withAllowedCharacters: unreserved)! }.joined(separator: "/")
      send(id, status: 302, extra: "Set-Cookie: cindy_\(token)=\(token); HttpOnly; SameSite=Strict; Path=/\r\nLocation: /\(escaped)\r\n")
      return
    }
    guard headers["cookie"]?.components(separatedBy: ";").map({ $0.trimmingCharacters(in: .whitespaces) }).contains("cindy_\(token)=\(token)") == true,
      var path = rawPath.removingPercentEncoding, !path.contains("\\"), !path.contains("\0"),
      !path.split(separator: "/").contains(where: { $0 == "." || $0 == ".." })
    else { send(id, status: 403); return }
    if path.hasSuffix("/") { path += "index.html" }
    guard let (url, mime) = assets[path],
      let values = try? url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey]),
      values.isRegularFile == true, values.isSymbolicLink != true, let size = values.fileSize,
      let file = try? FileHandle(forReadingFrom: url)
    else { send(id, status: 404); return }
    // HTML was decoded and guarded before publication, and is now always UTF-8.
    let contentType = mime == "text/html" ? "text/html; charset=utf-8" : mime
    let head = responseHead(200, length: size, extra: "Content-Type: \(contentType)\r\n")
    clients[id]?.send(content: Data(head.utf8), completion: .contentProcessed { [weak self] error in
      guard let self else { try? file.close(); return }
      if error != nil || first[0] == "HEAD" { try? file.close(); self.close(id) }
      else { self.stream(id, file) }
    })
  }

  private func responseHead(_ status: Int, length: Int = 0, extra: String = "") -> String {
    "HTTP/1.1 \(status) \(status == 200 ? "OK" : status == 302 ? "Found" : "Error")\r\nConnection: close\r\nContent-Length: \(length)\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nContent-Security-Policy: \(csp)\r\nPermissions-Policy: camera=(), microphone=(), geolocation=()\r\nReferrer-Policy: no-referrer\r\n\(extra)\r\n"
  }

  private func send(_ id: UUID, status: Int, extra: String = "") {
    clients[id]?.send(content: Data(responseHead(status, extra: extra).utf8), completion: .contentProcessed { [weak self] _ in self?.close(id) })
  }

  private func stream(_ id: UUID, _ file: FileHandle) {
    guard let connection = clients[id], let data = try? file.read(upToCount: 65536), !data.isEmpty else {
      try? file.close(); close(id); return
    }
    connection.send(content: data, completion: .contentProcessed { [weak self] error in
      guard let self, error == nil else { try? file.close(); self?.close(id); return }
      self.stream(id, file)
    })
  }
}
