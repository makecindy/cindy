package app.cindy.notifications

import android.app.NotificationManager
import android.content.Context
import android.os.Build
import androidx.core.app.NotificationManagerCompat

/** Current process only. No account IDs, endpoints, messages, credentials or exception text. */
internal object ChatDiagnostics {
  private var connection = "stopped"
  private var connectionError = "none"
  private var inbox = "unchecked"
  private var inboxAt = 0L
  private var inboxRows = 0
  private var httpStatus = 0
  private val counts = mutableMapOf<String, Int>()
  private var sessionRelay = "stopped"
  @Synchronized fun sessionRelay(value: String) { sessionRelay = value }
  @Synchronized fun reset() {
    connection = "stopped"; connectionError = "none"; inbox = "unchecked"; inboxAt = 0; inboxRows = 0; httpStatus = 0; counts.clear(); sessionRelay = "stopped"
  }
  @Synchronized fun connection(value: String) {
    connection = value
    if (value in setOf("auth-timeout", "actor-mismatch", "server-error", "protocol-error", "auth-or-connect-failed", "disconnected")) connectionError = value
  }
  @Synchronized fun inbox(value: String, rows: Int = 0, status: Int = 0) {
    inbox = value; inboxRows = rows; httpStatus = status; inboxAt = System.currentTimeMillis()
  }
  @Synchronized fun count(key: String) { counts[key] = minOf((counts[key] ?: 0) + 1, Int.MAX_VALUE - 1) }
  @Synchronized fun snapshot(context: Context): Map<String, Any> {
    val channel = if (Build.VERSION.SDK_INT >= 26)
      context.getSystemService(NotificationManager::class.java).getNotificationChannel("chat-messages")?.importance ?: -1 else -2
    return mapOf("connection" to connection, "connectionError" to connectionError, "inbox" to inbox, "inboxAt" to inboxAt,
      "inboxRows" to inboxRows, "httpStatus" to httpStatus,
      "serviceRunning" to ChatConnectionService.running, "sessionRelay" to sessionRelay,
      "notificationsEnabled" to NotificationManagerCompat.from(context).areNotificationsEnabled(),
      "messageChannelImportance" to channel) + counts
  }
}
