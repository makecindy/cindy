package app.cindy.usagewidgets

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.text.DateFormat
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Locale

// Mirrors `UsageWidgetStore` / `MobileUsageWidgetSnapshot` in the app (TypeScript) and the iOS
// widget model. The app writes the store into the app's files directory; the providers read it.

class WidgetSource(json: JSONObject) {
  val id: String = json.getString("id")
  val kind: String = json.getString("kind")
  val name: String = json.getString("name")
  val logo: String? = json.nullableString("logo")
  val monogram: String = json.optString("monogram")
  val value: String? = json.nullableString("value")
  val unit: String? = json.nullableString("unit")
  val label: String? = json.nullableString("label")
  val level: String = json.optString("level", "normal")
  val fill: Double = json.optDouble("fill", 0.0)
  val reserve: Boolean = json.optBoolean("reserve", false)
  val emphasized: Boolean = json.optBoolean("emphasized", false)
  val whenText: String = json.optString("when")
  val resetsAtMs: Double? = if (json.has("resetsAtMs") && !json.isNull("resetsAtMs")) json.getDouble("resetsAtMs") else null
  /** Last reading of a computer that is offline now; drawn faded, `when` says its age. */
  val stale: Boolean = json.optBoolean("stale", false)
  /** Will reset with quota unused at the current pace; the reset time colors as it nears. */
  val unusedAtReset: Boolean = json.optBoolean("unusedAtReset", false)
  val detail: WidgetDetail? = json.optJSONObject("detail")?.let(::WidgetDetail)
}

class WidgetRing(json: JSONObject) {
  val fraction: Double = json.optDouble("fraction", 0.0)
  val color: String = json.optString("color")
}

class WidgetLegend(json: JSONObject) {
  val label: String = json.optString("label")
  val color: String = json.optString("color")
}

class WidgetDetail(json: JSONObject) {
  val title: String = json.optString("title")
  val plan: String = json.optString("plan")
  val rings: List<WidgetRing> = json.optJSONArray("rings").objects().map(::WidgetRing)
  val bigValue: String = json.optString("bigValue")
  val bigUnit: String? = json.nullableString("bigUnit")
  val bigColor: String? = json.nullableString("bigColor")
  val bigCompact: Boolean = json.optBoolean("bigCompact", false)
  val bigCaption: String = json.optString("bigCaption")
  val legend: List<WidgetLegend> = json.optJSONArray("legend").objects().map(::WidgetLegend)
}

class WidgetDay(json: JSONObject) {
  val money: List<Double> = json.optJSONArray("money").doubles()
  val paid: Double = json.optDouble("paid", 0.0)
  val tokens: List<Double> = json.optJSONArray("tokens").doubles()
  /** Value per `WidgetUsage.models` entry, then everything else. */
  val models: List<Double>? = json.optJSONArray("models")?.doubles()
  /** Tokens per `WidgetUsage.models` entry, then everything else. */
  val modelTokens: List<Double>? = json.optJSONArray("modelTokens")?.doubles()
  val total: Double get() = money.sum()
  val totalTokens: Double get() = tokens.sum()
}

class WidgetModel(json: JSONObject) {
  val name: String = json.optString("name")
  val harness: String = json.optString("harness")
}

class WidgetUsage(json: JSONObject) {
  val scope: String = json.optString("scope", "all")
  val days: List<String> = json.optJSONArray("days").strings()
  val daily: List<WidgetDay> = json.optJSONArray("daily").objects().map(::WidgetDay)
  /** Busiest models of the window, in color order; absent from older computers. */
  val models: List<WidgetModel>? = json.optJSONArray("models")?.objects()?.map(::WidgetModel)
}

