package expo.modules.cindyquotawidget

import android.content.Context
import android.util.AtomicFile
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

internal object QuotaSnapshot {
  const val MAX_AGE_MS = 15 * 60 * 1000L
  private fun number(value: Any?): Double? = (value as? Number)?.toDouble()?.takeIf { it.isFinite() }
  private fun time(value: Any?): Double? = number(value)?.takeIf { it > 0 && it <= 8_640_000_000_000_000.0 }
  private fun nullable(value: Any?): Any = value ?: JSONObject.NULL
  fun empty() = JSONObject().put("version", 2).put("source", "live-source").put("connection", "offline").put("rows", JSONArray())
  fun sanitize(json: String): JSONObject {
    require(json.toByteArray(Charsets.UTF_8).size <= 16384)
    val input = JSONObject(json)
    require(input.opt("version") == 2 && input.optString("source") in listOf("live-source", "demo"))
    require(input.optString("connection") in listOf("online", "offline"))
    val source = input.getJSONArray("rows")
    require(source.length() <= 3)
    val rows = JSONArray()
    val platforms = mutableSetOf<String>()
    for (i in 0 until source.length()) {
      val row = source.getJSONObject(i)
      val platform = row.getString("platform")
      require(platform in listOf("codex", "claude", "xai") && platforms.add(platform))
      val windows = JSONArray()
      val rawWindows = row.getJSONArray("windows")
      require(rawWindows.length() <= 16)
      val kinds = mutableSetOf<String>()
      for (j in 0 until rawWindows.length()) {
        val raw = rawWindows.getJSONObject(j)
        val kind = raw.getString("kind")
        require(kind in listOf("primary", "secondary", "fiveHour", "sevenDay", "week", "scoped") && kinds.add(kind + ":" + raw.optString("scope")))
        val remaining = number(raw.opt("remainingPercent"))?.takeIf { it in 0.0..100.0 }
        val scope = raw.optString("scope").takeIf { it in listOf("Fable", "Opus", "Sonnet", "Haiku", "Mythos") }
        require(kind != "scoped" || scope != null)
        windows.put(JSONObject().put("kind", kind).put("scope", nullable(scope)).put("observedAtMs", nullable(time(raw.opt("observedAtMs"))))
          .put("minutes", nullable(number(raw.opt("minutes"))?.takeIf { it > 0 && it <= 525600 }))
          .put("remainingPercent", nullable(remaining)).put("resetAtMs", nullable(time(raw.opt("resetAtMs")))))
      }
      rows.put(JSONObject().put("platform", platform)
        .put("extraResetsRemaining", nullable(if (platform == "codex") number(row.opt("extraResetsRemaining"))?.takeIf { it >= 0 && it <= 9_007_199_254_740_991.0 && it % 1.0 == 0.0 } else null))
        .put("plan", nullable(row.optString("plan").takeIf { it in listOf("Free", "Plus", "Pro", "Business", "Enterprise", "Edu", "Team", "Max", "SuperGrok", "SuperGrok Heavy") }))
        .put("status", row.optString("status").takeIf { it in listOf("ready", "no-windows", "unavailable", "unsupported", "unauthorized") } ?: "unavailable")
        .put("provenance", row.optString("provenance").takeIf { it in listOf("codex-control", "codex-cache", "claude-control", "claude-event", "grok-subscription") } ?: "unknown").put("available", row.opt("available") == true)
        .put("observedAtMs", nullable(time(row.opt("observedAtMs")))).put("windows", windows))
    }
    return empty().put("source", input.getString("source")).put("connection", input.getString("connection")).put("rows", rows)
  }
  private fun file(context: Context) = AtomicFile(File(context.noBackupFilesDir, "cindy-subscription-quota-v1.json"))
  @Synchronized fun save(context: Context, json: String) {
    val data = sanitize(json).toString().toByteArray(Charsets.UTF_8)
    val file = file(context)
    val stream = file.startWrite()
    try { stream.write(data); file.finishWrite(stream) }
    catch (error: Exception) { file.failWrite(stream); throw error }
  }
  @Synchronized fun load(context: Context): JSONObject = try {
    val file = file(context)
    require(file.baseFile.length() <= 16384)
    sanitize(file.readFully().toString(Charsets.UTF_8))
  } catch (_: Exception) { empty() }
  @Synchronized fun clear(context: Context) {
    val file = file(context)
    file.delete()
    check(!file.baseFile.exists())
  }
  fun state(row: JSONObject, window: JSONObject, connection: String, now: Long): String {
    val observed = time(window.opt("observedAtMs"))
    if (!row.optBoolean("available") || number(window.opt("remainingPercent")) == null || observed == null || observed > now + 60000) return "unavailable"
    if ((time(window.opt("resetAtMs")) ?: Double.MAX_VALUE) <= now) return "awaitingRefresh"
    if (now - observed >= MAX_AGE_MS) return "stale"
    return if (connection == "offline") "offline" else "fresh"
  }
}
