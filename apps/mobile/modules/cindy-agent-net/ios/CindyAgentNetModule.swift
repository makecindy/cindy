import ExpoModulesCore
import CindyAgentNetNative

public final class CindyAgentNetModule: Module {
  private let queue = DispatchQueue(label: "cindy.agent-net.native")
  private var handles: [String: OpaquePointer] = [:]
  private var destroyed = false
  /// One engine's own loop, on its own thread from the first `wait` until the engine is destroyed: wait for a datagram or
  /// the core's next timer, give the engine its turn (it reads, acknowledges, retransmits, keeps connections alive), and
  /// tell a waiting `wait` call when the engine has something for JS to read with `poll`. It does not depend on the JS
  /// thread: a busy or stalled JS thread no longer delays acknowledgements. The socket waiter outlives the engine and is
  /// freed here, after the last wait on it.
  private final class Pump {
    private let waiter: OpaquePointer
    private let condition = NSCondition()
    private var work = false
    private var closed = false
    init(waiter: OpaquePointer) { self.waiter = waiter }
    var isClosed: Bool { condition.lock(); defer { condition.unlock() }; return closed }
    func close() { condition.lock(); closed = true; condition.broadcast(); condition.unlock() }
    /// `turn`: the engine's turn, serialized with its commands; negative once the engine is gone.
    func run(_ turn: () -> Int64) {
      var waitMs: Int64 = 0
      while !isClosed {
        if waitMs > 0 { _ = cindy_agent_net_wait(waiter, UInt32(waitMs)) }
        let state = turn()
        if state < 0 { break }
        if state & 1 == 1 { condition.lock(); work = true; condition.broadcast(); condition.unlock() }
        waitMs = max(1, min(250, state >> 1))
      }
      close()
      cindy_agent_net_waiter_free(waiter)
    }
    /// True as soon as the engine has something for JS, false after `maxMs` or once the engine is gone.
    func nextWork(_ maxMs: Int) -> Bool {
      condition.lock(); defer { condition.unlock() }
      if !work && !closed { _ = condition.wait(until: Date().addingTimeInterval(Double(max(1, min(maxMs, 60_000))) / 1000)) }
      let had = work
      work = false
      return had
    }
    /// A waiting call returns now and reads (`binary-io`: JS needs to be back sooner than that call's limit).
    func kick() { condition.lock(); work = true; condition.broadcast(); condition.unlock() }
  }
  /// Changed on `queue`, always under `pumpLock`: `kick` reads it from the JS thread, which must not wait for `queue`.
  private var pumps: [String: Pump] = [:]
  private let pumpLock = NSLock()
  private func pump(_ id: String) -> Pump? { pumpLock.lock(); defer { pumpLock.unlock() }; return pumps[id] }
  private func setPump(_ id: String, _ value: Pump?) -> Pump? {
    pumpLock.lock(); defer { pumpLock.unlock() }
    let previous = pumps[id]
    pumps[id] = value
    return previous
  }
  /// `wait` blocks for up to its limit: its own concurrent queue, so `command` on `queue` is never held up by it.
  private let waitQueue = DispatchQueue(label: "cindy.agent-net.native.wait", attributes: .concurrent)
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
    AsyncFunction("wait") { (id: String, maxMs: Int, promise: Promise) in
      self.waitQueue.async { promise.resolve(self.waitForWork(id, maxMs)) }
    }
    /// `binary-io` (engine.rs `io`): one frame in, one out. With `waitMs` it first waits as `wait` does and reads only once
    /// the engine has something for JS (an empty result otherwise), so the answer to a request comes back in the call that
    /// waited for it. `kick`: the engine takes a turn after this call, and a waiting call reads if there is something for JS
    /// (what this call wrote may have left a datagram for the relay WebSocket, which no packet on the socket would announce).
    AsyncFunction("io") { (id: String, input: Data, waitMs: Int, kick: Bool, promise: Promise) in
      let run = {
        do { promise.resolve(try self.io(id, input, kick: kick)) }
        catch { promise.reject(error) }
      }
      if waitMs > 0 {
        // A waiting call blocks for up to its limit: on `waitQueue`, like `wait`; it reads on `queue`, like `command`.
        self.waitQueue.async {
          if self.waitForWork(id, waitMs) { self.queue.async(execute: run) } else { promise.resolve(Data()) }
        }
      } else { self.queue.async(execute: run) }
    }
    Function("kick") { (id: String) -> Void in _ = self.pump(id)?.kick() }
    AsyncFunction("destroy") { (id: String) in
      self.setPump(id, nil)?.close()
      if let handle = self.handles.removeValue(forKey: id) { cindy_agent_net_destroy(handle) }
    }.runOnQueue(queue)
    OnDestroy {
      DispatchQueue.main.async {
        self.lan.values.forEach { $0.close() }; self.lan.removeAll()
      }
      self.queue.async {
        self.destroyed = true
        self.pumpLock.lock()
        let running = self.pumps.values
        self.pumps.removeAll()
        self.pumpLock.unlock()
        running.forEach { $0.close() }
        let active = self.handles.values
        self.handles.removeAll()
        active.forEach { cindy_agent_net_destroy($0) }
      }
    }
  }
  private func waitForWork(_ id: String, _ maxMs: Int) -> Bool {
    var ready = false
    let pump: Pump? = queue.sync {
      guard !self.destroyed, let handle = self.handles[id] else { return nil }
      // The engine takes a turn before the wait starts. What JS wrote since its last poll may have left a datagram for its
      // relay WebSocket, and no packet arriving on the socket would announce that one: the pump thread would hand it over
      // only at its next timer, up to 250 ms later (PR #11816 review).
      let state = cindy_agent_net_pump(handle)
      if state < 0 { return nil }
      ready = state & 1 == 1
      if let existing = self.pump(id), !existing.isClosed { return existing }
      guard let waiter = cindy_agent_net_waiter(handle) else { return nil }
      let created = Pump(waiter: waiter)
      _ = self.setPump(id, created)
      let thread = Thread { [weak self] in
        created.run {
          guard let self else { return -1 }
          // Every turn runs on `queue`, like `command`; the blocking wait in between holds nothing.
          return self.queue.sync { () -> Int64 in
            guard !self.destroyed, !created.isClosed, let handle = self.handles[id] else { return -1 }
            return cindy_agent_net_pump(handle)
          }
        }
      }
      thread.name = "cindy-agent-net-pump"
      thread.start()
      return created
    }
    if ready { return true }
    return pump?.nextWork(maxMs) ?? false
  }
  /// Only on `queue`.
  private func io(_ id: String, _ input: Data, kick: Bool) throws -> Data {
    guard !destroyed, let handle = handles[id] else { throw failure("AGENT_NET_ENGINE_CLOSED") }
    guard !input.isEmpty, input.count <= 4 * 1024 * 1024 else { throw failure("AGENT_NET_COMMAND_TOO_LARGE") }
    var length = 0
    let result = input.withUnsafeBytes { raw in
      cindy_agent_net_io(handle, raw.bindMemory(to: UInt8.self).baseAddress, raw.count, &length)
    }
    guard let result else { throw failure("AGENT_NET_COMMAND_FAILED") }
    defer { cindy_agent_net_free_bytes(result, length) }
    let output = Data(bytes: result, count: length)
    if kick {
      let state = cindy_agent_net_pump(handle)
      if state >= 0 && state & 1 == 1 { pump(id)?.kick() }
    }
    return output
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
