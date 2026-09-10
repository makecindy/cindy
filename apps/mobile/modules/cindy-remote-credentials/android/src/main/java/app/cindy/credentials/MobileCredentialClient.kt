package app.cindy.credentials

import android.content.Context
import android.os.SystemClock
import androidx.fragment.app.FragmentActivity
import kotlinx.coroutines.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import org.json.JSONObject
import com.nimbusds.jose.util.Base64
import java.security.KeyPair

/** Serialized on Main. HTTPS suspends on IO; every continuation checks its owner. */
internal class MobileCredentialClient(context: Context, activity: () -> FragmentActivity?,
  private val invalidated: (String) -> Unit) {
  private data class Owner(val realm: String, val member: String, val authDevice: String)
  private class Session(val local: VerifiedIdentity, val remote: VerifiedIdentity, val channel: CredentialChannel) {
    val handle = uuid()
    var account: JSONObject? = null
    var attempt: String? = null
    var toSave: PreparedCredential? = null
    var authorized = false
    var usedSaved = false
    var locale = "en"
    var verifiedUntil = SystemClock.elapsedRealtime() + 30_000
    val commands = mutableMapOf<String, String>()
    val abandoned = ArrayDeque<String>()
    fun binding() = canonical(json("realm" to local.realm, "membership" to local.membership,
      "controller" to local.id, "target" to remote.id, "targetThumbprint" to remote.thumbprint,
      "systemRecord" to account!!.getString("recordID")))
    fun close() { toSave?.ciphertext?.fill(0); toSave = null; attempt = null; commands.clear(); abandoned.clear(); channel.close() }
  }
  private val installation by lazy { CredentialInstallation(context) }
  private val vault by lazy { CredentialVault(context, installation, activity) }
  private val configureLock = Mutex()
  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
  private var owner: Owner? = null
  private var epoch = 0L
  private var token = ""
  private var key: KeyPair? = null
  private var identity: VerifiedIdentity? = null
  private var session: Session? = null
  private var monitor: Job? = null
  var foreground = true
  suspend fun configure(realm: String, member: String, authDevice: String, token: String): String = configureLock.withLock {
    requireCredential(realm in setOf("global", "cn") && member.isNotEmpty() && authDevice.isNotEmpty(), "CREDENTIAL_INVALID_IDENTITY")
    val next = Owner(realm, member, authDevice)
    if (owner != next) { reset(); owner = next }
    this.token = token
    val generation = epoch; val api = CredentialDirectory(realm, member)
    val signing = key ?: installation.key(realm)
    val current = identity?.let { api.lookup(it.id, token) } ?: api.enroll(signing, token)
    requireCredential(epoch == generation && owner == next, "CREDENTIAL_CANCELLED")
    requireCredential(canonical(current.publicKey) == canonical(publicJwk(signing.public as java.security.interfaces.ECPublicKey)), "CREDENTIAL_INVALID_IDENTITY")
    key = signing; identity = current; current.id
  }
  fun updateToken(realm: String, member: String, token: String) {
    requireCredential(owner?.realm == realm && owner?.member == member, "CREDENTIAL_CANCELLED"); this.token = token
  }
  suspend fun headers(method: String? = null, body: Map<String, String>? = null): Map<String, String> {
    val owner = owner ?: throw CredentialFailure("CREDENTIAL_UNAVAILABLE")
    val key = key ?: throw CredentialFailure("CREDENTIAL_UNAVAILABLE")
    val identity = identity ?: throw CredentialFailure("CREDENTIAL_UNAVAILABLE")
    val generation = epoch
    val headers = CredentialDirectory(owner.realm, owner.member).headers(key, identity.id, owner.authDevice, token,
      method, body?.let { JSONObject(it) })
    requireCredential(epoch == generation, "CREDENTIAL_CANCELLED"); return headers
  }
  suspend fun begin(target: String): Map<String, String> {
    requireCredential(foreground, "CREDENTIAL_UNAVAILABLE")
    val owner = owner ?: throw CredentialFailure("CREDENTIAL_UNAVAILABLE")
    val key = key ?: throw CredentialFailure("CREDENTIAL_UNAVAILABLE")
    val identity = identity ?: throw CredentialFailure("CREDENTIAL_UNAVAILABLE")
    close(); val generation = epoch
    val api = CredentialDirectory(owner.realm, owner.member)
    val (local, remote) = coroutineScope {
      val a = async { api.lookup(identity.id, token) }; val b = async { api.lookup(target, token) }; a.await() to b.await()
    }
    requireCredential(epoch == generation && this.owner == owner && foreground, "CREDENTIAL_CANCELLED")
    val state = Session(local, remote, CredentialChannel(local, remote, key, SystemClock::elapsedRealtime))
    session = state; return mapOf("handle" to state.handle, "offer" to state.channel.offer())
  }
  fun accept(handle: String, offer: String): String {
    val state = current(handle); state.channel.accept(offer); return state.channel.seal(ByteArray(0), "ready")
  }
  suspend fun password(handle: String, saved: Boolean, locale: String, theme: String): String {
    val state = current(handle); state.channel.requireConfirmed()
    requireCredential(foreground && state.account != null && state.attempt == null && !state.authorized)
    state.locale = locale
    var secret: ByteArray? = null; var remember = false
    if (saved) {
      try { secret = vault.read(state.binding(), locale); state.usedSaved = true }
      catch (error: CredentialFailure) { if (error.fixedCode != "CREDENTIAL_UNAVAILABLE") throw error }
    }
    if (secret == null) {
      requireCredential(session === state && foreground, "CREDENTIAL_CANCELLED"); current(handle); state.channel.requireConfirmed()
      val entered = vault.enter(state.account!!.getString("name"), state.remote.id, locale, theme)
      secret = entered.first; remember = entered.second; state.usedSaved = false
    }
    try {
      requireCredential(session === state && foreground, "CREDENTIAL_CANCELLED"); current(handle); state.channel.requireConfirmed()
      requireCredential(secret.isNotEmpty() && secret.size <= 4096 && !secret.contains(0))
      current(handle)
      val prepared = if (remember) vault.prepare(secret, state.binding(), locale) {
        session === state && foreground && SystemClock.elapsedRealtime() < state.verifiedUntil
      } else null
      requireCredential(session === state && foreground, "CREDENTIAL_CANCELLED"); current(handle)
      val id = uuid()
      val packet = state.channel.seal(canonical(json("id" to id, "account" to state.account,
        "password" to b64(secret))).toByteArray(), "authenticate")
      state.attempt = id; state.toSave = prepared
      return packet
    } finally { secret.fill(0) }
  }
  fun authenticationStatus(handle: String): String {
    val state = current(handle); requireCredential(state.attempt != null)
    return state.channel.seal(canonical(json("id" to state.attempt)).toByteArray(), "authentication-status")
  }
  fun request(handle: String, body: String): Map<String, String> {
    val state = current(handle); state.channel.requireConfirmed()
    val op = JSONObject(body).getString("op")
    requireCredential(state.authorized && state.commands.size < 64 && op in operations)
    val id = uuid(); val ciphertext = state.channel.seal(canonical(json("id" to id, "payload" to b64(body.toByteArray()))).toByteArray(), "request")
    state.commands[id] = op; return mapOf("id" to id, "ciphertext" to ciphertext)
  }
  fun abandon(handle: String, id: String) {
    val state = current(handle)
    if (state.commands.remove(id) != null) { state.abandoned.addLast(id); if (state.abandoned.size > 256) state.abandoned.removeFirst() }
  }
  suspend fun receive(handle: String, ciphertext: String): String {
    val state = current(handle)
    try {
      val (purpose, bytes) = state.channel.open(ciphertext)
      val value = JSONObject(String(bytes, Charsets.UTF_8)); bytes.fill(0)
      val result = when (purpose) {
        "ready" -> {
          requireCredential(state.account == null && runCatching { java.util.UUID.fromString(value.getString("recordID")) }.isSuccess &&
            value.getString("name").isNotEmpty() && value.getString("name").toByteArray().size <= 256 &&
            value.getString("name").none { it.isISOControl() }, "CREDENTIAL_INVALID_IDENTITY")
          state.account = json("recordID" to value.getString("recordID"), "name" to value.getString("name")); startMonitor(state)
          json("kind" to "ready", "account" to value.getString("name"), "target" to state.remote.id, "saved" to vault.contains(state.binding()))
        }
        "authentication-result" -> {
          requireCredential(state.attempt != null && value.getString("id") == state.attempt &&
            canonical(value.getJSONObject("account")) == canonical(state.account) && value.get("accepted") is Boolean, "CREDENTIAL_INVALID_IDENTITY")
          val accepted = value.getBoolean("accepted"); state.authorized = accepted
          val failure = value.optString("failure", "")
          if (failure.isNotEmpty()) {
            requireCredential(!accepted && failure in setOf("CREDENTIAL_CANCELLED", "CREDENTIAL_EXPIRED",
              "CREDENTIAL_UNAVAILABLE", "CREDENTIAL_UNLOCK_UNAVAILABLE", "CREDENTIAL_ACCESSIBILITY_REQUIRED",
              "CREDENTIAL_INVALID_MESSAGE", "CREDENTIAL_INVALID_IDENTITY"))
            state.toSave?.ciphertext?.fill(0); state.toSave = null; state.attempt = null
            throw CredentialFailure(failure)
          }
          if (!accepted) {
            state.toSave?.ciphertext?.fill(0); state.toSave = null; state.attempt = null
            if (state.usedSaved) vault.forget(state.binding())
          }
          json("kind" to "authenticated", "accepted" to accepted)
        }
        "response" -> {
          requireCredential(state.authorized); val id = value.getString("id")
          if (state.abandoned.remove(id)) return canonical(json("kind" to "ignored"))
          val op = state.commands.remove(id) ?: throw CredentialFailure("CREDENTIAL_INVALID_MESSAGE")
          val body = String(Base64(value.getString("payload")).decode(), Charsets.UTF_8)
          requireCredential(value.get("success") is Boolean); val success = value.getBoolean("success")
          var saved = false
          if (op == "start" && success) {
            val lease = JSONObject(body)
            requireCredential(lease.getString("lease").isNotEmpty() && lease.getString("lease").toByteArray().size <= 128 &&
              lease.get("display") is JSONObject && lease.get("controlling") is Boolean)
            val secret = state.toSave; state.toSave = null; state.attempt = null
            if (secret != null) {
              try {
                vault.commit(secret) { session === state && foreground && SystemClock.elapsedRealtime() < state.verifiedUntil }
                saved = true
              } catch (_: Exception) { saved = false }
              finally { secret.ciphertext.fill(0) }
              requireCredential(session === state && foreground, "CREDENTIAL_CANCELLED")
            }
          }
          json("kind" to "response", "id" to id, "body" to body, "success" to success, "saved" to saved)
        }
        else -> throw CredentialFailure("CREDENTIAL_INVALID_MESSAGE")
      }
      return canonical(result)
    } catch (error: Exception) { if (session === state) close(); throw error }
  }
  fun forget(handle: String) { vault.forget(current(handle).binding()) }
  fun end(handle: String): String? {
    val state = session ?: return null
    if (state.handle != handle) return null
    val packet = runCatching { state.channel.seal(ByteArray(0), "revoke") }.getOrNull()
    close(); return packet
  }
  fun close(handle: String) { if (session?.handle == handle) close() }
  fun close() {
    val state = session; epoch++; session = null; state?.close(); monitor?.cancel(); monitor = null
    vault.cancel(); if (state != null) invalidated(state.handle)
  }
  fun reset() { close(); owner = null; token = ""; key = null; identity = null }
  fun destroy() { reset(); scope.cancel() }
  private fun current(handle: String): Session {
    val state = session
    requireCredential(state != null && state.handle == handle, "CREDENTIAL_INVALID_IDENTITY")
    if (SystemClock.elapsedRealtime() >= state!!.verifiedUntil) { close(); throw CredentialFailure("CREDENTIAL_EXPIRED") }
    return state
  }
  private fun startMonitor(state: Session) {
    monitor?.cancel()
    monitor = scope.launch {
      while (isActive && session === state) {
        delay(10_000)
        val owner = owner ?: return@launch
        try {
          state.channel.requireConfirmed(); val api = CredentialDirectory(owner.realm, owner.member)
          val (local, remote) = coroutineScope {
            val a = async { api.lookup(state.local.id, token) }; val b = async { api.lookup(state.remote.id, token) }; a.await() to b.await()
          }
          if (session !== state) return@launch
          requireCredential(local.thumbprint == state.local.thumbprint && remote.thumbprint == state.remote.thumbprint, "CREDENTIAL_INVALID_IDENTITY")
          state.verifiedUntil = SystemClock.elapsedRealtime() + 30_000
        } catch (_: CancellationException) { return@launch }
          catch (error: Exception) {
            if (session !== state) return@launch
            if ((error as? CredentialFailure)?.fixedCode == "CREDENTIAL_INVALID_IDENTITY" ||
              SystemClock.elapsedRealtime() >= state.verifiedUntil) { close(); return@launch }
          }
      }
    }
  }
  companion object {
    private val operations = setOf("capabilities", "permissions", "start", "heartbeat", "stop", "frame", "control",
      "presentation", "input", "offer", "ice", "clipboard", "clipboardContent", "displayModes", "resolution")
  }
}
