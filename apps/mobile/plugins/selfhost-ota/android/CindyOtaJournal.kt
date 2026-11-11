package expo.modules.updates

import android.content.Context
import android.util.AtomicFile
import android.util.Log
import expo.modules.updates.db.entity.UpdateEntity
import expo.modules.updates.db.enums.UpdateStatus
import org.json.JSONObject
import java.io.File
import java.util.UUID

/**
 * Self-host-only write-ahead journal. Compiled into the isolated Expo Updates
 * source adapter, never autolinked into EAS builds. The journal is authoritative;
 * Expo's persisted override is repaired from it before configuration is read.
 * No account, consent, device identifier, token or user Beta preference lives here.
 */
internal object CindyOtaJournal {
  private const val VERSION = 1
  private const val MAX_ATTEMPTS = 2
  private const val SHARED_ID = "00000000-0000-4000-8000-000000000000"
  private const val CHANNEL_KEY = "x-cindy-update-channel"
  private var storage: AtomicFile? = null
  private var appContext: Context? = null
  private var defaults: UpdatesConfiguration? = null
  private var state: JSONObject? = null
  private var writable = true
  private var activeAttempt: String? = null
  private var embeddedUpdate: UpdateEntity? = null

  data class LaunchChoice(val update: UpdateEntity?)

  fun headers(channel: String): Map<String, String> {
    require(channel in listOf("release", "beta", "canary")) { "Invalid self-host OTA channel" }
    return mapOf("EAS-Client-ID" to SHARED_ID, CHANNEL_KEY to if (channel == "release") "" else channel)
  }

  fun validateHeaders(value: Map<String, String>?) {
    if (value == null) return
    val raw = value[CHANNEL_KEY]
    val channel = if (raw.isNullOrEmpty()) "release" else raw
    require(value == headers(channel)) { "Self-host OTA requires canonical shared headers" }
  }

  @Synchronized
  fun prepare(context: Context): UpdatesConfiguration {
    writable = true
    activeAttempt = null
    embeddedUpdate = null
    appContext = context.applicationContext
    // Explicitly ignore any persisted legacy URL/header override while reading
    // the new binary's identity. This also resolves file:fingerprint natively.
    val original = UpdatesConfiguration(context, null, false, null)
    check(original.originalEmbeddedRequestHeaders == headers("release")) { "Invalid native OTA header contract" }
    check(!original.disableAntiBrickingMeasures) { "Native OTA requires anti-bricking protection" }
    defaults = original
    storage = AtomicFile(File(context.noBackupFilesDir, "cindy-selfhost-ota-v1.json"))
    try {
      val old = try { JSONObject(String(storage!!.readFully(), Charsets.UTF_8)) } catch (_: Exception) { null }
      val compatible = old != null && old.optInt("version") == VERSION &&
        old.optString("runtime") == original.getRuntimeVersion() &&
        old.optString("url") == original.updateUrl.toString() && validState(old)
      val next = if (compatible) JSONObject(old.toString()) else JSONObject()
        .put("version", VERSION).put("runtime", original.getRuntimeVersion())
        .put("url", original.updateUrl.toString())
      // A process death abandons the request, not an already committed download.
      next.remove("request")
      persist(next)
      saveOverride(if (compatible) currentHeaders() else null)
      val effective = currentHeaders()
      return UpdatesConfiguration.create(context, original,
        if (effective == headers("release")) null else UpdatesConfigurationOverride(null, effective))
    } catch (_: Exception) {
      writable = false
      state = null
      runCatching { saveOverride(null) }
      Log.w("CindySelfHostOTA", "Journal unavailable; using embedded safety configuration")
      return original // Do not reread an override that could not be repaired.
    }
  }

  private fun validReceipt(value: JSONObject?): Boolean {
    if (value == null) return true
    return try {
      UUID.fromString(value.getString("id"))
      headers(value.getString("channel"))
      value.getBoolean("embedded")
      value.getLong("commitTime")
      value.optInt("attempts", 0) in 0..MAX_ATTEMPTS
    } catch (_: Exception) { false }
  }

  private fun validState(value: JSONObject): Boolean =
    validReceipt(value.optJSONObject("good")) && validReceipt(value.optJSONObject("pending"))

