package app.cindy.notifications

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Paint
import android.util.Base64
import androidx.core.app.NotificationCompat
import androidx.core.app.Person
import androidx.core.graphics.drawable.IconCompat
import com.google.firebase.messaging.RemoteMessage
import expo.modules.notifications.service.ExpoFirebaseMessagingService
import expo.modules.notifications.service.NotificationsService
import expo.modules.notifications.service.delegates.ExpoPresentationDelegate
import expo.modules.notifications.service.delegates.FirebaseMessagingDelegate
import expo.modules.notifications.service.interfaces.PresentationDelegate
import expo.modules.notifications.notifications.model.Notification
import expo.modules.notifications.notifications.model.NotificationBehaviorRecord
import org.json.JSONArray
import org.json.JSONObject

/** Only actor/message IDs persist. Credentials and notification bodies never enter this store. */
object ChatDelivery {
  private const val STORE = "cindy-chat-notification-ids"
  @Synchronized fun identity(context: Context, actor: String) {
    val prefs = context.getSharedPreferences(STORE, Context.MODE_PRIVATE)
    if (prefs.getString("actor", "") != actor) prefs.edit().clear().putString("actor", actor).apply()
  }
  @Synchronized fun receive(context: Context, data: Map<String, String>) {
    val body = try { JSONObject(data["body"] ?: "{}") } catch (_: Exception) { return }
    if (body.optString("category") == "chat-message") {
      val prefs = context.getSharedPreferences(STORE, Context.MODE_PRIVATE)
      val actor = prefs.getString("actor", "") ?: ""
      if (actor.isEmpty() || body.optString("recipientId") != actor) return
      val id = data["tag"] ?: return
      if (!id.matches(Regex("[a-fA-F0-9-]{36}"))) return
      val ids = try { JSONArray(prefs.getString("ids", "[]")) } catch (_: Exception) { JSONArray() }
      if ((0 until ids.length()).any { ids.optString(it) == id }) return
      val next = JSONArray()
      for (i in maxOf(0, ids.length() - 255) until ids.length()) next.put(ids.getString(i))
      next.put(id)
      prefs.edit().putString("ids", next.toString()).apply()
    }
    val display = data.toMutableMap()
    if (!context.getSharedPreferences("cindy-chat-background", Context.MODE_PRIVATE).getBoolean("preview", true)) {
      body.remove("sender"); body.remove("senderName"); body.remove("body")
      display["body"] = body.toString(); display["message"] = ""
    }
    FirebaseMessagingDelegate(context).onMessageReceived(RemoteMessage.Builder("cindy").setData(display).build())
  }
}

class ChatFirebaseService : ExpoFirebaseMessagingService() {
  override fun onMessageReceived(remoteMessage: RemoteMessage) = ChatDelivery.receive(this, remoteMessage.data)
}

/** Keep Expo's pending-intent, cold-start response and foreground suppression contracts. */
class ChatNotificationsService : NotificationsService() {
  override fun getPresentationDelegate(context: Context): PresentationDelegate = object : ExpoPresentationDelegate(context) {
    override suspend fun createNotification(notification: Notification, notificationBehavior: NotificationBehaviorRecord?): android.app.Notification {
      val original = super.createNotification(notification, notificationBehavior)
      val content = notification.notificationRequest.content
      val data = content.body ?: return original
      val chat = data.optString("category") == "chat-message"
      val sender = data.optJSONObject("sender")
      if (!chat && (data.optString("category") !in listOf("session-done", "session-error", "session-needs-reply") || sender == null)) return original
      val group = chat && data.optString("conversationKind") != "direct"
      val name = if (chat) data.optString("senderName") else content.title ?: ""
      if (name.isBlank()) return original
      val person = Person.Builder().setName(name).setKey(sender?.optString("id") ?: name)
        .setIcon(IconCompat.createWithBitmap(avatar(context, sender?.optJSONObject("avatar"), name))).build()
      val text = (content.text ?: "").removePrefix("$name: ")
      return NotificationCompat.Builder(context, original)
        .setCategory(NotificationCompat.CATEGORY_MESSAGE).setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
        .setOnlyAlertOnce(true)
        .setStyle(NotificationCompat.MessagingStyle(Person.Builder().setName("Cindy").build())
          .setConversationTitle(if (group) content.title else null).setGroupConversation(group)
          .addMessage(text, notification.originDate.time.takeIf { it > 0 } ?: System.currentTimeMillis(), person)).build()
    }
  }
}

private fun avatar(context: Context, data: JSONObject?, name: String): Bitmap {
  val value = data?.optString("value") ?: ""
  if (data?.optString("kind") == "preset" && value in listOf("cindy", "dash", "lizi")) {
    val resource = context.resources.getIdentifier("cindy_teammate_$value", "drawable", context.packageName)
    if (resource != 0) {
      val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
      BitmapFactory.decodeResource(context.resources, resource, bounds)
      val sample = BitmapFactory.Options().apply { inSampleSize = maxOf(1, maxOf(bounds.outWidth, bounds.outHeight) / 80) }
      BitmapFactory.decodeResource(context.resources, resource, sample)?.let {
        return Bitmap.createScaledBitmap(it, 80, 80, true)
      }
    }
  }
  if (data?.optString("kind") == "jpeg" && value.length <= 2048) {
    try {
      val bytes = Base64.decode(value, Base64.DEFAULT)
      val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
      BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
      if (bounds.outWidth in 1..128 && bounds.outHeight in 1..128) {
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size)?.let { return it }
      }
    } catch (_: Exception) { /* readable identity fallback */ }
  }
  val bitmap = Bitmap.createBitmap(80, 80, Bitmap.Config.ARGB_8888)
  val canvas = Canvas(bitmap)
  val paint = Paint(Paint.ANTI_ALIAS_FLAG)
  // Native system notification identity placeholder, independent of application themes.
  val colors = context.obtainStyledAttributes(intArrayOf(android.R.attr.colorBackground, android.R.attr.textColorPrimary))
  paint.color = colors.getColor(0, android.graphics.Color.TRANSPARENT); canvas.drawCircle(40f,40f,40f,paint)
  paint.color = colors.getColor(1, android.graphics.Color.TRANSPARENT); colors.recycle()
  paint.textSize = 36f; paint.textAlign = Paint.Align.CENTER
  val symbol = if (data?.optString("kind") == "symbol" && value.length <= 32) value else name.take(1).uppercase()
  canvas.drawText(symbol,40f,40f-(paint.ascent()+paint.descent())/2,paint)
  return bitmap
}
