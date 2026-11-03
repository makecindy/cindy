import ExpoModulesCore

public class CindyHtmlPreviewModule: Module {
  private var servers: [String: HtmlSnapshotServer] = [:]
  private var appServers: [String: HtmlSnapshotServer] = [:]
  private let queue = DispatchQueue(label: "cindy.html-preview")
  private var foreground = true

  public func definition() -> ModuleDefinition {
    Name("CindyHtmlPreview")
    Events("resourceRequest", "resourceClosed")
    Constant("appHostAvailable") { true }
    View(HtmlAppHost.self) {
      ViewName("AppHost")
      Prop("surfaceId") { (view, id: String) in view.surfaceId = id }
    }
    View(HtmlAppSlot.self) {
      ViewName("AppSlot")
      Prop("surfaceId") { (view, id: String) in view.surfaceId = id }
    }
    // Separate from the four ordinary HTML previews: four live Apps can each
    // use two origins, with a bounded allowance for their retiring Views.
    AsyncFunction("startApp") { (root: String, entry: String, token: String, csp: String, files: [[String]], promise: Promise) in
      do {
        guard self.foreground, self.appServers.count < 16, self.appServers[token] == nil,
          let cache = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first,
          URL(fileURLWithPath: root).resolvingSymlinksInPath().path.hasPrefix(cache.appendingPathComponent("mcp-apps").resolvingSymlinksInPath().path + "/")
        else { throw HtmlSnapshotServer.Failure.invalid }
        let server = try HtmlSnapshotServer(root: root, entry: entry, token: token, csp: csp, files: files, queue: self.queue)
        self.appServers[token] = server
        server.start { result in
          switch result {
          case .success(let url): promise.resolve(url)
          case .failure:
            self.appServers.removeValue(forKey: token)?.stop()
            promise.reject("HTML_PREVIEW_START_FAILED", "Unable to start App resource")
          }
        }
      } catch { promise.reject("HTML_PREVIEW_START_FAILED", "Unable to start App resource") }
    }.runOnQueue(queue)
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
    AsyncFunction("startOnDemand") { (root: String, entry: String, token: String, csp: String, promise: Promise) in
      do {
        guard self.foreground, self.servers.count < 4, self.servers[token] == nil,
          let cache = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first,
          URL(fileURLWithPath: root).resolvingSymlinksInPath().path.hasPrefix(cache.resolvingSymlinksInPath().path + "/")
        else { throw HtmlSnapshotServer.Failure.invalid }
        let server = try HtmlSnapshotServer(root: root, entry: entry, token: token, csp: csp, files: [], queue: self.queue,
          onRequest: { [weak self] id, path in self?.sendEvent("resourceRequest", ["token": token, "id": id, "path": path]) },
          onClose: { [weak self] id in self?.sendEvent("resourceClosed", ["token": token, "id": id]) })
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
    AsyncFunction("resolveRequest") { (token: String, id: String, filename: String, mime: String, status: Int) -> Bool in
      self.servers[token]?.resolve(id, filename: filename, mime: mime, status: status) ?? false
    }.runOnQueue(queue)
    AsyncFunction("stop") { (token: String) in
      self.servers.removeValue(forKey: token)?.stop()
      self.appServers.removeValue(forKey: token)?.stop()
    }.runOnQueue(queue)
    OnAppEntersBackground { self.queue.async {
      self.foreground = false
      self.stopPreviews()
      // Keep only this background generation available for bounded teardown.
      // A quick foreground/reopen must not be stopped by an old timer.
      let tokens = Array(self.appServers.keys)
      self.queue.asyncAfter(deadline: .now() + 1) {
        for token in tokens { self.appServers.removeValue(forKey: token)?.stop() }
      }
    } }
    OnAppEntersForeground { self.queue.async { self.foreground = true } }
    OnDestroy { self.queue.async { self.stopAll() } }
  }

  private func stopAll() {
    stopPreviews()
    let active = Array(appServers.values)
    appServers.removeAll()
    active.forEach { $0.stop() }
  }

  private func stopPreviews() {
    let active = Array(servers.values)
    servers.removeAll()
    active.forEach { $0.stop() }
  }
}
