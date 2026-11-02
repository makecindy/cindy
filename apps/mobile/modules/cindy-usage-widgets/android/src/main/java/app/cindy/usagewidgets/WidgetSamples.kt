package app.cindy.usagewidgets

import org.json.JSONArray
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Locale
import kotlin.math.sin

/** Gallery and preview content: shape only, never real account data. */
object WidgetSamples {
  private const val HOUR = 3_600_000.0

  private fun source(
    id: String, logo: String, name: String, value: Double, resetHours: Double, now: Double,
    emphasized: Boolean = false, stale: Boolean = false, unusedAtReset: Boolean = false,
  ): JSONObject = JSONObject()
    .put("id", id).put("kind", "subscription").put("name", name).put("logo", logo).put("monogram", name.take(1).uppercase())
    .put("value", (value * 100).toInt().toString()).put("unit", "%")
    .put("level", if (value <= 0.1) "error" else if (value <= 0.3) "warn" else "normal")
    .put("fill", value).put("reserve", false).put("emphasized", emphasized).put("when", "")
    .put("resetsAtMs", now + resetHours * HOUR).put("stale", stale).put("unusedAtReset", unusedAtReset)

  private fun detail(): JSONObject = JSONObject()
    .put("title", "Claude").put("plan", "Max").put("bigValue", "62").put("bigUnit", "%").put("bigCompact", false)
    .put("bigCaption", "Weekly window")
    .put("rings", JSONArray().put(JSONObject().put("fraction", 0.62).put("color", "claude")).put(JSONObject().put("fraction", 0.4).put("color", "claude2")))
    .put("legend", JSONArray().put(JSONObject().put("label", "Weekly").put("color", "claude")).put(JSONObject().put("label", "5 hours").put("color", "claude2")))

  private fun usage(): JSONObject {
    val days = JSONArray()
    val daily = JSONArray()
    val format = SimpleDateFormat("yyyy-MM-dd", Locale.US)
    for (i in 0 until 30) {
      val date = Calendar.getInstance().apply { add(Calendar.DAY_OF_YEAR, i - 29) }
      days.put(format.format(date.time))
      val wave = 0.65 + 0.35 * sin(i * 0.9)
      daily.put(
        JSONObject()
          .put("money", JSONArray().put(36 * wave).put(20 * (1.2 - wave * 0.5)).put(2.0))
          .put("paid", 2.0)
          .put("tokens", JSONArray().put(7e7 * wave).put(4e7).put(2e6)),
      )
    }
    return JSONObject().put("scope", "all").put("days", days).put("daily", daily)
  }

  /** `variant`: "multi" (the gallery), "single" (one source with the detail ring), "stale" or "offline". */
  fun state(variant: String = "multi", nowMs: Long = System.currentTimeMillis()): WidgetState {
    val now = nowMs.toDouble()
    val sources = JSONArray()
    when (variant) {
      "single" -> sources.put(source("a", "claude", "Claude", 0.62, 2.6, now).put("detail", detail()))
      "offline" -> {
        sources.put(source("a", "claude", "Claude", 0.62, 2.6, now))
        sources.put(source("b", "codex", "Codex", 0.78, 129.0, now, emphasized = true))
        sources.put(source("c", "codex", "Work", 0.39, 52.0, now, stale = true).put("when", "3 hr ago"))
      }
      else -> {
        sources.put(source("a", "claude", "Claude", 0.62, 2.6, now))
        sources.put(source("b", "codex", "Codex", 0.78, 129.0, now, emphasized = true))
        sources.put(source("c", "codex", "Work", 0.39, 52.0, now))
        sources.put(source("d", "codex", "Team", 0.11, 14.4, now, unusedAtReset = true))
      }
    }
    val updated = if (variant == "stale") now - 9 * HOUR else now
    val snapshot = JSONObject()
      .put("version", 1).put("generatedAtMs", now).put("updatedAtMs", updated).put("locale", Locale.getDefault().toLanguageTag())
      .put("moneySymbol", "$").put("sources", sources).put("usage", usage()).put("strings", JSONObject())
    return WidgetState.Snapshot(now, "Mac", WidgetSnapshot(snapshot))
  }
}
