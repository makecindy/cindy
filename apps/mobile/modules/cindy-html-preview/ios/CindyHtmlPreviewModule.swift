import ExpoModulesCore

public class CindyHtmlPreviewModule: Module {
  private var servers: [String: HtmlSnapshotServer] = [:]
  private let queue = DispatchQueue(label: "cindy.html-preview")
  private var foreground = true

  public func definition() -> ModuleDefinition {
    Name("CindyHtmlPreview")
    AsyncFunction("start") { (root: String, entry: String, token: String, csp: String, files: [[String]], promise: Promise) in
      do {
        guard self.foreground, self.servers.count < 4, self.servers[token] == nil,
          let cache = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first,
          URL(fileURLWithPath: root).resolvingSymlinksInPath().path.hasPrefix(cache.resolvingSymlinksInPath().path + "/")
        else { throw HtmlSnapshotServer.Failure.invalid }
        let server = try HtmlSnapshotServer(root: root, entry: entry, token: token, csp: csp, files: files, queue: self.queue)
        self.servers[token] = server
        server.start { result in
          switch result {
          case .success(let url): promise.resolve(url)
          case .failure:
            self.servers.removeValue(forKey: token)?.stop()
            promise.reject("HTML_PREVIEW_START_FAILED", "Unable to start HTML preview")
          }
        }
      } catch { promise.reject("HTML_PREVIEW_START_FAILED", "Unable to start HTML preview") }
    }.runOnQueue(queue)
    AsyncFunction("stop") { (token: String) in self.servers.removeValue(forKey: token)?.stop() }.runOnQueue(queue)
    OnAppEntersBackground { self.queue.async { self.foreground = false; self.stopAll() } }
    OnAppEntersForeground { self.queue.async { self.foreground = true } }
    OnDestroy { self.queue.async { self.stopAll() } }
  }

  private func stopAll() {
    let active = Array(servers.values)
    servers.removeAll()
    active.forEach { $0.stop() }
  }
}
