package app.cindy.notifications

import android.content.Context
import android.net.Uri
import androidx.core.app.NotificationManagerCompat
import org.json.JSONArray
import org.json.JSONObject

/** Authenticated live relay events only. Store bounded event IDs, never previews or credentials. */
internal object SessionDelivery {
  @Volatile private var activeOwner = ""
  @Synchronized fun identity(context: Context, owner: String) {
    activeOwner = owner
    val store = context.getSharedPreferences("cindy-session-notification-ids", Context.MODE_PRIVATE)
    if (store.getString("owner", "") != owner) store.edit().clear().putString("owner", owner).apply()
  }
  @Synchronized fun receive(context: Context, owner: String, device: String, payload: JSONObject) {
    if (owner.isEmpty() || activeOwner != owner || !NotificationManagerCompat.from(context).areNotificationsEnabled()) return
    val id = payload.optString("eventId")
    val link = payload.optString("deepLink")
    if (payload.optString("category") != "session-done" || !id.matches(Regex("[a-f0-9]{64}"))
      || !payload.optString("collapseId").matches(Regex("[a-f0-9]{32}"))
      || payload.optString("title").length !in 1..120 || payload.optString("body").length > 240
      || !validLink(link, device)) return
    val store = context.getSharedPreferences("cindy-session-notification-ids", Context.MODE_PRIVATE)
    val ids = runCatching { JSONArray(store.getString("ids", "[]")) }.getOrDefault(JSONArray())
    if ((0 until ids.length()).any { ids.optString(it) == id }) { ChatDiagnostics.count("sessionDuplicates"); return }
    val next = JSONArray()
    for (i in maxOf(0, ids.length() - 255) until ids.length()) next.put(ids.getString(i))
    next.put(id); store.edit().putString("ids", next.toString()).apply()
    ChatDiagnostics.count("sessionDispatched")
    // Expo's response identifier must distinguish successive replies; a session collapse
    // key would cause the JS cold-response ledger to discard every click after the first.
    ChatDelivery.receive(context, mapOf("tag" to id, "title" to payload.getString("title"),
      "message" to payload.optString("body"), "body" to payload.toString(), "channelId" to "chat-messages"))
  }
  private fun validLink(link: String, device: String): Boolean = runCatching {
    val uri = Uri.parse(link)
    link.length <= 512 && uri.scheme == null && uri.authority == null && uri.fragment == null
      && uri.pathSegments.size == 2 && uri.pathSegments[0] == "sessions" && uri.pathSegments[1].isNotEmpty()
      && uri.pathSegments[1].none { it.isISOControl() || it == '/' || it == '\\' }
      && uri.getQueryParameter("deviceId") == device
      && uri.queryParameterNames.all { it in setOf("deviceId", "resourceCollectionId", "resourceId", "resourceKind")
        && uri.getQueryParameters(it).size == 1 }
  }.getOrDefault(false)
}
