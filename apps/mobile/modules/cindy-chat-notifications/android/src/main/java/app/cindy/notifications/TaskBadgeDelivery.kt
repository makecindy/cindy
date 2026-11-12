package app.cindy.notifications

import android.content.Context
import me.leolin.shortcutbadger.ShortcutBadger
import org.json.JSONObject

/** IDs, version and count only; no credentials or task content are persisted. */
object TaskBadgeDelivery {
  private const val STORE = "cindy-task-badge"

  @Synchronized fun identity(context: Context, scope: String, account: String) {
    val prefs = context.getSharedPreferences(STORE, Context.MODE_PRIVATE)
    if (prefs.getString("scope", "") == scope && prefs.getString("account", "") == account) return
    prefs.edit().clear().putString("scope", scope).putString("account", account).apply()
    if (account.isEmpty()) ShortcutBadger.removeCount(context)
  }

  @Synchronized fun apply(context: Context, data: JSONObject): Boolean {
    val prefs = context.getSharedPreferences(STORE, Context.MODE_PRIVATE)
    val account = prefs.getString("account", "") ?: ""
    if (account.isEmpty() || data.opt("accountId") != account || data.opt("schemaVersion") != 1 || data.opt("complete") !is Boolean) return false
    val version = data.opt("version") as? String ?: return false
    if (!version.matches(Regex("0|[1-9][0-9]*"))) return false
    val previous = prefs.getString("version", "") ?: ""
    if (previous.isNotEmpty() && (version.length < previous.length || (version.length == previous.length && version < previous))) return false
    val count = integer(data, "badgeCount") ?: return false
    val waiting = integer(data, "waitingCount") ?: return false
    val unread = integer(data, "unreadCount") ?: return false
    val running = integer(data, "runningCount") ?: return false
    if (count !in 0..Int.MAX_VALUE.toLong() || waiting < 0 || unread < 0 || running < 0 || count != waiting + unread) return false
    if (version == previous) {
      if (!prefs.getBoolean("complete", false)) return false
      return ShortcutBadger.applyCount(context, prefs.getInt("count", 0))
    }
    // An incomplete newer snapshot advances the watermark but never rewrites the icon.
    if (!data.optBoolean("complete", false)) {
      prefs.edit().putString("version", version).putBoolean("complete", false).apply()
      return false
    }
    prefs.edit().putString("version", version).putBoolean("complete", true).putInt("count", count.toInt()).apply()
    // Expo's zero path cancels every notification, including unrelated chat messages.
    return ShortcutBadger.applyCount(context, count.toInt())
  }

  @Synchronized fun currentCount(context: Context): Int? {
    val prefs = context.getSharedPreferences(STORE, Context.MODE_PRIVATE)
    return if (prefs.contains("count")) prefs.getInt("count", 0) else null
  }

  private fun integer(data: JSONObject, key: String): Long? {
    val number = (data.opt(key) as? Number)?.toDouble() ?: return null
    if (!number.isFinite() || number < 0 || number > 9007199254740991.0 || number != number.toLong().toDouble()) return null
    return number.toLong()
  }
}