class WidgetSnapshot(private val json: JSONObject, sources: List<WidgetSource>? = null) {
  val generatedAtMs: Double = json.optDouble("generatedAtMs", 0.0)
  val updatedAtMs: Double? = if (json.has("updatedAtMs") && !json.isNull("updatedAtMs")) json.getDouble("updatedAtMs") else null
  val locale: String = json.optString("locale", "en")
  val moneySymbol: String = json.optString("moneySymbol", "$")
  val sources: List<WidgetSource> = sources ?: json.optJSONArray("sources").objects().map(::WidgetSource)
  val usage: WidgetUsage = WidgetUsage(json.getJSONObject("usage"))
  val strings: Map<String, String> = json.optJSONObject("strings")?.let { strings ->
    strings.keys().asSequence().associateWith { strings.getString(it) }
  } ?: emptyMap()

  fun withSources(sources: List<WidgetSource>) = WidgetSnapshot(json, sources)
}

/**
 * A chosen account as a widget stores it: the source id, logo and name in one string, the same
 * format as `AccountKey` in the iOS widget. Each computer names its own connections, so the same
 * subscription can have another id there; the logo and name find it.
 */
class AccountKey(val id: String, val logo: String?, val name: String) {
  constructor(source: WidgetSource) : this(source.id, source.logo, source.name)

  val encoded: String get() = listOf(id, logo ?: "", name).joinToString(SEPARATOR)

  companion object {
    private const val SEPARATOR = "\u001F"

    fun decode(encoded: String): AccountKey {
      val parts = encoded.split(SEPARATOR)
      return AccountKey(parts[0], parts.getOrNull(1)?.ifEmpty { null }, if (parts.size > 2) parts.drop(2).joinToString(SEPARATOR) else "")
    }

    /** The sources the keys name, in key order and each once. */
    fun matching(keys: List<String>, sources: List<WidgetSource>): List<WidgetSource> {
      val found = mutableListOf<WidgetSource>()
      for (key in keys.map(::decode)) {
        val open = sources.filter { source -> found.none { it.id == source.id } }
        (open.firstOrNull { it.id == key.id } ?: open.firstOrNull { it.logo == key.logo && it.name == key.name })?.let(found::add)
      }
      return found
    }
  }
}

sealed class WidgetState {
  class Snapshot(val receivedAtMs: Double, val deviceName: String, val snapshot: WidgetSnapshot) : WidgetState()
  object UpdateDesktop : WidgetState()
  object Empty : WidgetState()

  val snapshotOrNull: WidgetSnapshot? get() = (this as? Snapshot)?.snapshot

  /**
   * The quota widget's arrangement, like the Mac menu bar's settings: pinned accounts first in
   * their order, hidden ones left out, the rest (accounts added later included) after them in the
   * computer's order. Null when it changes nothing; hiding every account shows them all.
   */
  fun arranged(pinned: List<String>, hidden: List<String>): Pair<WidgetState, Int>? {
    if (this !is Snapshot) return null
    val sources = snapshot.sources
    val hiddenIds = AccountKey.matching(hidden, sources).map { it.id }.toSet()
    val first = AccountKey.matching(pinned, sources).filter { it.id !in hiddenIds }
    val firstIds = first.map { it.id }.toSet()
    val shown = first + sources.filter { it.id !in hiddenIds && it.id !in firstIds }
    if ((first.isEmpty() && hiddenIds.isEmpty()) || shown.isEmpty()) return null
    return Snapshot(receivedAtMs, deviceName, snapshot.withSources(shown)) to first.size
  }

  companion object {
    fun parse(json: JSONObject?): WidgetState {
      if (json == null) return Empty
      return try {
        when (json.optString("kind")) {
          "snapshot" -> Snapshot(
            json.getDouble("receivedAtMs"), json.optString("deviceName"), WidgetSnapshot(json.getJSONObject("snapshot")),
          )
          "update-desktop" -> UpdateDesktop
          else -> Empty
        }
      } catch (_: Exception) {
        Empty
      }
    }
  }
}

/** `UsageWidgetStore` in the app: every computer's latest state and the automatic choice. */
class WidgetStore(json: JSONObject) {
  class Computer(val id: String, val name: String)

