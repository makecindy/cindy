package app.cindy.credentials

import androidx.fragment.app.FragmentActivity
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.exception.CodedException
import kotlinx.coroutines.*

class CindyRemoteCredentialsModule : Module() {
  private var clientValue: MobileCredentialClient? = null
  private val client: MobileCredentialClient get() = clientValue ?: MobileCredentialClient(requireNotNull(appContext.reactContext), { appContext.currentActivity as? FragmentActivity }) {
      sendEvent("invalidated", mapOf("handle" to it))
    }.also { clientValue = it }
  private suspend fun <T> guarded(block: suspend () -> T): T = withContext(Dispatchers.Main.immediate) {
    try { block() }
    catch (error: Exception) {
      val code = (error as? CredentialFailure)?.fixedCode ?: if (error is CancellationException) "CREDENTIAL_CANCELLED" else "CREDENTIAL_UNAVAILABLE"
      throw CodedException(code, code, null)
    }
  }
  override fun definition() = ModuleDefinition {
    Name("CindyRemoteCredentials")
    Events("invalidated")
    AsyncFunction("configure") Coroutine { realm: String, member: String, authDevice: String, token: String ->
      guarded { client.configure(realm, member, authDevice, token) }
    }
    AsyncFunction("updateToken") Coroutine { realm: String, member: String, token: String -> guarded { client.updateToken(realm, member, token) } }
    AsyncFunction("relayHeaders") Coroutine { -> guarded { client.headers() } }
    AsyncFunction("pushHeaders") Coroutine { method: String, body: Map<String, String> -> guarded { client.headers(method, body) } }
    AsyncFunction("begin") Coroutine { target: String -> guarded { client.begin(target) } }
    AsyncFunction("accept") Coroutine { handle: String, offer: String -> guarded { client.accept(handle, offer) } }
    AsyncFunction("receive") Coroutine { handle: String, ciphertext: String -> guarded { client.receive(handle, ciphertext) } }
    AsyncFunction("password") Coroutine { handle: String, saved: Boolean, locale: String, theme: String -> guarded { client.password(handle, saved, locale, theme) } }
    AsyncFunction("authenticationStatus") Coroutine { handle: String -> guarded { client.authenticationStatus(handle) } }
    AsyncFunction("request") Coroutine { handle: String, body: String -> guarded { client.request(handle, body) } }
    AsyncFunction("abandonRequest") Coroutine { handle: String, id: String -> guarded { client.abandon(handle, id) } }
    AsyncFunction("forget") Coroutine { handle: String -> guarded { client.forget(handle) } }
    AsyncFunction("end") Coroutine { handle: String -> guarded { client.end(handle) } }
    AsyncFunction("close") Coroutine { handle: String -> guarded { client.close(handle) } }
    AsyncFunction("reset") Coroutine { -> guarded { client.reset() } }
    OnActivityEntersForeground { clientValue?.foreground = true }
    OnActivityEntersBackground { clientValue?.foreground = false; clientValue?.close() }
    OnDestroy { android.os.Handler(android.os.Looper.getMainLooper()).post { clientValue?.destroy(); clientValue = null } }
  }
}
