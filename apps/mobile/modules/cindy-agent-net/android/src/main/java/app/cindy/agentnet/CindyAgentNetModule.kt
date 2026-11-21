package app.cindy.agentnet

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.Promise
import java.util.concurrent.Executors
import android.os.Handler
import android.os.Looper
import org.json.JSONObject
import java.util.UUID

class CindyAgentNetModule : Module() {
  companion object { init { System.loadLibrary("cindy_agent_net_bridge") } }
  private val lock = Any()
  private val handles = mutableMapOf<String, Long>()
  private var destroyed = false
  private val lan = mutableMapOf<String, AgentNetLan>()
  private external fun nativeCreate(input: ByteArray): Long
  private external fun nativeCommand(id: Long, input: ByteArray): String?
  private external fun nativeDestroy(id: Long)
  private external fun nativePump(id: Long): Long
  private external fun nativeWaiter(id: Long): Long
  private external fun nativeWait(waiter: Long, timeoutMs: Int): Int
  private external fun nativeWaiterFree(waiter: Long)
  /**
   * One engine's own loop, on its own thread from the first `wait` until the engine is destroyed: wait for a datagram or
   * the core's next timer, give the engine its turn (it reads, acknowledges, retransmits, keeps connections alive), and
   * tell a waiting `wait` call when the engine has something for JS to read with `poll`. It does not depend on the JS
   * thread: a busy or stalled JS thread no longer delays acknowledgements. Every turn takes `lock`, like `command`; the
   * blocking wait in between holds nothing. The socket waiter outlives the engine and is freed here, after the last wait.
   */
  private inner class Pump(private val id: String, private val waiter: Long) : Thread("cindy-agent-net-pump") {
    @Volatile var closed = false
    private val signal = Object()
    private var work = false
    override fun run() {
      var waitMs = 0L
      try {
        while (!closed) {
          if (waitMs > 0) nativeWait(waiter, waitMs.toInt())
          val state = synchronized(lock) {
            val handle = handles[id]
            if (destroyed || closed || handle == null) -1L else nativePump(handle)
          }
          if (state < 0) break
          if (state and 1L == 1L) synchronized(signal) { work = true; signal.notifyAll() }
          waitMs = (state shr 1).coerceIn(1L, 250L)
        }
      } finally {
        closed = true
        nativeWaiterFree(waiter)
        synchronized(signal) { signal.notifyAll() }
      }
    }
    /** True as soon as the engine has something for JS, false after `maxMs` or once the engine is gone. */
    fun await(maxMs: Int): Boolean = synchronized(signal) {
      if (!work && !closed) signal.wait(maxMs.coerceIn(1, 60_000).toLong())
      val had = work
      work = false
      had
    }
  }
  private val pumps = mutableMapOf<String, Pump>()
  /** `wait` blocks for up to its limit: its own threads, so it holds up neither Expo's shared function queue nor `command`. */
  private val waitThreads = Executors.newCachedThreadPool()
  private fun waitForWork(id: String, maxMs: Int): Boolean {
    var ready = false
    val pump = synchronized(lock) {
      val handle = handles[id]
      if (destroyed || handle == null) return false
      // The engine takes a turn before the wait starts. What JS wrote since its last poll may have left a datagram for its
      // relay WebSocket, and no packet arriving on the socket would announce that one: the pump thread would hand it over
      // only at its next timer, up to 250 ms later (PR #11816 review).
      val state = nativePump(handle)
      if (state < 0) failure("AGENT_NET_COMMAND_FAILED")
      ready = state and 1L == 1L
      pumps[id]?.takeUnless { it.closed } ?: run {
        val waiter = nativeWaiter(handle)
        if (waiter == 0L) failure("AGENT_NET_COMMAND_FAILED")
        Pump(id, waiter).also { pumps[id] = it; it.start() }
      }
    }
    return ready || pump.await(maxMs)
  }
  private fun failure(code: String): Nothing = throw CodedException(code, code, null)
  private fun input(value: String): ByteArray = value.toByteArray(Charsets.UTF_8).also {
    if (it.size > 2 * 1024 * 1024) failure("AGENT_NET_COMMAND_TOO_LARGE")
  }
  override fun definition() = ModuleDefinition {
    Name("CindyAgentNet")
    Function("beginNotificationScope") {
      AgentNetNotifications.begin(appContext.reactContext ?: failure("AGENT_NET_CONTEXT_UNAVAILABLE"))
    }
    Function("notificationScope") {
      AgentNetNotifications.scope(appContext.reactContext ?: failure("AGENT_NET_CONTEXT_UNAVAILABLE"))
    }
    Function("openNotification") { link: String ->
      AgentNetNotifications.open(appContext.reactContext ?: failure("AGENT_NET_CONTEXT_UNAVAILABLE"), link)
    }
    AsyncFunction("configureNotifications") { ticket: String, raw: String ->
      AgentNetNotifications.configure(appContext.reactContext ?: failure("AGENT_NET_CONTEXT_UNAVAILABLE"), ticket, raw)
    }
    Events("onLanService")
    AsyncFunction("startLan") { port: Int, raw: String ->
      if (port !in 1..65535 || lan.size >= 8 || synchronized(lock) { destroyed }) failure("AGENT_NET_DISCOVERY_LIMIT")
      val context = appContext.reactContext ?: failure("AGENT_NET_CONTEXT_UNAVAILABLE")
      val txt = lanText(raw)
      UUID.randomUUID().toString().also { id -> lan[id] = AgentNetLan(context, id, port, txt) { sendEvent("onLanService", it) } }
    }.runOnQueue(Queues.MAIN)
    AsyncFunction("updateLan") { id: String, raw: String -> lan[id]?.update(lanText(raw)); Unit }.runOnQueue(Queues.MAIN)
    AsyncFunction("stopLan") { id: String -> lan.remove(id)?.close(); Unit }.runOnQueue(Queues.MAIN)
    AsyncFunction("create") { options: String ->
      synchronized(lock) {
        if (destroyed || handles.size >= 16) failure("AGENT_NET_ENGINE_LIMIT")
        val handle = nativeCreate(input(options))
        if (handle == 0L) failure("AGENT_NET_CREATE_FAILED")
        UUID.randomUUID().toString().also { handles[it] = handle }
      }
    }
    AsyncFunction("command") { id: String, command: String ->
      synchronized(lock) {
        if (destroyed) failure("AGENT_NET_ENGINE_CLOSED")
        val handle = handles[id] ?: failure("AGENT_NET_ENGINE_CLOSED")
        nativeCommand(handle, input(command)) ?: failure("AGENT_NET_COMMAND_FAILED")
      }
    }
    AsyncFunction("wait") { id: String, maxMs: Int, promise: Promise ->
      waitThreads.execute {
        try { promise.resolve(waitForWork(id, maxMs)) }
        catch (error: CodedException) { promise.reject(error) }
        catch (_: Throwable) { promise.reject(CodedException("AGENT_NET_COMMAND_FAILED", "AGENT_NET_COMMAND_FAILED", null)) }
      }
    }
    AsyncFunction("destroy") { id: String ->
      synchronized(lock) { pumps.remove(id)?.closed = true; handles.remove(id)?.let { nativeDestroy(it) }; Unit }
    }
    OnDestroy {
      Handler(Looper.getMainLooper()).post { lan.values.forEach { it.close() }; lan.clear() }
      synchronized(lock) {
        destroyed = true
        pumps.values.forEach { it.closed = true }
        pumps.clear()
        handles.values.forEach { nativeDestroy(it) }
        handles.clear()
      }
      waitThreads.shutdown()
    }
  }
  private fun lanText(raw: String): Map<String, String> {
    if (raw.length > 2048) failure("AGENT_NET_INVALID_DISCOVERY_RECORD")
    val json = try { JSONObject(raw) } catch (_: Exception) { failure("AGENT_NET_INVALID_DISCOVERY_RECORD") }
    if (json.length() > 8) failure("AGENT_NET_INVALID_DISCOVERY_RECORD")
    return json.keys().asSequence().associateWith { key ->
      val value = json.get(key)
      if (key.length > 8 || value !is String || value.length > 200 || value.any { it.code > 127 }) failure("AGENT_NET_INVALID_DISCOVERY_RECORD")
      value
    }
  }
}