  val autoDeviceId: String? = json.nullableString("autoDeviceId")
  val computers: List<Computer> = json.optJSONArray("computers").objects().map { Computer(it.getString("id"), it.optString("name")) }
  private val states: JSONObject = json.optJSONObject("states") ?: JSONObject()

  fun state(deviceId: String?): WidgetState = WidgetState.parse(deviceId?.let { states.optJSONObject(it) })

  companion object {
    const val AUTO = "auto"
    private const val FILE = "usage-widget-snapshot.json"
    private const val PREFS = "cindy-usage-widgets"
    private const val PINS_KEY = "usageWidgetPins"
    private const val PIN_MAX_AGE_MS = 2L * 24 * 3600 * 1000

    /** Not backed up: quota readings belong to the computers, not to a restored phone. */
    fun file(context: Context): File = File(context.noBackupFilesDir, FILE)

    fun load(context: Context): WidgetStore? = try {
      val file = file(context)
      if (file.exists()) WidgetStore(JSONObject(file.readText())) else null
    } catch (_: Exception) {
      null
    }

    /** The state of the computer a widget is set to; `auto` follows the app's choice. */
    fun loadState(context: Context, computer: String?): WidgetState {
      val store = load(context) ?: return WidgetState.Empty
      val id = if (computer == null || computer == AUTO) store.autoDeviceId else computer
      return store.state(id)
    }

    private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun computerOf(context: Context, appWidgetId: Int): String = prefs(context).getString("computer.$appWidgetId", AUTO) ?: AUTO

    fun setComputer(context: Context, appWidgetId: Int, computer: String) {
      prefs(context).edit().putString("computer.$appWidgetId", computer).apply()
    }

    /**
     * Signing out or switching account: every widget goes back to "automatic" with no placed or hidden
     * accounts, and the recorded computers go. Those values name the previous account's computers and
     * accounts, which the next account must neither see nor stay bound to.
     */
    fun clearAccountPreferences(context: Context) {
      val prefs = prefs(context)
      val editor = prefs.edit().remove(PINS_KEY)
      for (key in prefs.all.keys) {
        if (key.startsWith("computer.") || key.startsWith("pinned.") || key.startsWith("hidden.")) editor.remove(key)
      }
      editor.apply()
    }

    fun forget(context: Context, appWidgetId: Int) {
      prefs(context).edit().remove("computer.$appWidgetId").remove("pinned.$appWidgetId").remove("hidden.$appWidgetId").apply()
    }

    /** Accounts the quota widget places first ([AccountKey] strings, in order). */
    fun pinnedOf(context: Context, appWidgetId: Int): List<String> = keys(context, "pinned.$appWidgetId")

    /** Accounts the quota widget leaves out ([AccountKey] strings). */
    fun hiddenOf(context: Context, appWidgetId: Int): List<String> = keys(context, "hidden.$appWidgetId")

    fun setAccounts(context: Context, appWidgetId: Int, pinned: List<String>, hidden: List<String>) {
      prefs(context).edit()
        .putString("pinned.$appWidgetId", JSONArray(pinned).toString())
        .putString("hidden.$appWidgetId", JSONArray(hidden).toString())
        .apply()
    }

    private fun keys(context: Context, name: String): List<String> = try {
      JSONArray(prefs(context).getString(name, null) ?: "[]").strings()
    } catch (_: Exception) {
      emptyList()
    }

    /** Tells the app this computer has a widget, so it asks it on each refresh. */
    fun recordPin(context: Context, deviceId: String) {
      val now = System.currentTimeMillis()
      val pins = pinMap(context).filterValues { now - it < PIN_MAX_AGE_MS }.toMutableMap()
      pins[deviceId] = now
      val json = JSONObject()
      pins.forEach { (key, at) -> json.put(key, at) }
      prefs(context).edit().putString(PINS_KEY, json.toString()).apply()
    }

    fun pinnedDeviceIds(context: Context): List<String> {
      val now = System.currentTimeMillis()
      return pinMap(context).filterValues { now - it < PIN_MAX_AGE_MS }.keys.sorted()
    }

    private fun pinMap(context: Context): Map<String, Long> = try {
      val json = JSONObject(prefs(context).getString(PINS_KEY, null) ?: "{}")
      json.keys().asSequence().associateWith { json.getLong(it) }
    } catch (_: Exception) {
      emptyMap()
    }
  }
}

