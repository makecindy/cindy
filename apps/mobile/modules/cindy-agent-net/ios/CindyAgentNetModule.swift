import ExpoModulesCore
import CindyAgentNetNative

public final class CindyAgentNetModule: Module {
  private let queue = DispatchQueue(label: "cindy.agent-net.native")
  private var handles: [String: OpaquePointer] = [:]
  private var destroyed = false
  // Bonjour and its run-loop delegates live exclusively on the main queue.
  private var lan: [String: AgentNetLan] = [:]

  public func definition() -> ModuleDefinition {
    Name("CindyAgentNet")
    Function("beginNotificationScope") { () -> String in AgentNetNotifications.begin() }
    Function("notificationScope") { () -> String? in AgentNetNotifications.activeScope() }
    Function("openNotification") { (link: String) -> String? in
      guard let value = AgentNetNotifications.open(link), let bytes = try? JSONSerialization.data(withJSONObject: value) else { return nil }
      return String(data: bytes, encoding: .utf8)
    }
    AsyncFunction("configureNotifications") { (ticket: String, raw: String) throws in
      try AgentNetNotifications.configure(ticket, raw: raw)
    }.runOnQueue(queue)
    Events("onLanService")
    AsyncFunction("startLan") { (port: Int, raw: String) throws -> String in
      guard port > 0, port <= 65535, self.lan.count < 8 else { throw self.failure("AGENT_NET_DISCOVERY_LIMIT") }
      let txt = try self.lanText(raw), id = UUID().uuidString
      self.lan[id] = AgentNetLan(id: id, port: port, txt: txt) { [weak self] value in self?.sendEvent("onLanService", value) }
      return id
    }.runOnQueue(.main)
    AsyncFunction("updateLan") { (id: String, raw: String) throws in self.lan[id]?.update(try self.lanText(raw)) }.runOnQueue(.main)
    AsyncFunction("stopLan") { (id: String) in self.lan.removeValue(forKey: id)?.close() }.runOnQueue(.main)
    AsyncFunction("create") { (options: String) throws -> String in
      guard !self.destroyed, self.handles.count < 16 else { throw self.failure("AGENT_NET_ENGINE_LIMIT") }
      let data = try self.input(options)
      let handle = data.withUnsafeBytes { raw in
        cindy_agent_net_create(raw.bindMemory(to: UInt8.self).baseAddress, raw.count)
      }
      guard let handle else { throw self.failure("AGENT_NET_CREATE_FAILED") }
      let id = UUID().uuidString
      self.handles[id] = handle
      return id
    }.runOnQueue(queue)
    AsyncFunction("command") { (id: String, command: String) throws -> String in
      guard !self.destroyed, let handle = self.handles[id] else { throw self.failure("AGENT_NET_ENGINE_CLOSED") }
      let data = try self.input(command)
      let result = data.withUnsafeBytes { raw in
        cindy_agent_net_command(handle, raw.bindMemory(to: UInt8.self).baseAddress, raw.count)
      }
      guard let result else { throw self.failure("AGENT_NET_COMMAND_FAILED") }
      defer { cindy_agent_net_free_string(result) }
      return String(cString: result)
    }.runOnQueue(queue)
    AsyncFunction("destroy") { (id: String) in
      if let handle = self.handles.removeValue(forKey: id) { cindy_agent_net_destroy(handle) }
    }.runOnQueue(queue)
    OnDestroy {
      DispatchQueue.main.async {
        self.lan.values.forEach { $0.close() }; self.lan.removeAll()
      }
      self.queue.async {
        self.destroyed = true
        let active = self.handles.values
        self.handles.removeAll()
        active.forEach { cindy_agent_net_destroy($0) }
      }
    }
  }
  private func input(_ value: String) throws -> Data {
    guard let data = value.data(using: .utf8), data.count <= 2 * 1024 * 1024 else { throw failure("AGENT_NET_COMMAND_TOO_LARGE") }
    return data
  }
  private func lanText(_ value: String) throws -> [String: Data] {
    guard value.utf8.count <= 2048, let raw = value.data(using: .utf8),
          let txt = try JSONSerialization.jsonObject(with: raw) as? [String: String], txt.count <= 8,
          txt.allSatisfy({ $0.key.utf8.count <= 8 && $0.value.utf8.count <= 200 && $0.value.data(using: .ascii) != nil })
    else { throw failure("AGENT_NET_INVALID_DISCOVERY_RECORD") }
    return txt.mapValues { Data($0.utf8) }
  }
  private func failure(_ code: String) -> NSError {
    NSError(domain: "CindyAgentNet", code: 1, userInfo: [NSLocalizedDescriptionKey: code])
  }
}
