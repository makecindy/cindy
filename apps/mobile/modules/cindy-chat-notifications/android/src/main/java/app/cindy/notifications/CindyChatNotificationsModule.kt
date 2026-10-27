package app.cindy.notifications

import android.content.Intent
import androidx.core.content.ContextCompat
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.functions.Queues
import java.net.URI

class CindyChatNotificationsModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("CindyChatNotifications")
    Events("refreshRequested")
    AsyncFunction("isPaused") {
      appContext.reactContext?.getSharedPreferences("cindy-chat-background", android.content.Context.MODE_PRIVATE)?.getBoolean("paused", false) ?: false
    }
    AsyncFunction("resume") {
      appContext.reactContext?.getSharedPreferences("cindy-chat-background", android.content.Context.MODE_PRIVATE)?.edit()?.putBoolean("paused", false)?.apply()
    }
    OnCreate { ChatConnectionService.refreshRequested = { sendEvent("refreshRequested") } }
    OnDestroy { ChatConnectionService.refreshRequested = null }
    AsyncFunction("setIdentity") { actor: String ->
      val context = appContext.reactContext ?: return@AsyncFunction
      ChatDelivery.identity(context, actor)
    }
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
    }
  }
}