/** A string field that may be missing, an explicit JSON null (`optString` would turn that into "null") or empty. */
private fun JSONObject.nullableString(name: String): String? =
  if (!has(name) || isNull(name)) null else optString(name).ifEmpty { null }

private fun JSONArray?.objects(): List<JSONObject> = this?.let { array -> (0 until array.length()).mapNotNull { array.optJSONObject(it) } } ?: emptyList()
private fun JSONArray?.doubles(): List<Double> = this?.let { array -> (0 until array.length()).map { array.optDouble(it, 0.0) } } ?: emptyList()
private fun JSONArray?.strings(): List<String> = this?.let { array -> (0 until array.length()).map { array.optString(it) } } ?: emptyList()

/** Sentences the computer does not send: empty states and the widget gallery. */
object WidgetText {
  private var table: Map<String, Map<String, String>>? = null

  private fun table(context: Context): Map<String, Map<String, String>> = table ?: synchronized(this) {
    table ?: run {
      val json = context.assets.open("usage-widgets/text.json").bufferedReader().use { JSONObject(it.readText()) }
      json.keys().asSequence().associateWith { lang ->
        val entries = json.getJSONObject(lang)
        entries.keys().asSequence().associateWith { entries.getString(it) }
      }.also { table = it }
    }
  }

  fun language(locale: Locale): String {
    val id = locale.toLanguageTag()
    return when {
      id.startsWith("zh") -> if (id.contains("Hant") || id.endsWith("TW") || id.endsWith("HK") || id.endsWith("MO")) "zh-Hant" else "zh-Hans"
      id.startsWith("ja") -> "ja"
      id.startsWith("ko") -> "ko"
      id.startsWith("de") -> "de"
      id.startsWith("es") -> "es"
      id.startsWith("fr") -> "fr"
      id.startsWith("pt") -> if (id.endsWith("PT")) "pt-PT" else "pt-BR"
      else -> "en"
    }
  }

  fun text(context: Context, key: String, locale: Locale = Locale.getDefault()): String {
    val table = table(context)
    return table[language(locale)]?.get(key) ?: table["en"]?.get(key) ?: key
  }
}

/**
 * Formatting shared by both widgets. Templates come from the computer's menu bar strings; the few
 * widget-only sentences live in [WidgetText]. `nowMs` is the draw time, so countdowns stay right.
 */
class WidgetFormat(val context: Context, val snapshot: WidgetSnapshot?, val nowMs: Long) {
  val locale: Locale = snapshot?.locale?.let(Locale::forLanguageTag) ?: Locale.getDefault()

  fun s(key: String, values: Map<String, String> = emptyMap()): String {
    var text = snapshot?.strings?.get(key) ?: WidgetText.text(context, key, locale)
    for ((name, value) in values) text = text.replace("{{$name}}", value)
    return text
  }

  fun text(key: String): String = WidgetText.text(context, key, locale)

  fun money(value: Double): String {
    val symbol = snapshot?.moneySymbol ?: "$"
    return when {
      value >= 10_000 -> symbol + String.format(Locale.US, "%.1fk", value / 1000)
      value >= 100 -> symbol + String.format(Locale.US, "%,d", Math.round(value))
      else -> symbol + String.format(Locale.US, "%.2f", value)
    }
  }

  fun tokens(value: Double): String {
    val millions = value / 1_000_000
    return when {
      millions >= 1000 -> String.format(Locale.US, "%.1fB", millions / 1000)
      millions >= 1 -> "${Math.round(millions)}M"
      value >= 1000 -> "${Math.round(value / 1000)}K"
      else -> "${Math.round(maxOf(0.0, value))}"
    }
  }

