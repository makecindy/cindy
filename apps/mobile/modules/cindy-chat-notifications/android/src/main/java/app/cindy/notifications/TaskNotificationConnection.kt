package app.cindy.notifications

import android.content.Context
import okhttp3.Call
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/** One bounded streaming reader, independent of chat and the interactive device-link socket. */
internal class TaskNotificationConnection(private val context: Context) {
  private val executor = Executors.newSingleThreadExecutor()
  private val http = OkHttpClient.Builder().connectTimeout(10, TimeUnit.SECONDS)
    .readTimeout(45, TimeUnit.SECONDS).followRedirects(false).followSslRedirects(false).build()
  private val wake = Object()
  @Volatile private var active: ChatConnection? = null
  @Volatile private var call: Call? = null
  @Volatile private var closed = false

  fun configure(config: ChatConnection) {
    if (closed || active == config) return
    active = config; call?.cancel(); synchronized(wake) { wake.notifyAll() }
    executor.execute { run(config) }
  }
  fun close() { closed = true; active = null; call?.cancel(); executor.shutdownNow(); http.dispatcher.cancelAll() }
  private fun current(config: ChatConnection) = !closed && active === config
  private fun run(config: ChatConnection) {
    if (!current(config)) return
    if (config.taskBase.isEmpty() || config.taskUser.isEmpty()) return
    val preferences = context.getSharedPreferences("cindy-task-notification-cursor", Context.MODE_PRIVATE)
    // Session generations fence live work; replay survives process restarts for the same account/endpoint.
    val cursorOwner = "${config.taskUser}:${config.taskBase}"
    if (preferences.getString("owner", "") != cursorOwner) {
      preferences.edit().clear().putString("owner", cursorOwner).apply()
    }
    var cursor = preferences.getString("cursor", "") ?: ""
    var retry = 1000L
    while (current(config)) {
      try {
        val query = okhttp3.HttpUrl.Builder().scheme("https").host("cursor.invalid")
          .addQueryParameter("preview", if (config.preview) "1" else "0")
        if (cursor.matches(Regex("[0-9]{1,16}-[0-9]{1,10}"))) query.addQueryParameter("after", cursor)
        val request = Request.Builder().url(config.taskBase + "/api/device-link/push-stream?" + query.build().encodedQuery)
          .header("Authorization", "Bearer ${config.token}").header("Accept", "text/event-stream").build()
        val next = http.newCall(request); call = next
        if (!current(config)) { next.cancel(); return }
        next.execute().use { response ->
          if (response.code == 401) ChatConnectionService.refreshRequested?.invoke()
          if (response.code in listOf(403, 404, 405, 429)) retry = 60_000
          check(response.isSuccessful) { "TASK_NOTIFICATION_STREAM_UNAVAILABLE" }
          check(response.header("Content-Type")?.startsWith("text/event-stream") == true)
          val source = response.body?.source() ?: return
          var id = ""; var event = ""; var data = ""
          while (current(config) && !source.exhausted()) {
            val line = source.readUtf8LineStrict(32 * 1024L)
            if (line.startsWith(":")) { retry = 1000L; continue }
            when {
              line.startsWith("id: ") -> id = line.substring(4)
              line.startsWith("event: ") -> event = line.substring(7)
              line.startsWith("data: ") -> data = line.substring(6)
              line.isEmpty() -> {
                if (!current(config)) return
                if (event == "notification") {
                  val payload = JSONObject(data)
                  check(payload.optString("recipientId") == config.taskUser)
                  if (!config.preview) { payload.remove("body"); payload.remove("sender"); payload.remove("senderName") }
                  ChatDelivery.receive(context, mapOf("tag" to payload.getString("collapseId"),
                    "title" to payload.getString("title"), "message" to payload.optString("body"),
                    "body" to payload.toString(), "channelId" to "chat-messages"))
                }
                if (id.matches(Regex("[0-9]{1,16}-[0-9]{1,10}")) && event in listOf("notification", "cursor")) {
                  cursor = id
                  preferences.edit().putString("cursor", cursor).apply()
                }
                id = ""; event = ""; data = ""
              }
            }
          }
        }
      } catch (_: Exception) { /* The bounded retry retains the cursor for replay. */ }
      if (!current(config)) return
      try { synchronized(wake) { if (current(config)) wake.wait(retry + (Math.random() * 1000).toLong()) } } catch (_: InterruptedException) { return }
      retry = minOf(retry * 2, 60_000)
    }
  }
}
