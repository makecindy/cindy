package app.cindy.credentials

import com.nimbusds.jose.*
import com.nimbusds.jose.crypto.*
import com.nimbusds.jose.jwk.*
import org.json.JSONArray
import org.json.JSONObject
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.MessageDigest
import java.security.interfaces.ECPrivateKey
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import com.nimbusds.jose.util.Base64
import com.nimbusds.jose.util.Base64URL
import java.util.UUID

internal class CredentialFailure(val fixedCode: String) : Exception(fixedCode)
internal fun requireCredential(value: Boolean, code: String = "CREDENTIAL_INVALID_MESSAGE") {
  if (!value) throw CredentialFailure(code)
}
internal fun uuid(): String = UUID.randomUUID().toString()
internal fun validId(value: String): Boolean =
  Regex("[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}").matches(value)
internal fun b64(bytes: ByteArray): String = Base64.encode(bytes).toString()
internal fun url64(bytes: ByteArray): String = Base64URL.encode(bytes).toString()
internal fun decode64(value: String): ByteArray = try {
  Base64URL(value).decode().also { requireCredential(url64(it) == value) }
} catch (_: IllegalArgumentException) { throw CredentialFailure("CREDENTIAL_INVALID_MESSAGE") }
internal fun digest(bytes: ByteArray): String = url64(MessageDigest.getInstance("SHA-256").digest(bytes))
internal fun canonical(value: Any?): String = when (value) {
  null, JSONObject.NULL -> "null"
  is JSONObject -> value.keys().asSequence().toList().sorted().joinToString(",", "{", "}") {
    "${JSONObject.quote(it)}:${canonical(value.get(it))}"
  }
  is JSONArray -> (0 until value.length()).joinToString(",", "[", "]") { canonical(value.get(it)) }
  is String -> JSONObject.quote(value).replace("\\/", "/")
  is Number, is Boolean -> value.toString()
  else -> throw CredentialFailure("CREDENTIAL_INVALID_MESSAGE")
}
internal fun json(vararg values: Pair<String, Any?>): JSONObject = JSONObject().apply {
  values.forEach { (key, value) -> put(key, value ?: JSONObject.NULL) }
}
internal fun publicJwk(key: ECPublicKey): JSONObject = JSONObject(ECKey.Builder(Curve.P_256, key).build().toPublicJWK().toJSONString())
internal fun validatedJwk(value: JSONObject): ECKey {
  requireCredential(value.keys().asSequence().toSet() == setOf("kty", "crv", "x", "y"), "CREDENTIAL_INVALID_IDENTITY")
  requireCredential(value.optString("kty") == "EC" && value.optString("crv") == "P-256", "CREDENTIAL_INVALID_IDENTITY")
  requireCredential(decode64(value.getString("x")).size == 32 && decode64(value.getString("y")).size == 32)
  return ECKey.parse(value.toString()).also { it.toECPublicKey() }
}
internal data class VerifiedIdentity(val id: String, val membership: String, val realm: String,
  val publicKey: JSONObject, val checkedAt: Long = System.currentTimeMillis()) {
  val thumbprint: String get() = validatedJwk(publicKey).computeThumbprint().toString()
}

