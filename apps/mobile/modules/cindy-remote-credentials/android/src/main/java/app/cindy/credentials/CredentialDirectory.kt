package app.cindy.credentials

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import com.nimbusds.jose.JWSAlgorithm
import com.nimbusds.jose.JWSHeader
import com.nimbusds.jose.crypto.ECDSASigner
import com.nimbusds.jose.jwk.Curve
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import android.system.Os
import android.system.OsConstants
import android.system.ErrnoException
import java.net.URL
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import javax.net.ssl.HttpsURLConnection

internal class CredentialInstallation(context: Context) {
  val id: String
  val root = File(context.noBackupFilesDir, "remote-credentials")
  init {
    requireCredential(root.isDirectory || root.mkdirs(), "CREDENTIAL_UNAVAILABLE")
    val marker = File(root, "installation")
    if (!marker.exists()) {
      val temporary = File.createTempFile("installation-", ".tmp", root)
      try {
        FileOutputStream(temporary).use { it.write(uuid().toByteArray()); it.fd.sync() }
        try { Os.link(temporary.path, marker.path) }
        catch (error: ErrnoException) { if (error.errno != OsConstants.EEXIST) throw error }
      } finally { temporary.delete() }
    }
    val attributes = Os.lstat(marker.path)
    requireCredential(OsConstants.S_ISREG(attributes.st_mode) && attributes.st_uid == android.os.Process.myUid() &&
      attributes.st_size == 36L, "CREDENTIAL_INVALID_IDENTITY")
    id = marker.readText(); requireCredential(validId(id), "CREDENTIAL_INVALID_IDENTITY")
  }
  fun key(realm: String): KeyPair {
    val alias = "cindy.remote.identity.$id.$realm"
    val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    if (!store.containsAlias(alias)) {
      KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore").apply {
        initialize(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN or KeyProperties.PURPOSE_VERIFY)
          .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
          .setDigests(KeyProperties.DIGEST_SHA256).build())
      }.generateKeyPair()
    }
    return KeyPair(store.getCertificate(alias).publicKey, store.getKey(alias, null) as PrivateKey)
  }
}

