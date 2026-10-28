package app.cindy.notifications

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

internal data class ChatConnection(val owner: String, val actor: String, val base: String, val token: String,
  val title: String, val stopLabel: String, val preview: Boolean, val language: String = "en")

/** User-visible, opt-in socket. No boot receiver, hidden restart or stored access token. */
class ChatConnectionService : Service() {
  companion object {
    @Volatile private var configuration: ChatConnection? = null
    @Volatile var running = false; private set
    @Volatile var refreshRequested: (() -> Unit)? = null
    @Volatile internal var appForeground = true
    private var instance: ChatConnectionService? = null
    private var relayConfiguration: SessionRelayConfiguration? = null
    private var relayBackground = false
    internal fun configureRelay(value: SessionRelayConfiguration?) {
      relayConfiguration = value
      instance?.updateRelay()
    }
    internal fun setRelayBackground(value: Boolean) {
      relayBackground = value && !appForeground
      instance?.updateRelay()
    }
    internal fun receiveSession(context: android.content.Context, owner: String, device: String, payload: JSONObject) {
      val relay = relayConfiguration ?: return
      if (configuration?.owner != owner || relay.owner != owner || device !in relay.targets) return
      SessionDelivery.receive(context, owner, device, payload)
    }
    internal fun configure(value: ChatConnection) { configuration = value; instance?.updateRelay() }
    fun clear() { configuration = null; relayConfiguration = null; relayBackground = false; instance?.relay?.stop() }
    private const val CHANNEL = "chat-background"
    private const val ID = 7041
    private const val STOP = "app.cindy.notifications.STOP"
  }
  private val handler = Handler(Looper.getMainLooper())
  private val executor = Executors.newSingleThreadExecutor()
  private val http = OkHttpClient.Builder().connectTimeout(10, TimeUnit.SECONDS).readTimeout(20, TimeUnit.SECONDS)
    .callTimeout(25, TimeUnit.SECONDS).followRedirects(false).followSslRedirects(false).build()
  private var socket: WebSocket? = null
  private val relay by lazy { SessionRelay(this, handler, http) { config ->
    !stopped && relayBackground && !appForeground && configuration?.owner == config.owner
      && relayConfiguration?.owner == config.owner
  } }
  private fun updateRelay() {
    val config = relayConfiguration
    if (config != null && configuration?.owner == config.owner) SessionDelivery.identity(this, config.owner)
    if (config != null && relayBackground && !appForeground) relay.update(config) else relay.stop()
  }
  @Volatile private var active: ChatConnection? = null
  @Volatile private var stopped = false
  private var retry = 1000L
  private var cursor = Instant.now().minusSeconds(60).toString()
  private var cursorId = "00000000-0000-0000-0000-000000000000"
  private var drainPending = false
  private fun scheduleDrain() {
    handler.post {
      if (stopped || drainPending) return@post
      drainPending = true
      // Match cloud delivery's grace period: a device reading this chat can
      // acknowledge the message before the inbox rechecks eligibility.
      handler.postDelayed({
        drainPending = false
        active?.takeIf { current(it) }?.let { config ->
          executor.execute {
            try { drain(config) }
            catch (error: Exception) {
              if (current(config)) {
                if (error !is ChatInboxHttpException) ChatDiagnostics.inbox("failed")
                socket?.close(1000, "Reconnect")
              }
            }
          }
        }
      }, 2000)
    }
  }
  private val refresh = object : Runnable {
    override fun run() {
      if (stopped) return
      refreshRequested?.invoke() // JS AuthContext owns rotation and secure credential storage.
      val next = configuration
      if (next == null) { stopSelf(); return }
      if (next != active) executor.execute { connect(next) }
      updateRelay()
      handler.postDelayed(this, 60000)
    }
  }
  override fun onBind(intent: Intent?): IBinder? = null
  override fun onCreate() { super.onCreate(); running = true; instance = this }
  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == STOP) {
      getSharedPreferences("cindy-chat-background", MODE_PRIVATE).edit().putBoolean("paused", true).apply()
      clear(); stopSelf(); return START_NOT_STICKY
    }
    val config = configuration
    if (config == null || getSharedPreferences("cindy-chat-background", MODE_PRIVATE).getBoolean("paused", false)) {
      stopSelf(); return START_NOT_STICKY
    }
    val manager = getSystemService(NotificationManager::class.java)
    if (Build.VERSION.SDK_INT >= 26) manager.createNotificationChannel(NotificationChannel(CHANNEL, config.title, NotificationManager.IMPORTANCE_LOW))
    val stop = PendingIntent.getService(this, ID, Intent(this, ChatConnectionService::class.java).setAction(STOP), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    val open = packageManager.getLaunchIntentForPackage(packageName)?.let {
      PendingIntent.getActivity(this, ID, it, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }
    val notification = NotificationCompat.Builder(this, CHANNEL).setSmallIcon(android.R.drawable.stat_notify_chat)
      .setContentTitle(config.title).setContentIntent(open).setOngoing(true).setSilent(true)
      .addAction(0, config.stopLabel, stop).build()
    ServiceCompat.startForeground(this, ID, notification,
      if (Build.VERSION.SDK_INT >= 34) ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE else 0)
    updateRelay()
    handler.removeCallbacks(refresh); handler.post(refresh)
    return START_NOT_STICKY
  }
  override fun onDestroy() {
    ChatDiagnostics.connection("stopped")
    stopped = true; running = false; active = null; clear()
    relay.stop(); instance = null
    SessionDelivery.identity(this, "")
    handler.removeCallbacksAndMessages(null); socket?.cancel(); socket = null
    http.dispatcher.cancelAll(); executor.shutdownNow()
    stopForeground(STOP_FOREGROUND_REMOVE)
    super.onDestroy()
  }
  private fun current(config: ChatConnection) = !stopped && active === config && configuration?.owner == config.owner
  private fun get(config: ChatConnection, path: String): String {
    check(current(config))
    http.newCall(Request.Builder().url(config.base + "/v1" + path).header("Authorization", "Bearer ${config.token}").header("Accept-Language", config.language).build()).execute().use { response ->
      check(current(config))
      if (!response.isSuccessful) ChatDiagnostics.inbox("http-error", status = response.code)
      if (response.code == 401) handler.post { refreshRequested?.invoke() }
      if (!response.isSuccessful) throw ChatInboxHttpException()
      val body = response.body ?: throw Exception("CHAT_EMPTY_RESPONSE")
      // Bound responses independently of Content-Length, including chunked bodies.
      val output = java.io.ByteArrayOutputStream()
      val input = body.byteStream(); val buffer = ByteArray(8192)
      while (true) {
        val count = input.read(buffer); if (count < 0) break
        check(output.size() + count <= 512 * 1024)
        output.write(buffer, 0, count)
      }
      val bytes = output.toByteArray()
      check(current(config))
      return String(bytes, Charsets.UTF_8)
    }
  }
  private class ChatInboxHttpException : Exception()
  private fun connect(config: ChatConnection) {
    if (stopped || configuration?.owner != config.owner) return
    val old = active; active = config; socket?.cancel()
    ChatDiagnostics.connection("connecting")
    if (old?.owner != config.owner) { cursor = Instant.now().minusSeconds(60).toString(); cursorId = "00000000-0000-0000-0000-000000000000" }
    val request = Request.Builder().url(config.base.replaceFirst("https:", "wss:") + "/v1/ws").build()
    socket = http.newWebSocket(request, object : WebSocketListener() {
      @Volatile private var authenticated = false
      @Volatile private var timedOut = false
      private val deadline = Runnable {
        if (current(config) && !authenticated) {
          timedOut = true; ChatDiagnostics.connection("auth-timeout")
          // An open socket without a ready frame otherwise leaves the ongoing
          // notification up forever. Cancel invokes the existing bounded backoff.
          socket?.cancel()
        }
      }
      init { handler.postDelayed(deadline, 15000) }
      override fun onOpen(ws: WebSocket, response: Response) {
        if (!current(config)) { ws.cancel(); return }
        ChatDiagnostics.connection("authenticating")
        ws.send(JSONObject().put("type", "auth").put("token", config.token).toString())
      }
      override fun onMessage(ws: WebSocket, text: String) {
        if (!current(config) || text.length > 512 * 1024) return
        executor.execute {
          try {
            if (!current(config)) return@execute
            val frame = JSONObject(text)
            when (frame.optString("type")) {
              "ready" -> {
                if (frame.getString("actorId") != config.actor) {
                  ChatDiagnostics.connection("actor-mismatch")
                  ws.close(1000, "Reconnect"); return@execute
                }
                authenticated = true; handler.removeCallbacks(deadline)
                ChatDiagnostics.connection("ready")
                // A compacted actor scope responds with scope_error/head; the inbox is the
                // durable source, so neither a fresh connection nor replay can lose notices.
                ws.send(JSONObject().put("type", "subscribe").put("scope", "actor:${config.actor}").put("after", "0").toString())
                retry = 1000; scheduleDrain()
              }
              "changes" -> {
                if (frame.optString("scope") != "actor:${config.actor}") return@execute
                ChatDiagnostics.count("changeFrames")
                scheduleDrain()
                ws.send(JSONObject().put("type", "ack").put("scope", frame.getString("scope")).put("cursor", frame.getString("cursor")).toString())
              }
              "scope_error" -> {
                val head = frame.optJSONObject("error")?.optJSONObject("details")?.optString("head")
                if (!head.isNullOrBlank()) {
                  scheduleDrain()
                  ws.send(JSONObject().put("type", "subscribe").put("scope", "actor:${config.actor}").put("after", head).toString())
                } else ws.close(1000, "Reconnect")
              }
              "error" -> { ChatDiagnostics.connection("server-error"); ws.close(1000, "Reconnect") }
            }
          } catch (_: Exception) { ChatDiagnostics.connection("protocol-error"); ws.close(1000, "Reconnect") }
        }
      }
      override fun onClosed(ws: WebSocket, code: Int, reason: String) {
        handler.removeCallbacks(deadline)
        if (current(config)) { ChatDiagnostics.connection("closed"); reconnect(config) }
      }
      override fun onFailure(ws: WebSocket, error: Throwable, response: Response?) {
        handler.removeCallbacks(deadline)
        if (current(config)) {
          if (authenticated) ChatDiagnostics.connection("disconnected")
          else if (!timedOut) ChatDiagnostics.connection("auth-or-connect-failed")
          reconnect(config)
        }
      }
    })
  }
  private fun reconnect(config: ChatConnection) {
    if (!current(config)) return
    val delay = retry; retry = minOf(retry * 2, 30000)
    handler.postDelayed({ configuration?.takeIf { current(config) }?.let { next -> executor.execute { connect(next) } } }, delay)
  }
  private fun drain(config: ChatConnection) {
    for (page in 0 until 10) {
      val query = okhttp3.HttpUrl.Builder().scheme("https").host("cursor.invalid").addQueryParameter("after", cursor).addQueryParameter("afterId", cursorId).build().encodedQuery
      val rows = JSONArray(get(config, "/push/inbox?$query"))
      ChatDiagnostics.inbox("ok", rows.length(), 200)
      for (i in 0 until rows.length()) {
        if (!current(config)) return
        val row = rows.getJSONObject(i); val payload = row.getJSONObject("payload")
        if (!config.preview) { payload.remove("body"); payload.remove("sender"); payload.remove("senderName") }
        ChatDelivery.receive(this, mapOf("tag" to payload.getString("collapseId"), "title" to payload.getString("title"),
          "message" to payload.optString("body"), "body" to payload.toString(), "channelId" to "chat-messages"))
        cursor = row.getString("cursor"); cursorId = row.getString("id")
      }
      if (rows.length() < 100) return
    }
  }
}
