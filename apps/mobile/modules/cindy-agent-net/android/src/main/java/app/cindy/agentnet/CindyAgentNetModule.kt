package app.cindy.agentnet

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.functions.Queues
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
    AsyncFunction("destroy") { id: String ->
      synchronized(lock) { handles.remove(id)?.let { nativeDestroy(it) }; Unit }
    }
    OnDestroy {
      Handler(Looper.getMainLooper()).post { lan.values.forEach { it.close() }; lan.clear() }
      synchronized(lock) {
        destroyed = true
        handles.values.forEach { nativeDestroy(it) }
        handles.clear()
      }
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
