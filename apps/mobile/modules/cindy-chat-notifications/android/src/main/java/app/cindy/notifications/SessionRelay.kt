package app.cindy.notifications

import android.content.Context
import android.os.Handler
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

internal data class SessionRelayConfiguration(val owner: String, val user: String, val device: String,
  val url: String, val token: String, val targets: List<String>)

/** Notification-only legacy-v1 controller. The relay authenticates the existing device token;
 * desktop still gates link-open/subscribe by same-account authorization and per-device revocation.
 * No reliable-transport capability, invokes other than subscribe, snapshots, disk token or replay.
 * Only runs after the UI client has explicitly relinquished its socket, in the visible service.
 * All mutable connection state belongs to the service's main handler.
 */
internal class SessionRelay(private val context: Context, private val handler: Handler,
  private val http: OkHttpClient, private val allowed: (SessionRelayConfiguration) -> Boolean) {
  private var configuration: SessionRelayConfiguration? = null
  private var socket: WebSocket? = null
  private var generation = 0
  private var retry = 1000L
  private var retryScheduled = false
  private var congestion = 0L
  private var connectedAt = 0L
  private var ready = false
  private var blocked: Pair<String, String>? = null
  private var lastInbound = 0L
  private val version get() = context.packageManager.getPackageInfo(context.packageName, 0).versionName ?: "0.0.0"
  private val peers = mutableMapOf<String, Peer>()
  private data class Peer(val request: String = UUID.randomUUID().toString(),
    val subscription: String = UUID.randomUUID().toString(), var accepted: Boolean = false, var subscribed: Boolean = false,
    val started: Long = android.os.SystemClock.elapsedRealtime(), val attempt: Int = 0, var disabled: Boolean = false)
  private val heartbeat = object : Runnable {
    override fun run() {
      val config = configuration ?: return
      if (!allowed(config)) { stop(); return }
      if (android.os.SystemClock.elapsedRealtime() - lastInbound > 45_000) { reconnect(); return }
      val age = android.os.SystemClock.elapsedRealtime() - connectedAt
      if (age >= 60_000) retry = 1000
      if (age >= 15 * 60_000) congestion = 0
      // Missing peer handshakes cannot leave a permanently half-open receiver.
      // Bounded to three attempts on this relay; never reset unrelated peers.
      for ((device, peer) in peers.toMap()) {
        if (peer.subscribed || peer.disabled || android.os.SystemClock.elapsedRealtime() - peer.started < 15_000) continue
        if (peer.attempt < 2) { peers.remove(device); open(device, config, peer.attempt + 1) }
        else { peer.disabled = true; ChatDiagnostics.sessionRelay("peer-timeout") }
      }
      send("ping", null, null, null)
      handler.postDelayed(this, 20_000)
    }
  }
  private val retryConnection = Runnable { retryScheduled = false; configuration?.takeIf(allowed)?.let { connect(it) } }
  private val deadline = Runnable { reconnect() }

  fun update(config: SessionRelayConfiguration) {
    if (!allowed(config)) { stop(); return }
    if (blocked == (config.owner to config.device)) return
    if (configuration == config && (socket != null || retryScheduled)) return
    val prior = configuration
    configuration = config
    if (prior?.owner != config.owner) { retry = 1000; congestion = 0 }
    if (prior != null && prior.copy(targets = config.targets) == config && socket != null) {
      // A peer roster change is not a physical/authentication failure.
      (prior.targets - config.targets.toSet()).forEach { device ->
        peers.remove(device); send("link-close", device, null, JSONObject().put("reason", "user"))
      }
      if (ready) (config.targets - prior.targets.toSet()).forEach { open(it, config) }
      return
    }
    if (prior?.owner == config.owner && retryScheduled) return
    connect(config)
  }
  fun stop() {
    ChatDiagnostics.sessionRelay("stopped")
    configuration = null; generation++; peers.clear(); retryScheduled = false; ready = false
    handler.removeCallbacks(heartbeat); handler.removeCallbacks(deadline); handler.removeCallbacks(retryConnection)
    socket?.cancel(); socket = null
  }
  private fun connect(config: SessionRelayConfiguration) {
    if (!allowed(config)) { stop(); return }
    ChatDiagnostics.sessionRelay("connecting")
    handler.removeCallbacks(retryConnection); handler.removeCallbacks(deadline); handler.removeCallbacks(heartbeat)
    val captured = ++generation
    socket?.cancel(); peers.clear()
    ready = false
    handler.postDelayed(deadline, 15_000)
    socket = http.newWebSocket(Request.Builder().url(config.url)
      .header("Authorization", "Bearer ${config.token}").build(), object : WebSocketListener() {
      private fun current() = captured == generation && configuration?.owner == config.owner && allowed(config)
      override fun onOpen(ws: WebSocket, response: Response) { handler.post {
        if (!current()) { ws.cancel(); return@post }
        send("hello", null, null, JSONObject().put("deviceName", "Cindy Android").put("platform", "android")
          .put("appVersion", version).put("remoteControlEnabled", false).put("busy", false))
      } }
      override fun onMessage(ws: WebSocket, text: String) { handler.post {
        if (!current()) return@post
        try {
          check(text.length <= 64 * 1024)
          val frame = JSONObject(text)
          check(frame.optInt("v") == 1)
          // This controller has no cross-account task/provider-share authority.
          if (frame.has("sharedTask") || frame.has("providerShare")) return@post
          lastInbound = android.os.SystemClock.elapsedRealtime()
          val payload = frame.optJSONObject("payload") ?: JSONObject()
          when (frame.optString("kind")) {
            "hello-ack" -> {
              check(payload.getInt("serverProtocolVersion") == 1 && payload.getString("deviceId") == config.device
                && payload.getString("userId") == config.user)
              ready = true; connectedAt = android.os.SystemClock.elapsedRealtime(); handler.removeCallbacks(deadline)
              ChatDiagnostics.sessionRelay("ready")
              handler.removeCallbacks(heartbeat); handler.post(heartbeat)
              configuration?.targets?.distinct()?.take(100)?.forEach { open(it, config) }
            }
            "presence-changed" -> if (ready) {
              val device = payload.optString("deviceId")
              if (payload.optBoolean("online") && payload.optBoolean("remoteControlEnabled")) open(device, config)
              else peers.remove(device)
            }
            "link-accept" -> if (ready && frame.optString("dst") == config.device) {
              val device = frame.optString("src"); val peer = peers[device] ?: return@post
              if (frame.optString("id") != peer.request) return@post
              val capabilities = payload.optJSONArray("capabilities") ?: JSONArray()
              if ((0 until capabilities.length()).none { capabilities.optString(it) == "mobile-local-notifications-v1" }) {
                peer.disabled = true; ChatDiagnostics.sessionRelay("unsupported"); return@post
              }
              peer.accepted = true
              send("invoke", device, peer.request, JSONObject().put("channel", "device-link:subscribe")
                .put("args", JSONArray().put(JSONObject().put("topics", JSONArray().put("notifications:${peer.subscription}"))
                  .put("controllerName", "Cindy Android").put("capabilities", JSONArray().put("mobile-local-notifications-v1")))))
            }
            "invoke-result" -> if (ready && frame.optString("dst") == config.device) {
              val peer = peers[frame.optString("src")] ?: return@post
              if (frame.optString("id") == peer.request) {
                peer.subscribed = peer.accepted && payload.optBoolean("ok")
                peer.disabled = !peer.subscribed
                ChatDiagnostics.sessionRelay(if (peer.subscribed) "subscribed" else "denied")
              }
            }
            "push" -> if (ready && frame.optString("dst") == config.device) {
              val device = frame.optString("src"); val peer = peers[device] ?: return@post
              if (!peer.accepted || payload.optString("channel") != "device-link:mobile-notification") return@post
              // A live push may precede subscribe ACK; its fresh nonce is the admission proof.
              val notice = payload.optJSONObject("payload") ?: return@post
              if (notice.optString("subscriptionId") != peer.subscription) return@post
              // Bad business payloads must not reset the shared relay or other peers.
              runCatching { SessionDelivery.receive(context, config.owner, device, notice) }
                .onFailure { ChatDiagnostics.count("sessionInvalid") }
            }
            "link-close" -> if (frame.optString("dst") == config.device) peers.remove(frame.optString("src"))
            "relay-error" -> {
              val dst = payload.optString("dst")
              if (dst.isNotEmpty()) peers.remove(dst)
            }
          }
        } catch (_: Exception) { reconnect() }
      } }
      override fun onClosed(ws: WebSocket, code: Int, reason: String) { handler.post {
        if (!current()) return@post
        if (code == 4410 || code == 4400 || code == 4409) {
          // Removed/replaced devices and incompatible protocols must not fight another
          // authenticated client. A changed account/device or service recreation resets this.
          blocked = config.owner to config.device; stop(); ChatDiagnostics.sessionRelay("denied")
        } else {
          if (code == 1013) congestion = minOf(if (congestion == 0L) 5000 else congestion * 2, 30_000)
          reconnect()
        }
      } }
      override fun onFailure(ws: WebSocket, error: Throwable, response: Response?) { handler.post { if (current()) reconnect() } }
    })
  }
  private fun open(device: String, config: SessionRelayConfiguration, attempt: Int = 0) {
    if (device.isEmpty() || device.length > 256 || device == config.device || device.startsWith("shared-task:")
      || device.startsWith("provider-share:") || peers.containsKey(device) || peers.size >= 100) return
    val peer = Peer(attempt = attempt); peers[device] = peer
    send("link-open", device, peer.request, JSONObject().put("controllerName", "Cindy Android")
      .put("protocolVersion", 1).put("appVersion", version)
      .put("capabilities", JSONArray().put("background-link-v1").put("mobile-local-notifications-v1")))
  }
  private fun send(kind: String, dst: String?, id: String?, payload: JSONObject?) {
    socket?.send(JSONObject().put("v", 1).put("kind", kind).apply {
      if (dst != null) put("dst", dst)
      if (id != null) put("id", id)
      if (payload != null) put("payload", payload)
    }.toString())
  }
  private fun reconnect() {
    val config = configuration ?: return
    generation++; socket?.cancel(); socket = null; peers.clear(); ready = false
    handler.removeCallbacks(heartbeat); handler.removeCallbacks(deadline); handler.removeCallbacks(retryConnection)
    if (!allowed(config)) { stop(); return }
    ChatDiagnostics.sessionRelay("reconnecting")
    retryScheduled = true
    handler.postDelayed(retryConnection, (maxOf(retry, congestion) * (0.7 + Math.random() * 0.3)).toLong())
    retry = minOf(retry * 2, 30_000)
  }
}