internal class CredentialDirectory(private val realm: String, private val member: String) {
  private val origin = when (realm) {
    "global" -> "https://device-link.cindy.app"
    "cn" -> "https://device-link.cindy.com.cn"
    else -> throw CredentialFailure("CREDENTIAL_INVALID_IDENTITY")
  }
  private suspend fun request(path: String, method: String, token: String, body: JSONObject? = null): JSONObject = withContext(Dispatchers.IO) {
    requireCredential(token.isNotEmpty() && token.length <= 16_384 && '\r' !in token && '\n' !in token, "CREDENTIAL_INVALID_IDENTITY")
    val connection = URL("$origin/api/device-link/identities$path").openConnection() as HttpsURLConnection
    try {
      connection.instanceFollowRedirects = false; connection.useCaches = false
      connection.connectTimeout = 10_000; connection.readTimeout = 15_000; connection.requestMethod = method
      connection.setRequestProperty("Authorization", "Bearer $token")
      connection.setRequestProperty("Content-Type", "application/json")
      if (body != null) { connection.doOutput = true; connection.outputStream.use { it.write(canonical(body).toByteArray()) } }
      val status = connection.responseCode
      requireCredential(status !in setOf(403, 404, 410), "CREDENTIAL_INVALID_IDENTITY")
      requireCredential(status == 200, "CREDENTIAL_UNAVAILABLE")
      val bytes = connection.inputStream.use { input ->
        val output = java.io.ByteArrayOutputStream(); val buffer = ByteArray(4096)
        while (true) {
          val count = input.read(buffer); if (count < 0) break
          requireCredential(output.size() + count <= 65_536); output.write(buffer, 0, count)
        }; output.toByteArray()
      }
      JSONObject(String(bytes, Charsets.UTF_8))
    } catch (error: CredentialFailure) { throw error }
      catch (_: Exception) { throw CredentialFailure("CREDENTIAL_UNAVAILABLE") }
    finally { connection.disconnect() }
  }
  private fun validate(response: JSONObject, expected: String?): VerifiedIdentity {
    val row = response.getJSONObject("identity"); val id = row.getString("id")
    val key = row.getJSONObject("publicKey"); val jwk = validatedJwk(key)
    requireCredential(validId(id) && (expected == null || expected == id) && row.getString("userId") == member &&
      row.isNull("revokedAt") && row.getString("thumbprint") == jwk.computeThumbprint().toString(), "CREDENTIAL_INVALID_IDENTITY")
    return VerifiedIdentity(id, member, realm, key)
  }
  suspend fun lookup(id: String, token: String): VerifiedIdentity {
    requireCredential(validId(id), "CREDENTIAL_INVALID_IDENTITY")
    return validate(request("/$id", "GET", token), id)
  }
  suspend fun enroll(key: KeyPair, token: String): VerifiedIdentity {
    val challenge = request("/challenges", "POST", token, json("publicKey" to publicJwk(key.public as ECPublicKey)))
    val proof = proof(challenge, key, token, null, null)
    return validate(request("", "POST", token, proof), null).also {
      requireCredential(canonical(it.publicKey) == canonical(publicJwk(key.public as ECPublicKey)), "CREDENTIAL_INVALID_IDENTITY")
    }
  }
  suspend fun headers(key: KeyPair, id: String, authDevice: String, token: String,
    method: String? = null, body: JSONObject? = null): Map<String, String> {
    if (method != null) {
      requireCredential(method in setOf("PUT", "DELETE") && body != null &&
        body.keys().asSequence().all { it in setOf("token", "platform", "provider", "appVariant", "apnsEnv") &&
          body.get(it) is String && body.getString(it).toByteArray().size <= 512 })
    }
    val input = json("identityId" to id)
    if (method != null) { input.put("method", method); input.put("body", body) }
    val challenge = request(if (method == null) "/relay-challenges" else "/push-challenges", "POST", token, input)
    val proof = proof(challenge, key, token, id, authDevice, method, body)
    return mapOf("x-cindy-identity-id" to id, "x-cindy-identity-challenge" to proof.getString("challengeId"),
      "x-cindy-identity-signature" to proof.getString("signature"))
  }
  private fun proof(challenge: JSONObject, key: KeyPair, token: String, identity: String?, authDevice: String?,
    method: String? = null, body: JSONObject? = null): JSONObject {
    val thumb = validatedJwk(publicJwk(key.public as ECPublicKey)).computeThumbprint().toString()
    val id = challenge.getString("challengeId"); val expires = challenge.getLong("expiresAt")
    requireCredential(challenge.getInt("version") == 1 && validId(id) && challenge.getString("membershipId") == member &&
      challenge.optString("identityId", "") == (identity ?: "") && challenge.getString("thumbprint") == thumb &&
      expires - System.currentTimeMillis() in 1..120_000 && challenge.getString("message").length <= 4096, "CREDENTIAL_INVALID_IDENTITY")
    val bytes = decode64(challenge.getString("message")); val value = JSONObject(String(bytes, Charsets.UTF_8))
    val domain = if (identity == null) "enroll" else if (method == null) "relay" else "push"
    requireCredential(value.getString("domain") == "cindy.device-identity.$domain.v1" && value.getString("membershipId") == member &&
      value.getString("challengeId") == id && value.getString("thumbprint") == thumb && value.getLong("expiresAt") == expires &&
      decode64(value.getString("nonce")).size == 32, "CREDENTIAL_INVALID_IDENTITY")
    if (identity != null) requireCredential(value.getString("identityId") == identity && value.getString("authDeviceId") == authDevice &&
      value.getString("path") == (if (method == null) "/api/device-link/ws" else "/api/device-link/push-token") &&
      value.getString("tokenHash") == digest(token.toByteArray()) && (method == null ||
      (value.getString("method") == method && value.getString("bodyHash") == digest(canonical(body).toByteArray()))), "CREDENTIAL_INVALID_IDENTITY")
    val signature = ECDSASigner(key.private, Curve.P_256).sign(JWSHeader(JWSAlgorithm.ES256), bytes)
    return json("challengeId" to id, "signature" to signature.toString())
  }
}