  /** "5天9时" from the reset time, so the countdown stays right between refreshes. */
  fun whenText(source: WidgetSource, coarse: Boolean = false): String {
    val resetsAtMs = source.resetsAtMs ?: return source.whenText
    val ms = resetsAtMs - nowMs
    if (ms <= 0) return text("reset")
    val minutes = maxOf(1, (ms / 60_000).toInt())
    val d = minutes / 1440
    val h = (minutes % 1440) / 60
    val m = minutes % 60
    return when {
      d > 0 -> if (h > 0 && !coarse) s("durationShort.daysHours", mapOf("d" to "$d", "h" to "$h")) else s("durationShort.days", mapOf("d" to "$d"))
      h > 0 -> if (m > 0 && !coarse) s("durationShort.hoursMinutes", mapOf("h" to "$h", "m" to "$m")) else s("durationShort.hours", mapOf("h" to "$h"))
      else -> s("durationShort.minutes", mapOf("m" to "$m"))
    }
  }

  /**
   * Reset-time color (`resetTimeLevel` in `@cindy/maker-shared/quota-level`): only for quota that
   * will go unused, a day or less to go is yellow, six hours or less red.
   */
  fun resetLevel(source: WidgetSource): String {
    val resetsAtMs = source.resetsAtMs
    if (!source.unusedAtReset || resetsAtMs == null) return "normal"
    val leftHours = (resetsAtMs - nowMs) / 3_600_000
    return when {
      leftHours <= 0 -> "normal"
      leftHours <= 6 -> "error"
      leftHours <= 24 -> "warn"
      else -> "normal"
    }
  }

  /** Age of the quota readings; null when fresh enough not to mention. */
  fun staleLabel(minimumHours: Double): String? {
    val updated = snapshot?.updatedAtMs ?: snapshot?.generatedAtMs ?: return null
    val seconds = maxOf(0.0, (nowMs - updated) / 1000)
    return if (seconds >= minimumHours * 3600) updatedLabel(seconds) else null
  }

  fun updatedLabel(): String {
    val updated = snapshot?.updatedAtMs ?: snapshot?.generatedAtMs ?: return ""
    return updatedLabel(maxOf(0.0, (nowMs - updated) / 1000))
  }

  private fun updatedLabel(seconds: Double): String = when {
    seconds < 60 -> s("updatedJustNow")
    seconds < 3600 -> s("updatedMinutes", mapOf("n" to "${(seconds / 60).toInt()}"))
    seconds < 86400 -> s("updatedHours", mapOf("n" to "${(seconds / 3600).toInt()}"))
    else -> s("updatedDays", mapOf("n" to "${(seconds / 86400).toInt()}"))
  }

  private fun calendar(iso: String): Calendar {
    val parts = iso.split("-").mapNotNull { it.toIntOrNull() }
    return Calendar.getInstance().apply {
      if (parts.size == 3) set(parts[0], parts[1] - 1, parts[2], 12, 0, 0) else timeInMillis = nowMs
    }
  }

  fun isToday(iso: String): Boolean {
    val day = calendar(iso)
    val today = Calendar.getInstance().apply { timeInMillis = nowMs }
    return day.get(Calendar.YEAR) == today.get(Calendar.YEAR) && day.get(Calendar.DAY_OF_YEAR) == today.get(Calendar.DAY_OF_YEAR)
  }

  private fun formatted(iso: String, skeleton: String): String {
    val pattern = android.text.format.DateFormat.getBestDateTimePattern(locale, skeleton)
    return SimpleDateFormat(pattern, locale).format(calendar(iso).time)
  }

  fun monthDay(iso: String): String = formatted(iso, "MMMd")

  fun weekdayNarrow(iso: String): String = formatted(iso, "EEEEE")

  fun weekday(iso: String): String = formatted(iso, "EEE")
}
