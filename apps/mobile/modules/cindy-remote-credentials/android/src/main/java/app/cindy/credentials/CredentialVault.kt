package app.cindy.credentials

import android.app.AlertDialog
import android.content.Context
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.text.InputType
import android.util.AtomicFile
import android.view.ContextThemeWrapper
import android.view.WindowManager
import android.view.inputmethod.EditorInfo
import android.widget.CheckBox
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import kotlinx.coroutines.suspendCancellableCoroutine
import org.json.JSONObject
import java.io.File
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

internal data class PreparedCredential(val binding: String, val iv: ByteArray, val ciphertext: ByteArray)

internal class CredentialVault(private val context: Context, private val installation: CredentialInstallation,
  private val activity: () -> FragmentActivity?) {
  private var dialog: AlertDialog? = null
  private var prompt: BiometricPrompt? = null
  private val store get() = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
  private fun alias(binding: String) = "cindy.remote.vault.${installation.id}.${digest(binding.toByteArray())}"
  private fun file(binding: String) = AtomicFile(File(installation.root, "secret-${digest(binding.toByteArray())}"))
  fun contains(binding: String) = file(binding).baseFile.isFile
  fun forget(binding: String) { file(binding).delete(); store.deleteEntry(alias(binding)) }
  fun cancel() {
    val oldDialog = dialog; dialog = null; oldDialog?.cancel()
    val oldPrompt = prompt; prompt = null; oldPrompt?.cancelAuthentication()
  }
  private fun labels(locale: String): JSONObject {
    val catalog = context.assets.open("credentials.json").bufferedReader().use { JSONObject(it.readText()) }
    val language = when {
      locale.startsWith("zh-TW", true) || locale.startsWith("zh-HK", true) || locale.contains("Hant", true) -> "zh-TW"
      locale.startsWith("zh", true) -> "zh-CN"
      locale.startsWith("ja", true) -> "ja"
      locale.startsWith("ko", true) -> "ko"
      else -> "en"
    }
    return catalog.getJSONObject(language)
  }
  private val authenticators: Int get() = if (Build.VERSION.SDK_INT >= 30)
    BiometricManager.Authenticators.BIOMETRIC_STRONG or BiometricManager.Authenticators.DEVICE_CREDENTIAL
    else BiometricManager.Authenticators.BIOMETRIC_STRONG
  private suspend fun authenticate(cipher: Cipher, locale: String): Cipher {
    val current = activity() ?: throw CredentialFailure("CREDENTIAL_UNAVAILABLE")
    requireCredential(prompt == null && dialog == null, "CREDENTIAL_UNAVAILABLE")
    requireCredential(BiometricManager.from(current).canAuthenticate(authenticators) == BiometricManager.BIOMETRIC_SUCCESS,
      "CREDENTIAL_UNAVAILABLE")
    val labels = labels(locale)
    return suspendCancellableCoroutine { continuation ->
      lateinit var value: BiometricPrompt
      value = BiometricPrompt(current, ContextCompat.getMainExecutor(current), object : BiometricPrompt.AuthenticationCallback() {
        override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
          if (prompt === value) prompt = null
          if (!continuation.isActive) return
          val unlocked = result.cryptoObject?.cipher
          if (unlocked === cipher) continuation.resume(unlocked)
          else continuation.resumeWithException(CredentialFailure("CREDENTIAL_UNAVAILABLE"))
        }
        override fun onAuthenticationError(code: Int, message: CharSequence) {
          if (prompt === value) prompt = null
          if (continuation.isActive) continuation.resumeWithException(CredentialFailure(
            if (code in setOf(BiometricPrompt.ERROR_CANCELED, BiometricPrompt.ERROR_USER_CANCELED,
              BiometricPrompt.ERROR_NEGATIVE_BUTTON)) "CREDENTIAL_CANCELLED" else "CREDENTIAL_UNAVAILABLE"))
        }
      })
      prompt = value
      val info = BiometricPrompt.PromptInfo.Builder().setTitle(labels.getString("biometric"))
        .setAllowedAuthenticators(authenticators).apply {
          if (Build.VERSION.SDK_INT < 30) setNegativeButtonText(labels.getString("cancel"))
        }.build()
      continuation.invokeOnCancellation { current.runOnUiThread { value.cancelAuthentication() } }
      value.authenticate(info, BiometricPrompt.CryptoObject(cipher))
    }
  }
  suspend fun read(binding: String, locale: String): ByteArray {
    try {
      val raw = file(binding).openRead().use { input ->
        val bytes = ByteArray(8193)
        var count = 0
        while (count < bytes.size) {
          val read = input.read(bytes, count, bytes.size - count)
          if (read < 0) break
          if (read == 0) continue
          count += read
        }
        requireCredential(count in 1..8192); bytes.copyOf(count)
      }
      val value = JSONObject(String(raw, Charsets.UTF_8))
      val key = store.getKey(alias(binding), null) as? SecretKey ?: throw CredentialFailure("CREDENTIAL_UNAVAILABLE")
      val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply {
        init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, decode64(value.getString("iv"))))
        updateAAD(binding.toByteArray())
      }
      // The successful CryptoObject operates on the real secret, not a boolean gate.
      return authenticate(cipher, locale).doFinal(decode64(value.getString("ciphertext"))).also {
        requireCredential(it.isNotEmpty() && it.size <= 4096)
      }
    } catch (error: CredentialFailure) {
      throw if (error.fixedCode == "CREDENTIAL_INVALID_MESSAGE") CredentialFailure("CREDENTIAL_UNAVAILABLE") else error
    }
      catch (_: android.security.keystore.KeyPermanentlyInvalidatedException) {
        forget(binding); throw CredentialFailure("CREDENTIAL_UNAVAILABLE")
      }
      catch (_: Exception) { throw CredentialFailure("CREDENTIAL_UNAVAILABLE") }
  }
  suspend fun prepare(secret: ByteArray, binding: String, locale: String, current: () -> Boolean): PreparedCredential {
    requireCredential(secret.isNotEmpty() && secret.size <= 4096)
    val keyStore = store; val alias = alias(binding)
    if (!keyStore.containsAlias(alias)) {
      val builder = KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        .setKeySize(256).setUserAuthenticationRequired(true)
      if (Build.VERSION.SDK_INT >= 30) builder.setUserAuthenticationParameters(0,
        KeyProperties.AUTH_BIOMETRIC_STRONG or KeyProperties.AUTH_DEVICE_CREDENTIAL)
      else builder.setUserAuthenticationValidityDurationSeconds(-1)
      KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply { init(builder.build()) }.generateKey()
    }
    val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply {
      init(Cipher.ENCRYPT_MODE, keyStore.getKey(alias, null) as SecretKey); updateAAD(binding.toByteArray())
    }
    val encrypted = authenticate(cipher, locale).doFinal(secret)
    requireCredential(current(), "CREDENTIAL_CANCELLED")
    return PreparedCredential(binding, cipher.iv, encrypted)
  }
  fun commit(prepared: PreparedCredential, current: () -> Boolean) {
    requireCredential(current(), "CREDENTIAL_CANCELLED")
    val target = file(prepared.binding); val stream = target.startWrite()
    try {
      stream.write(canonical(json("iv" to url64(prepared.iv), "ciphertext" to url64(prepared.ciphertext))).toByteArray())
      target.finishWrite(stream)
    } catch (error: Exception) { target.failWrite(stream); throw CredentialFailure("CREDENTIAL_UNAVAILABLE") }
  }
  suspend fun enter(account: String, target: String, locale: String, theme: String): Pair<ByteArray, Boolean> {
    val current = activity() ?: throw CredentialFailure("CREDENTIAL_UNAVAILABLE")
    requireCredential(dialog == null && prompt == null, "CREDENTIAL_UNAVAILABLE")
    val labels = labels(locale)
    val themed = ContextThemeWrapper(current, if (theme == "dark") android.R.style.Theme_Material_Dialog_Alert
      else android.R.style.Theme_Material_Light_Dialog_Alert)
    val field = EditText(themed).apply {
      inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
      imeOptions = EditorInfo.IME_FLAG_NO_EXTRACT_UI or EditorInfo.IME_FLAG_NO_PERSONALIZED_LEARNING
      hint = labels.getString("password"); setSingleLine(true)
      if (Build.VERSION.SDK_INT >= 26) importantForAutofill = android.view.View.IMPORTANT_FOR_AUTOFILL_NO
      filters = arrayOf(android.text.InputFilter.LengthFilter(4096))
    }
    val remember = CheckBox(themed).apply { text = labels.getString("remember"); minHeight = (48 * resources.displayMetrics.density).toInt() }
    val column = LinearLayout(themed).apply {
      orientation = LinearLayout.VERTICAL
      val spacing = (24 * resources.displayMetrics.density).toInt(); setPadding(spacing, 0, spacing, 0)
      addView(TextView(themed).apply { text = "$account\n$target" })
      addView(field); addView(remember); addView(TextView(themed).apply { text = labels.getString("explanation") })
    }
    return suspendCancellableCoroutine { continuation ->
      val value = AlertDialog.Builder(themed).setTitle(labels.getString("title")).setView(column)
        .setPositiveButton(labels.getString("verify"), null)
        .setNegativeButton(labels.getString("cancel")) { _, _ ->
          field.text.clear(); if (continuation.isActive) continuation.resumeWithException(CredentialFailure("CREDENTIAL_CANCELLED"))
        }.create()
      dialog = value
      value.setOnCancelListener { field.text.clear(); if (continuation.isActive) continuation.resumeWithException(CredentialFailure("CREDENTIAL_CANCELLED")) }
      value.setOnDismissListener { field.text.clear(); if (dialog === value) dialog = null }
      continuation.invokeOnCancellation { current.runOnUiThread { value.cancel() } }
      value.window?.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
      value.setOnShowListener {
        value.window?.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        value.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
          if (!continuation.isActive || field.text.isEmpty()) return@setOnClickListener
          val secret = field.text.toString().toByteArray(Charsets.UTF_8)
          if (secret.size > 4096 || secret.contains(0)) { secret.fill(0); return@setOnClickListener }
          field.text.clear(); continuation.resume(secret to remember.isChecked); value.dismiss()
        }
        field.requestFocus(); value.window?.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_VISIBLE)
      }
      value.show()
    }
  }
}
