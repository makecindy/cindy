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
    AsyncFunction("setTaskBadgeIdentity") { scope: String, account: String ->
      appContext.reactContext?.let { TaskBadgeDelivery.identity(it, scope, account) }
    }
    AsyncFunction("applyTaskBadge") { summary: String ->
      val context = appContext.reactContext ?: return@AsyncFunction false
      TaskBadgeDelivery.apply(context, org.json.JSONObject(summary))
    }
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
    }.runOnQueue(Queues.MAIN)
    AsyncFunction("setOwner") { owner: String ->
      appContext.reactContext?.let { ChatDelivery.owner(it, owner) }
    }.runOnQueue(Queues.MAIN)
    AsyncFunction("setPreview") { enabled: Boolean ->
      appContext.reactContext?.getSharedPreferences("cindy-chat-background", android.content.Context.MODE_PRIVATE)
        ?.edit()?.putBoolean("preview", enabled)?.apply()
    }
    AsyncFunction("setTaskIdentity") { user: String ->
      appContext.reactContext?.let { ChatDelivery.taskIdentity(it, user) }
    }.runOnQueue(Queues.MAIN)
    AsyncFunction("configureNotifications") { value: Map<String, Any> ->
      val owner = value["owner"] as String; val actor = value["actor"] as String
      val chatBase = value["chatBase"] as String; val user = value["user"] as String
      val taskBase = value["taskBase"] as String; val token = value["token"] as String
      val title = value["title"] as String; val stop = value["stopLabel"] as String
      val preview = value["preview"] as Boolean; val language = value["language"] as String
      val context = appContext.reactContext ?: throw Exception("CHAT_CONTEXT_UNAVAILABLE")
      for (base in listOf(chatBase, taskBase).filter { it.isNotEmpty() }) {
        val endpoint = URI(base)
        require(endpoint.scheme == "https" && endpoint.host != null && endpoint.userInfo == null && endpoint.query == null && endpoint.fragment == null) { "CHAT_ENDPOINT_INVALID" }
      }
      require(token.isNotBlank() && token.length <= 16000 && actor.length <= 128 && user.length <= 128 && owner.length <= 512)
      if (actor.isNotEmpty()) ChatDelivery.identity(context, actor)
      ChatDelivery.taskIdentity(context, user)
      ChatConnectionService.configure(ChatConnection(owner, actor, chatBase.trimEnd('/'), token, title, stop, preview, language, taskBase.trimEnd('/'), user))
      if (!ChatConnectionService.running) {
        check(appContext.currentActivity?.hasWindowFocus() == true) { "CHAT_OPEN_APP_REQUIRED" }
        ContextCompat.startForegroundService(context, Intent(context, ChatConnectionService::class.java))
      }
    }.runOnQueue(Queues.MAIN)
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
