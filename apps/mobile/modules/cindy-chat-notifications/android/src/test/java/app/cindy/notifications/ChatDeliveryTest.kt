package app.cindy.notifications

import android.app.NotificationManager
import android.app.NotificationChannel
import android.content.Context
import android.content.ContextWrapper
import android.content.Intent
import android.os.Bundle
import android.os.Parcel
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
}
