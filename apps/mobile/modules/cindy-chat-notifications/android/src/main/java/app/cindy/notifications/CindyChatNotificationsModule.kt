package app.cindy.notifications

import android.content.Intent
import androidx.core.content.ContextCompat
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.functions.Queues
import java.net.URI
import org.json.JSONArray
import org.json.JSONObject

class CindyChatNotificationsModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("CindyChatNotifications")
    Events("refreshRequested")
    AsyncFunction("getDiagnostics") {
      appContext.reactContext?.let { ChatDiagnostics.snapshot(it) } ?: emptyMap<String, Any>()
    }
    AsyncFunction("isPaused") {
      appContext.reactContext?.getSharedPreferences("cindy-chat-background", android.content.Context.MODE_PRIVATE)?.getBoolean("paused", false) ?: false
    }
    AsyncFunction("resume") {
      appContext.reactContext?.getSharedPreferences("cindy-chat-background", android.content.Context.MODE_PRIVATE)?.edit()?.putBoolean("paused", false)?.apply()
    }
    OnCreate { ChatConnectionService.refreshRequested = { sendEvent("refreshRequested") } }
    OnDestroy { ChatConnectionService.refreshRequested = null }
    OnActivityEntersForeground {
      ChatConnectionService.appForeground = true
      ChatConnectionService.setRelayBackground(false)
    }
    OnActivityEntersBackground { ChatConnectionService.appForeground = false }
    AsyncFunction("configureSessionRelay") { owner: String, user: String, device: String, url: String, token: String, targets: String ->
      val endpoint = URI(url)
      require(endpoint.scheme == "wss" && endpoint.host != null && endpoint.userInfo == null && endpoint.fragment == null)
      require(owner.length in 1..512 && user.length in 1..256 && device.length in 1..256 && token.length in 1..16000)
      val list = JSONArray(targets)
      require(list.length() <= 100)
      val ids = (0 until list.length()).map { list.getString(it).also { id -> require(id.length in 1..256) } }
      ChatConnectionService.configureRelay(SessionRelayConfiguration(owner, user, device, url, token, ids))
    }.runOnQueue(Queues.MAIN)
    AsyncFunction("clearSessionRelay") {
      ChatConnectionService.configureRelay(null)
      appContext.reactContext?.let { SessionDelivery.identity(it, "") }
    }.runOnQueue(Queues.MAIN)
    AsyncFunction("setSessionRelayBackground") { enabled: Boolean ->
      ChatConnectionService.setRelayBackground(enabled)
    }.runOnQueue(Queues.MAIN)
    AsyncFunction("receiveSessionNotification") { owner: String, device: String, payload: String ->
      require(payload.length <= 8192)
      appContext.reactContext?.let { ChatConnectionService.receiveSession(it, owner, device, JSONObject(payload)) }
    }.runOnQueue(Queues.MAIN)
    AsyncFunction("setIdentity") { actor: String ->
      val context = appContext.reactContext ?: return@AsyncFunction
      ChatDelivery.identity(context, actor)
      if (actor.isEmpty()) { ChatConnectionService.configureRelay(null); SessionDelivery.identity(context, "") }
    }.runOnQueue(Queues.MAIN)
    AsyncFunction("setPreview") { enabled: Boolean ->
      appContext.reactContext?.getSharedPreferences("cindy-chat-background", android.content.Context.MODE_PRIVATE)
        ?.edit()?.putBoolean("preview", enabled)?.apply()
    }
    AsyncFunction("configure") { owner: String, actor: String, baseUrl: String, token: String, title: String, stop: String, preview: Boolean, language: String? ->
      val context = appContext.reactContext ?: throw Exception("CHAT_CONTEXT_UNAVAILABLE")
      val endpoint = URI(baseUrl)
      require(endpoint.scheme == "https" && endpoint.host != null && endpoint.userInfo == null && endpoint.query == null && endpoint.fragment == null) { "CHAT_ENDPOINT_INVALID" }
      require(token.isNotBlank() && token.length <= 16000 && actor.length <= 128 && owner.length <= 512)
      ChatDelivery.identity(context, actor)
      ChatConnectionService.configure(ChatConnection(owner, actor, baseUrl.trimEnd('/'), token, title, stop, preview, language ?: "en"))
      // Only a visible activity can initiate the foreground service. Token updates
      // from an already-running service never start/restart an application.
      if (!ChatConnectionService.running) {
        check(appContext.currentActivity?.hasWindowFocus() == true) { "CHAT_OPEN_APP_REQUIRED" }
        ContextCompat.startForegroundService(context, Intent(context, ChatConnectionService::class.java))
      }
    }.runOnQueue(Queues.MAIN)
    AsyncFunction("stop") {
      appContext.reactContext?.let { ChatConnectionService.clear(); it.stopService(Intent(it, ChatConnectionService::class.java)) }
    }.runOnQueue(Queues.MAIN)
  }
}