  // Called only with the manifest read from this signed binary, before Expo's
  // embedded loader / launch selection. Never from a remote manifest response.
  @Synchronized
  fun observeEmbedded(update: UpdateEntity) {
    embeddedUpdate = update
    if (!writable || state == null) return
    try {
      val next = cloneState()
      if (next.optString("binaryId") == update.id.toString()) return
      for (key in listOf("good", "pending")) {
        val receipt = next.optJSONObject(key) ?: continue
        if (receipt.getBoolean("embedded") || receipt.getLong("commitTime") < update.commitTime.time) next.remove(key)
      }
      next.put("binaryId", update.id.toString())
      persist(next)
      saveOverride(currentHeaders())
    } catch (_: Exception) {
      writable = false
      state = null
      Log.w("CindySelfHostOTA", "Unable to migrate binary identity; using embedded safety configuration")
    }
  }

  private fun isCurrentEmbedded(update: UpdateEntity, config: UpdatesConfiguration): Boolean =
    update.id == embeddedUpdate?.id && update.status == UpdateStatus.EMBEDDED &&
      update.runtimeVersion == config.getRuntimeVersion() && update.scopeKey == config.scopeKey &&
      update.url == defaults?.updateUrl && update.requestHeaders == headers("release")

  private fun cloneState(): JSONObject {
    check(writable && state != null) { "Self-host OTA journal unavailable" }
    return JSONObject(state.toString())
  }

  private fun persist(next: JSONObject) {
    val file = checkNotNull(storage)
    val stream = file.startWrite()
    try {
      stream.write(next.toString().toByteArray(Charsets.UTF_8))
      stream.fd.sync()
      file.finishWrite(stream)
    } catch (error: Exception) {
      file.failWrite(stream)
      throw error
    }
    state = next
  }

  private fun saveOverride(requestHeaders: Map<String, String>?) {
    val context = checkNotNull(appContext)
    val editor = context.getSharedPreferences("dev.expo.updates.prefs", Context.MODE_PRIVATE).edit()
    if (requestHeaders == null || requestHeaders == headers("release")) {
      editor.remove("updatesConfigOverride")
    } else {
      // Rebuild the complete entry: saveRequestHeaders alone preserves old URLs.
      editor.putString("updatesConfigOverride", JSONObject().put("requestHeaders", JSONObject(requestHeaders)).toString())
    }
    check(editor.commit()) { "Unable to persist self-host OTA headers" }
  }

  @Synchronized
  fun capabilities(): Map<String, Any> = mapOf(
    "version" to VERSION,
    "runtimeVersion" to (defaults?.getRuntimeVersion() ?: ""),
    "updateUrl" to (defaults?.updateUrl?.toString() ?: ""),
    "available" to (writable && state != null)
  )

  @Synchronized
  fun currentHeaders(): Map<String, String> {
    val receipt = state?.optJSONObject("pending") ?: state?.optJSONObject("good")
    return headers(receipt?.optString("channel") ?: "release")
  }

  @Synchronized
  fun begin(channel: String): String {
    val target = headers(channel)
    val next = cloneState()
    check(!next.has("request")) { "Self-host OTA request already in progress" }
    val token = UUID.randomUUID().toString()
    next.put("request", JSONObject().put("token", token).put("channel", channel))
    persist(next) // Must complete before Expo persists a target header override.
    try {
      UpdatesController.instance.setUpdateRequestHeadersOverride(target)
    } catch (error: Exception) {
      finish(token)
      throw error
    }
    return token
  }

  @Synchronized
  fun finish(token: String) {
    val next = cloneState()
    if (next.optJSONObject("request")?.optString("token") != token) return
    next.remove("request")
    persist(next)
    UpdatesController.instance.setUpdateRequestHeadersOverride(currentHeaders())
  }

  private fun snapshot(update: UpdateEntity): JSONObject? {
    val config = defaults ?: return null
    if (update.runtimeVersion != config.getRuntimeVersion() || update.scopeKey != config.scopeKey) return null
    val embedded = isCurrentEmbedded(update, config)
    val rawChannel = update.requestHeaders?.get(CHANNEL_KEY)
    val channel = if (rawChannel.isNullOrEmpty()) "release" else rawChannel
    if (!embedded && (update.url != config.updateUrl || update.requestHeaders != headers(channel))) return null
    return JSONObject().put("id", update.id.toString()).put("channel", channel)
      .put("embedded", embedded).put("attempts", 0).put("commitTime", update.commitTime.time)
  }

  @Synchronized
  fun downloaded(update: UpdateEntity, config: UpdatesConfiguration) {
    val next = cloneState()
    val request = next.optJSONObject("request") ?: return
    check(config.requestHeaders == headers(request.getString("channel"))) { "Stale self-host OTA download" }
    val receipt = checkNotNull(snapshot(update)) { "Incompatible self-host OTA download" }
    check(!isRejected(update.id.toString())) { "Previously failed self-host OTA update" }
    if (receipt.getString("id") == next.optJSONObject("good")?.optString("id")) return
    if (receipt.getString("id") == next.optJSONObject("pending")?.optString("id")) return
    next.put("pending", receipt)
    persist(next) // Native download has finished; do not depend on a JS callback.
  }