/** All keys, password buffers and decrypted credential packets stay native. */
internal class CredentialChannel(private val local: VerifiedIdentity, private val remote: VerifiedIdentity,
  private val signingKey: KeyPair, private val monotonic: () -> Long) {
  private var ephemeral: KeyPair? = KeyPairGenerator.getInstance("EC").run {
    initialize(ECGenParameterSpec("secp256r1")); generateKeyPair()
  }
  private val wallDeadline = System.currentTimeMillis() + 1_800_000
  private val deadline = monotonic() + 1_800_000
  private val localOffer: JSONObject
  private var peerOffer: JSONObject? = null
  private var session: String? = null
  private var outgoing = 0L
  private var incoming = 0L
  private val received = mutableSetOf<Long>()
  var confirmed = false; private set
  init {
    val now = System.currentTimeMillis()
    requireCredential(local.id != remote.id && local.membership == remote.membership && local.realm == remote.realm &&
      canonical(local.publicKey) == canonical(publicJwk(signingKey.public as ECPublicKey)) &&
      now - local.checkedAt in 0..30_000 && now - remote.checkedAt in 0..30_000, "CREDENTIAL_INVALID_IDENTITY")
    localOffer = json("domain" to "cindy.remote-desktop.offer.v1", "realm" to local.realm,
      "membership" to local.membership, "from" to local.id, "to" to remote.id, "nonce" to uuid(),
      "ephemeral" to publicJwk(ephemeral!!.public as ECPublicKey), "expiresAt" to now + 60_000)
  }
  fun active() {
    requireCredential(ephemeral != null && monotonic() < deadline && System.currentTimeMillis() < wallDeadline,
      "CREDENTIAL_EXPIRED")
  }
  fun requireConfirmed() { active(); requireCredential(confirmed, "CREDENTIAL_INVALID_IDENTITY") }
  private fun sign(body: String, type: String, contentType: String? = null): String {
    val header = JWSHeader.Builder(JWSAlgorithm.ES256).type(JOSEObjectType(type)).apply {
      if (contentType != null) contentType(contentType)
    }.build()
    return JWSObject(header, Payload(body)).apply { sign(ECDSASigner(signingKey.private, Curve.P_256)) }.serialize()
  }
  fun offer(): String { active(); return sign(canonical(localOffer), "cindy-remote-desktop-offer-v1") }
  fun accept(offer: String) {
    active(); requireCredential(peerOffer == null && offer.toByteArray().size <= 4096)
    val signed = JWSObject.parse(offer)
    requireCredential(signed.header.toJSONObject().keys == setOf("alg", "typ") &&
      signed.header.algorithm == JWSAlgorithm.ES256 && signed.header.type.toString() == "cindy-remote-desktop-offer-v1" &&
      signed.verify(ECDSAVerifier(validatedJwk(remote.publicKey))), "CREDENTIAL_INVALID_IDENTITY")
    val value = JSONObject(signed.payload.toString()); val now = System.currentTimeMillis()
    requireCredential(value.getString("domain") == localOffer.getString("domain") &&
      value.getString("realm") == local.realm && value.getString("membership") == local.membership &&
      value.getString("from") == remote.id && value.getString("to") == local.id && validId(value.getString("nonce")) &&
      value.getLong("expiresAt") - now in 1..120_000 && localOffer.getLong("expiresAt") > now, "CREDENTIAL_INVALID_IDENTITY")
    validatedJwk(value.getJSONObject("ephemeral"))
    // Discard unrecognized fields exactly as Swift's Codable offer does.
    val normalized = json(*listOf("domain", "realm", "membership", "from", "to", "nonce", "ephemeral", "expiresAt")
      .map { it to value.get(it) }.toTypedArray())
    session = digest(canonical(JSONArray(listOf(localOffer, normalized).sortedBy { it.getString("from") })).toByteArray())
    peerOffer = normalized
  }
  fun seal(body: ByteArray, purpose: String): String {
    active(); requireCredential(session != null && peerOffer != null && outgoing < Long.MAX_VALUE &&
      purpose in purposes && (purpose == "ready" || confirmed))
    val packet = json("domain" to "cindy.remote-desktop.packet.v1", "session" to session, "from" to local.id,
      "to" to remote.id, "sequence" to ++outgoing, "purpose" to purpose, "body" to b64(body))
    val jwe = JWEObject(JWEHeader.Builder(JWEAlgorithm.ECDH_ES, EncryptionMethod.A256GCM)
      .type(JOSEObjectType(type)).build(), Payload(canonical(packet)))
    jwe.encrypt(ECDHEncrypter(validatedJwk(peerOffer!!.getJSONObject("ephemeral"))))
    return sign(jwe.serialize(), type, "JWE")
  }
  fun open(ciphertext: String): Pair<String, ByteArray> {
    active(); requireCredential(session != null && ciphertext.toByteArray().size <= 40 * 1024 * 1024)
    val signed = JWSObject.parse(ciphertext)
    requireCredential(signed.header.toJSONObject().keys == setOf("alg", "typ", "cty") &&
      signed.header.algorithm == JWSAlgorithm.ES256 && signed.header.type.toString() == type &&
      signed.header.contentType == "JWE" && signed.verify(ECDSAVerifier(validatedJwk(remote.publicKey))))
    val encrypted = JWEObject.parse(signed.payload.toString())
    requireCredential(encrypted.header.toJSONObject().keys == setOf("alg", "enc", "typ", "epk") &&
      encrypted.header.algorithm == JWEAlgorithm.ECDH_ES && encrypted.header.encryptionMethod == EncryptionMethod.A256GCM &&
      encrypted.header.type.toString() == type)
    val epk = JSONObject(encrypted.header.ephemeralPublicKey.toJSONString())
    if (epk.has("kid")) { requireCredential(runCatching { UUID.fromString(epk.getString("kid")) }.isSuccess); epk.remove("kid") }
    validatedJwk(epk)
    encrypted.decrypt(ECDHDecrypter(ephemeral!!.private as ECPrivateKey))
    val bytes = encrypted.payload.toBytes(); requireCredential(bytes.size <= 20 * 1024 * 1024)
    val packet = JSONObject(String(bytes, Charsets.UTF_8)); bytes.fill(0)
    val sequence = packet.getLong("sequence"); val purpose = packet.getString("purpose")
    requireCredential(packet.getString("domain") == "cindy.remote-desktop.packet.v1" && packet.getString("session") == session &&
      packet.getString("from") == remote.id && packet.getString("to") == local.id && purpose in purposes &&
      (purpose == "ready" || confirmed) && sequence > 0 && sequence !in received &&
      (sequence > incoming || incoming - sequence < 256))
    incoming = maxOf(incoming, sequence); received.removeAll { incoming - it >= 256 }; received.add(sequence)
    if (purpose == "ready") confirmed = true
    return purpose to Base64(packet.getString("body")).decode()
  }
  fun close() { ephemeral = null; peerOffer = null; session = null; confirmed = false; received.clear() }
  companion object {
    private const val type = "cindy-remote-desktop-v1"
    private val purposes = setOf("ready", "authenticate", "authentication-result", "authentication-status", "request", "response", "revoke")
  }
}
