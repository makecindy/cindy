package app.cindy.agentnet

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import android.util.Base64
import java.io.File
import java.security.KeyStore
import java.util.UUID
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import org.json.JSONObject
import android.net.Uri

/** Background access is limited to an independent notification key and public trust. */
object AgentNetNotifications {
  init { System.loadLibrary("cindy_agent_net_bridge") }
  private var ticket = UUID.randomUUID().toString()
  private external fun nativeOpen(input: ByteArray): String?
  private fun file(context: Context) = AtomicFile(File(context.noBackupFilesDir, "agent-net-notifications-v2"))
  @JvmStatic @Synchronized fun begin(context: Context): String {
    ticket = UUID.randomUUID().toString()
    file(context).delete()
    return ticket
  }
  @JvmStatic @Synchronized fun scope(context: Context): String? = read(context)?.optString("scope")?.takeIf { it.isNotEmpty() }
  @JvmStatic @Synchronized fun configure(context: Context, expected: String, raw: String) {
    val config = JSONObject(raw)
    val now = System.currentTimeMillis()
    val version = config.getInt("version")
    require(expected == ticket && raw.toByteArray().size <= 512 * 1024 && version in 2..3
      && (version != 3 || config.optJSONObject("peerExpiresAt") != null)
      && decode(config.getString("secret")).size == 32 && config.getJSONObject("peers").length() <= 2048
      && config.getLong("expiresAt") > now && config.getLong("expiresAt") <= now + 14 * 86_400_000L)
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.ENCRYPT_MODE, key())
    val clear = raw.toByteArray(Charsets.UTF_8)
    val encrypted = try { cipher.iv + cipher.doFinal(clear) } finally { clear.fill(0) }
    val target = file(context)
    val output = target.startWrite()
    try { output.write(encrypted); target.finishWrite(output) }
    catch (error: Exception) { target.failWrite(output); throw error }
  }
  @JvmStatic @Synchronized fun open(context: Context, deepLink: String): String? {
    return try {
      val config = read(context) ?: return null
      val uri = Uri.parse(deepLink)
      if (uri.scheme != "cindy" || uri.host != "agent-net-notification") return null
      val envelope = uri.getQueryParameter("envelope") ?: return null
      if (envelope.length > 2600) return null
      val result = JSONObject(nativeOpen(JSONObject().put("config", config).put("envelope", envelope)
        .put("now", System.currentTimeMillis()).toString().toByteArray(Charsets.UTF_8)) ?: return null)
      if (!result.optBoolean("ok")) return null
      val value = result.getJSONObject("value")
      val scopeKey = config.getString("scope")
      val history = context.getSharedPreferences("cindy-agent-net-notification-ids", Context.MODE_PRIVATE)
      val previous = if (history.getString("scope", "") == scopeKey) JSONObject(history.getString("ids", "{}")!!) else JSONObject()
      val seen = JSONObject()
      val now = System.currentTimeMillis()
      previous.keys().forEach { if (previous.optLong(it) > now) seen.put(it, previous.getLong(it)) }
      val id = value.getString("id")
      if (seen.has(id) || seen.length() >= 256) return null
      seen.put(id, value.getLong("expiresAt"))
      if (!history.edit().putString("scope", scopeKey).putString("ids", seen.toString()).commit()) return null
      if (scope(context) != scopeKey) return null
      val payload = JSONObject(String(decode(value.getString("payload")), Charsets.UTF_8))
      if (!config.optBoolean("preview", true)) {
        payload.put("title", "Cindy").put("body", ""); payload.remove("sender")
      }
      payload.put("agentNetScope", scopeKey).toString()
    } catch (_: Exception) { null }
  }
  private fun read(context: Context): JSONObject? = try {
    val input = file(context)
    if (input.baseFile.length() > 512 * 1024 + 64) null else {
      val bytes = input.readFully()
      if (bytes.size < 28) null else {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, bytes.copyOfRange(0, 12)))
        val clear = cipher.doFinal(bytes, 12, bytes.size - 12)
        try { JSONObject(String(clear, Charsets.UTF_8)) } finally { clear.fill(0) }
      }
    }
  } catch (_: Exception) { null }
  private fun key(): SecretKey {
    val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    val alias = "cindy-agent-net-notifications-v2"
    (store.getKey(alias, null) as? SecretKey)?.let { return it }
    return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
      init(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        .setKeySize(256).setUserAuthenticationRequired(false).build())
    }.generateKey()
  }
  private fun decode(value: String): ByteArray = Base64.decode(value, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
}