  private fun matches(update: UpdateEntity, receipt: JSONObject, config: UpdatesConfiguration): Boolean {
    if (update.id.toString() != receipt.getString("id") || update.runtimeVersion != config.getRuntimeVersion() ||
      update.scopeKey != config.scopeKey || isRejected(update.id.toString())) return false
    if (update.failedLaunchCount > 0 && update.successfulLaunchCount == 0) return false
    return if (receipt.getBoolean("embedded")) {
      isCurrentEmbedded(update, config)
    } else {
      update.url == defaults?.updateUrl && update.requestHeaders == headers(receipt.getString("channel"))
    }
  }

  @Synchronized
  fun select(updates: List<UpdateEntity>, config: UpdatesConfiguration): LaunchChoice? {
    val safeEmbedded = updates.filter { isCurrentEmbedded(it, config) }.maxByOrNull { it.commitTime }
    val current = state ?: return LaunchChoice(safeEmbedded)
    if (current.optString("runtime") != config.getRuntimeVersion() || current.optString("url") != config.updateUrl.toString()) return null
    val pending = current.optJSONObject("pending")
    if (pending != null) {
      val candidate = updates.find { matches(it, pending, config) }
      if (candidate != null && (pending.optInt("attempts") < MAX_ATTEMPTS || activeAttempt == pending.getString("id"))) return LaunchChoice(candidate)
      try { reject(pending.getString("id")) } catch (_: Exception) { return LaunchChoice(null) }
    }
    state?.optJSONObject("good")?.let { good ->
      updates.find { matches(it, good, config) }?.let { return LaunchChoice(it) }
    }
    // Only the two explicit receipts may cross channel/filter boundaries. Never
    // broaden selection to arbitrary cached OTA updates or an abandoned download.
    return LaunchChoice(safeEmbedded)
  }

  @Synchronized
  fun selected(update: UpdateEntity) {
    if (!writable || state == null) return
    val next = cloneState()
    val pending = next.optJSONObject("pending") ?: return
    if (pending.getString("id") != update.id.toString()) return
    if (activeAttempt == pending.getString("id")) return
    pending.put("attempts", pending.optInt("attempts") + 1)
    persist(next)
    activeAttempt = pending.getString("id")
  }

  @Synchronized
  fun confirmed(update: UpdateEntity) {
    if (!writable || state == null) return
    val receipt = snapshot(update) ?: return
    val next = cloneState()
    next.put("good", receipt)
    if (next.optJSONObject("pending")?.optString("id") == update.id.toString()) next.remove("pending")
    try {
      persist(next)
      activeAttempt = null
    } catch (_: Exception) {
      Log.w("CindySelfHostOTA", "Unable to confirm launch; retaining previous safe receipt")
    }
  }

  private fun isRejected(id: String): Boolean = state?.optJSONObject("rejected")?.optBoolean(id) == true

  private fun reject(id: String) {
    val next = cloneState()
    if (next.optJSONObject("pending")?.optString("id") == id) next.remove("pending")
    val rejected = next.optJSONObject("rejected") ?: JSONObject()
    rejected.put(id, true)
    next.put("rejected", rejected)
    persist(next)
    activeAttempt = null
    saveOverride(currentHeaders())
  }

  @Synchronized
  fun failed(update: UpdateEntity?): Boolean {
    if (!writable || update == null || state?.optJSONObject("pending")?.optString("id") != update.id.toString()) return false
    return try {
      reject(update.id.toString())
      // Same-process error recovery also needs the controller's in-memory config.
      UpdatesController.instance.setUpdateRequestHeadersOverride(currentHeaders())
      true
    } catch (_: Exception) {
      Log.w("CindySelfHostOTA", "Unable to restore launch configuration")
      false
    }
  }

  @Synchronized
  fun pinned(id: UUID): Boolean = listOf("good", "pending").any {
    state?.optJSONObject(it)?.optString("id") == id.toString()
  }

  @Synchronized
  fun rolledBackToEmbedded() {
    val next = cloneState()
    next.remove("good")
    next.remove("pending")
    persist(next)
    activeAttempt = null
    saveOverride(null)
    UpdatesController.instance.setUpdateRequestHeadersOverride(headers("release"))
  }
}
