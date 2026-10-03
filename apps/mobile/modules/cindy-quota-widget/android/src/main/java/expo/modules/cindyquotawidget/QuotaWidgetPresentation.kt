package expo.modules.cindyquotawidget

import org.json.JSONObject
import kotlin.math.roundToInt
import kotlin.math.ceil

/** Pure presentation policy; never advances source observation time on redraw. */
internal object QuotaWidgetPresentation {
  const val HEADER_HEIGHT_DP = 46
  const val CARD_HEIGHT_DP = 164
  data class Layout(val columns: Int, val count: Int, val needsSpace: Boolean, val showMoreHint: Boolean)
  // 16dp insets + 46dp brand/ring area + 8dp gap + 38/21/18dp information rows.
  // Do not use landscape grid constraints as the rendered card's required height.
  fun layout(width: Int, height: Int, fontScale: Float, providers: Int): Layout {
    val scale = fontScale.coerceAtLeast(1f)
    val cardHeight = ceil(CARD_HEIGHT_DP * scale).toInt()
    val columnWidth = 32 + 146 * scale
    val columns = if (width >= 2 * columnWidth) 2 else 1
    val requested = providers.coerceIn(1, 3)
    val capacity = (height / cardHeight).coerceAtLeast(0) * columns
    val needsSpace = width < columnWidth || capacity == 0
    val count = if (needsSpace) 0 else minOf(requested, capacity)
    val usedHeight = ((count + columns - 1) / columns) * cardHeight
    // The hint may use spare space, but must never displace a fitting provider card.
    val showMoreHint = !needsSpace && count < requested && height - usedHeight >= ceil(20 * scale).toInt()
    return Layout(columns, count, needsSpace, showMoreHint)
  }
  fun windows(row: JSONObject): List<JSONObject> {
    if (!row.optBoolean("available") || row.optString("status") != "ready") return emptyList()
    val source = row.getJSONArray("windows")
    val windows = (0 until source.length()).map(source::getJSONObject)
    return if (row.getString("platform") == "claude") windows.sortedBy(::slot).take(3)
      else windows.filter { it.optInt("minutes") == 10080 && it.optString("kind") != "scoped" }.take(1)
  }
  fun slot(window: JSONObject) = if (window.optString("kind") == "scoped") 2 else if (window.optInt("minutes") == 10080) 0 else 1
  fun duration(raw: Any?, now: Long): String {
    val reset = (raw as? Number)?.toDouble()?.takeIf { it.isFinite() } ?: return "—"
    val seconds = (reset - now) / 1000
    if (seconds <= 0) return "—"
    val minutes = (seconds / 60).coerceAtMost(99.0 * 1440).toLong()
    return when { minutes < 1 -> "<1m"
      minutes >= 1440 -> "${minutes / 1440}d ${minutes % 1440 / 60}h"
      minutes >= 60 -> "${minutes / 60}h ${minutes % 60}m"
      else -> "${minutes}m" }
  }
  fun value(row: JSONObject, window: JSONObject, connection: String, now: Long) =
    if (QuotaSnapshot.state(row, window, connection, now) == "fresh") "${window.getDouble("remainingPercent").roundToInt()}%" else "—"
  fun detail(row: JSONObject, window: JSONObject, connection: String, now: Long) = when (QuotaSnapshot.state(row, window, connection, now)) {
    "fresh" -> duration(window.opt("resetAtMs"), now)
    "stale" -> "Outdated"
    "offline" -> "Offline"
    "awaitingRefresh" -> "Updating"
    else -> "—"
  }
  fun label(window: JSONObject) = if (window.optString("kind") == "scoped") window.getString("scope") else when(window.optInt("minutes")) {
    300 -> "5h"; 10080 -> "W"; else -> "Quota"
  }
  fun empty(row: JSONObject?) = when (row?.optString("status")) {
    null -> "Open Cindy"; "unauthorized" -> "Reconnect"; "unsupported" -> "Not supported"; "no-windows" -> "No windows"
    else -> if (row != null && row.optBoolean("available") && windows(row).isEmpty()) "No weekly data" else "Couldn’t load"
  }
  fun extra(row: JSONObject?, connection: String, now: Long): String {
    if (row == null || row.optString("platform") != "codex" || row.optString("status") !in listOf("ready", "no-windows") || connection != "online") return "—"
    val observed = (row.opt("observedAtMs") as? Number)?.toDouble() ?: return "—"
    if (observed > now + 60000 || now - observed >= QuotaSnapshot.MAX_AGE_MS) return "—"
    val count = (row.opt("extraResetsRemaining") as? Number)?.toDouble() ?: return "—"
    return if (count.isFinite() && count >= 0 && count <= 9_007_199_254_740_991.0 && count % 1.0 == 0.0) count.toLong().toString() else "—"
  }
}
