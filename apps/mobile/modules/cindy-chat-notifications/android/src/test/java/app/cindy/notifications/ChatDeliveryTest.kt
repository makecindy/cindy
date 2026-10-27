package app.cindy.notifications

import android.app.NotificationManager
import android.app.NotificationChannel
import android.content.Context
import android.content.ContextWrapper
import android.content.Intent
import android.os.Bundle
import android.os.Parcel
import android.os.Handler
import android.os.Looper
import okhttp3.OkHttpClient
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.Request
import okhttp3.Response
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleRegistry
import androidx.lifecycle.ProcessLifecycleOwner
import expo.modules.kotlin.events.EventEmitter
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.ModuleRegistry
import expo.modules.kotlin.events.EventName
import expo.modules.notifications.notifications.handling.NotificationsHandler
import expo.modules.notifications.notifications.model.Notification
import io.mockk.every
import io.mockk.mockk
import io.mockk.spyk
import io.mockk.verify
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import java.lang.ref.WeakReference
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit
import androidx.core.app.NotificationCompat
import expo.modules.notifications.service.NotificationsService

/** Native integration: ChatDelivery -> real Expo receiver/handling -> actual SDK JS-handler event.
 * Field evidence: inbox dispatched=1 but neither foreground nor constructed appeared. A locally
 * built FCM data-only RemoteNotificationContent is intentionally ignored by Expo in foreground.
 * JS mocks cannot exercise that SDK guard. Minimal failure: one eligible chat-message while resumed.
 * Platform context/emitter are controlled; no Firebase account, test network requests, sleeps or user data.
 * Integration tier: Android resources/Parcel and Expo IO coroutine; warm suite 5.889s plus Gradle startup.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class ChatDeliveryTest {
  private val actor = "10000000-0000-4000-8000-000000000001"
  private val message = "20000000-0000-4000-8000-000000000002"
  private val room = "30000000-0000-4000-8000-000000000003"
  private val route get() = "/companions/groups/$room?messageId=$message"
  private val broadcasts = mutableListOf<Intent>()
  private val events = mutableListOf<Pair<String, Bundle>>()
  private lateinit var published: CompletableFuture<android.app.Notification>
  private lateinit var context: ContextWrapper
  private lateinit var registry: ModuleRegistry
  private lateinit var handler: NotificationsHandler
  private lateinit var appContext: AppContext

  @Before fun setup() {
    published = CompletableFuture()
    val application = RuntimeEnvironment.getApplication()
    val notifications = spyk(application.getSystemService(NotificationManager::class.java))
    notifications.createNotificationChannel(NotificationChannel("chat-messages", "Fixture chat", NotificationManager.IMPORTANCE_HIGH))
    every { notifications.notify(any<String>(), any<Int>(), any<android.app.Notification>()) } answers {
      callOriginal(); published.complete(thirdArg()); Unit
    }
    context = object : ContextWrapper(application) {
      override fun sendBroadcast(intent: Intent) { broadcasts.add(intent) }
      override fun getSystemService(name: String): Any? =
        if (name == Context.NOTIFICATION_SERVICE) notifications else super.getSystemService(name)
    }
    val emitter = mockk<EventEmitter>(relaxed = true)
    every { emitter.emit(any<String>(), any<Bundle>()) } answers { events.add(firstArg<String>() to secondArg<Bundle>()); Unit }
    appContext = mockk()
    every { appContext.reactContext } returns context
    every { appContext.eventEmitter(any()) } returns emitter
    registry = ModuleRegistry(WeakReference(appContext))
    handler = NotificationsHandler()
    registry.register(handler)
    registry.getModuleHolder(handler)!!.post(EventName.MODULE_CREATE)
    context.getSharedPreferences("cindy-chat-notification-ids", 0).edit().clear().commit()
    context.getSharedPreferences("cindy-chat-background", 0).edit().clear().commit()
    SessionDelivery.identity(context, "fixture-owner")
    context.getSharedPreferences("cindy-session-notification-ids", 0).edit().remove("ids").commit()
    ChatDelivery.identity(context, actor)
    lifecycle(Lifecycle.State.RESUMED)
  }
  @After fun cleanup() {
    registry.getModuleHolder(handler)!!.post(EventName.MODULE_DESTROY)
  }
  private fun lifecycle(state: Lifecycle.State) {
    (ProcessLifecycleOwner.get().lifecycle as LifecycleRegistry).currentState = state
  }
  private fun input(recipient: String = actor): Map<String, String> = mapOf(
    "tag" to message, "title" to "Fixture group", "message" to "Fixture bot: reply",
    "channelId" to "chat-messages", "body" to JSONObject().put("category", "chat-message")
      .put("recipientId", recipient).put("deepLink", route).put("body", "Fixture bot: reply")
      .put("senderName", "Fixture bot").put("sender", JSONObject().put("id", "40000000-0000-4000-8000-000000000004")).toString())

  private fun deliver(data: Map<String, String> = input()) {
    val before = broadcasts.size
    ChatDelivery.receive(context, data)
    // Dispatch the exact broadcast produced by the real Firebase delegate, without Android's
    // asynchronous broadcast scheduler; the production receiver and Expo delegates stay real.
    broadcasts.drop(before).toList().forEach { ChatNotificationsService().handleIntent(context, it) }
  }

  @Test fun foregroundChatReachesTheRealExpoHandlerWithItsClickData() {
    deliver()
    assertEquals(1, events.count { it.first == "onHandleNotification" })
    val event = events.single().second
    assertEquals(message, event.getString("id"))
    val content = event.getBundle("notification")!!.getBundle("request")!!.getBundle("content")!!
    assertEquals("Fixture group", content.getString("title"))
    assertEquals("Fixture bot: reply", content.getString("body"))
    assertEquals(route, JSONObject(content.getString("dataString")!!).getString("deepLink"))
  }

  @Test fun backgroundChatStillRequestsNativePresentationWithoutTheJsHandler() {
    lifecycle(Lifecycle.State.STARTED)
    deliver()
    assertTrue(events.isEmpty())
    val present = broadcasts.last()
    assertEquals(2, broadcasts.size)
    @Suppress("DEPRECATION")
    val notification = present.getParcelableExtra<Notification>("notification")!!
    assertEquals(message, notification.notificationRequest.identifier)
    assertEquals(route, notification.notificationRequest.content.body!!.getString("deepLink"))
  }

  @Test fun backgroundBuildsMessagingStyleAndItsRealClickResponseTargetsTheGroup() {
    lifecycle(Lifecycle.State.STARTED)
    deliver()
    ChatNotificationsService().handleIntent(context, broadcasts.last())
    // Native integration: Expo launches Dispatchers.IO. Await the real notify callback,
    // rather than sleeping or replacing its presentation delegate with a mock.
    val notification = published.get(5, TimeUnit.SECONDS)
    val style = requireNotNull(NotificationCompat.MessagingStyle.extractMessagingStyleFromNotification(notification))
    assertTrue(style.isGroupConversation)
    assertEquals("Fixture group", style.conversationTitle)
    assertEquals("reply", style.messages.single().text)
    val click = shadowOf(notification.contentIntent).savedIntent
    val response = NotificationsService.getNotificationResponseFromBroadcastIntent(click)
    assertEquals(message, response.notification.notificationRequest.identifier)
    assertEquals(route, response.notification.notificationRequest.content.body!!.getString("deepLink"))
  }

  // Expo marshals this request into the notification and click response. A wrapper
  // that only delegates writeToParcel would corrupt that response after reconstruction.
  @Test fun notificationParcelRoundTripPreservesTheVisibleContentAndClickTarget() {
    ChatDelivery.receive(context, input())
    @Suppress("DEPRECATION")
    val original = broadcasts.first().getParcelableExtra<Notification>("notification")!!
    val parcel = Parcel.obtain()
    val decoded = try {
      parcel.writeParcelable(original, 0)
      parcel.setDataPosition(0)
      @Suppress("DEPRECATION")
      requireNotNull(parcel.readParcelable<Notification>(Notification::class.java.classLoader))
    } finally { parcel.recycle() }
    val content = decoded.notificationRequest.content
    assertEquals(message, decoded.notificationRequest.identifier)
    assertEquals("Fixture group", content.title)
    assertEquals("Fixture bot: reply", content.text)
    assertEquals(route, content.body!!.getString("deepLink"))
    assertEquals(original.notificationRequest.trigger.getNotificationChannel(), decoded.notificationRequest.trigger.getNotificationChannel())
    events.clear()
    handler.onNotificationReceived(decoded)
    assertEquals(1, events.size)
  }

  @Test fun duplicateAndWrongRecipientNeverReachTheHandlerTwice() {
    deliver(input("other-actor"))
    assertTrue(events.isEmpty())
    deliver(); ChatDelivery.identity(context, actor); deliver()
    assertEquals(1, events.size)
  }

  @Test fun previewOptOutStripsSenderAndReplyBeforeTheForegroundHandler() {
    context.getSharedPreferences("cindy-chat-background", 0).edit().putBoolean("preview", false).commit()
    deliver()
    val content = events.single().second.getBundle("notification")!!.getBundle("request")!!.getBundle("content")!!
    val body = JSONObject(content.getString("dataString")!!)
    assertFalse(body.has("sender")); assertFalse(body.has("senderName")); assertFalse(body.has("body"))
    assertEquals(route, body.getString("deepLink"))
    assertEquals("", content.getString("body"))
  }

  private fun sessionInput(id: String = "a".repeat(64)) = JSONObject().put("eventId", id)
    .put("category", "session-done").put("collapseId", "b".repeat(32)).put("title", "Ztw")
    .put("body", "Final reply").put("deepLink", "/sessions/canonical?deviceId=desktop&resourceCollectionId=teammates&resourceId=ztw&resourceKind=bot")

  // Integration tier: new production native intake, actual Expo delegates and pending intent.
  // No existing chat-message case covers task category, owner fencing or task event-ID storage.
  @Test fun liveTaskAndCompanionReplyReachExpoWithPrivacyAndStableEventDeduplication() {
    context.getSharedPreferences("cindy-chat-background", 0).edit().putBoolean("preview", false).commit()
    SessionDelivery.receive(context, "fixture-owner", "wrong-desktop", sessionInput())
    SessionDelivery.receive(context, "old-owner", "desktop", sessionInput())
    assertTrue(broadcasts.isEmpty())
    SessionDelivery.receive(context, "fixture-owner", "desktop", sessionInput())
    val receive = broadcasts.single()
    ChatNotificationsService().handleIntent(context, receive)
    assertEquals(1, events.size)
    val content = events.single().second.getBundle("notification")!!.getBundle("request")!!.getBundle("content")!!
    assertEquals("", content.getString("body"))
    val data = JSONObject(content.getString("dataString")!!)
    assertFalse(data.has("body")); assertEquals(sessionInput().getString("deepLink"), data.getString("deepLink"))
    SessionDelivery.receive(context, "fixture-owner", "desktop", sessionInput())
    assertEquals(1, broadcasts.size)
    // The next final reply has a new identity even when title/body/collapse key are unchanged.
    SessionDelivery.receive(context, "fixture-owner", "desktop", sessionInput("c".repeat(64)))
    assertEquals(2, broadcasts.size)
    SessionDelivery.identity(context, "")
    SessionDelivery.receive(context, "fixture-owner", "desktop", sessionInput("d".repeat(64)))
    assertEquals(2, broadcasts.size)
  }

  @Test fun completedTaskBackgroundPresentationKeepsTheCanonicalDeviceInTheRealClickResponse() {
    lifecycle(Lifecycle.State.STARTED)
    val input = sessionInput().put("sender", JSONObject().put("id", "fixture-bot"))
    SessionDelivery.receive(context, "fixture-owner", "desktop", input)
    ChatNotificationsService().handleIntent(context, broadcasts.single())
    ChatNotificationsService().handleIntent(context, broadcasts.last())
    val notification = published.get(5, TimeUnit.SECONDS)
    assertEquals(0, notification.flags and android.app.Notification.FLAG_ONLY_ALERT_ONCE)
    val click = shadowOf(notification.contentIntent).savedIntent
    val response = NotificationsService.getNotificationResponseFromBroadcastIntent(click)
    assertEquals(sessionInput().getString("deepLink"), response.notification.notificationRequest.content.body!!.getString("deepLink"))
    assertEquals(sessionInput().getString("eventId"), response.notification.notificationRequest.identifier)
    assertEquals("Final reply", response.notification.notificationRequest.content.text)
  }

  @Test fun nativeRelayRequiresTheAuthenticatedDeviceAcceptedPeerAndFreshSubscriptionBeforeDelivery() {
    val sent = mutableListOf<JSONObject>()
    val ws = mockk<WebSocket>(relaxed = true)
    every { ws.send(any<String>()) } answers { sent.add(JSONObject(firstArg<String>())); true }
    val http = mockk<OkHttpClient>()
    lateinit var listener: WebSocketListener
    every { http.newWebSocket(any<Request>(), any()) } answers { listener = secondArg(); ws }
    var enabled = true
    val relay = SessionRelay(context, Handler(Looper.getMainLooper()), http) { enabled }
    val config = SessionRelayConfiguration("fixture-owner", "fixture-member", "phone",
      "wss://invalid.example/api/device-link/ws", "invalid-test-token", listOf("desktop", "desktop-two"))
    fun receive(frame: JSONObject) {
      listener.onMessage(ws, frame.toString()); shadowOf(Looper.getMainLooper()).idle()
    }
    try {
      relay.update(config)
      listener.onOpen(ws, mockk<Response>()); shadowOf(Looper.getMainLooper()).idle()
      assertEquals("hello", sent.single().getString("kind"))
      receive(JSONObject().put("v", 1).put("kind", "hello-ack").put("payload", JSONObject()
        .put("serverProtocolVersion", 1).put("deviceId", "phone").put("userId", "fixture-member")))
      val open = sent.single { it.getString("kind") == "link-open" && it.getString("dst") == "desktop" }
      receive(JSONObject().put("v", 1).put("kind", "link-accept").put("src", "desktop").put("dst", "phone")
        .put("id", open.getString("id")).put("payload", JSONObject().put("capabilities", org.json.JSONArray().put("mobile-local-notifications-v1"))))
      val subscribe = sent.single { it.getString("kind") == "invoke" }
      assertEquals("device-link:subscribe", subscribe.getJSONObject("payload").getString("channel"))
      val topic = subscribe.getJSONObject("payload").getJSONArray("args").getJSONObject(0).getJSONArray("topics").getString(0)
      val notice = sessionInput().put("subscriptionId", topic.removePrefix("notifications:"))
      fun push(source: String = "desktop", payload: JSONObject = notice) = JSONObject().put("v", 1).put("kind", "push")
        .put("src", source).put("dst", "phone").put("payload", JSONObject().put("channel", "device-link:mobile-notification").put("payload", payload))
      receive(push("unaccepted-device"))
      receive(push(payload = sessionInput().put("subscriptionId", "old-subscription")))
      receive(push().put("sharedTask", JSONObject()))
      assertTrue(broadcasts.isEmpty())
      receive(push()); assertEquals(1, broadcasts.size)
      receive(push()); assertEquals(1, broadcasts.size)
      val otherOpen = sent.single { it.getString("kind") == "link-open" && it.getString("dst") == "desktop-two" }
      receive(JSONObject().put("v", 1).put("kind", "link-accept").put("src", "desktop-two").put("dst", "phone")
        .put("id", otherOpen.getString("id")).put("payload", JSONObject().put("capabilities", org.json.JSONArray().put("mobile-local-notifications-v1"))))
      val otherSubscribe = sent.single { it.getString("kind") == "invoke" && it.getString("dst") == "desktop-two" }
      val otherTopic = otherSubscribe.getJSONObject("payload").getJSONArray("args").getJSONObject(0).getJSONArray("topics").getString(0)
      receive(JSONObject().put("v", 1).put("kind", "relay-error").put("payload", JSONObject().put("dst", "desktop").put("code", "DEVICE_OFFLINE")))
      receive(push("desktop-two", sessionInput("c".repeat(64)).put("deepLink", "/sessions/other?deviceId=desktop-two")
        .put("subscriptionId", otherTopic.removePrefix("notifications:"))))
      assertEquals(2, broadcasts.size)
      verify(exactly = 1) { http.newWebSocket(any<Request>(), any()) }
      enabled = false
      receive(push(payload = sessionInput("e".repeat(64)).put("subscriptionId", topic.removePrefix("notifications:"))))
      assertEquals(2, broadcasts.size)
    } finally { relay.stop() }
  }
}
