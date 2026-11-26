package app.cindy.backgroundwork

import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.IBinder

/** Started while the user's activity is foreground, released by the native
 * 20-second lease. Unlike a headless task alone, a started service keeps Android
 * from treating the process as cached and closing its in-flight sockets.
 * Never sticky, foreground, scheduled or started again after a process kill. */
class CindyBackgroundWorkService : Service() {
  override fun onBind(intent: Intent?): IBinder? = null
  override fun onCreate() { super.onCreate(); running = this }
  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (owners.isEmpty()) stopSelf()
    return START_NOT_STICKY
  }
  override fun onDestroy() {
    if (running === this) running = null
    super.onDestroy()
  }

  companion object {
    // Only the main thread touches these; tokens separate overlapping React
    // instances and prevent an old module's cleanup from stopping a new lease.
    private val owners = mutableSetOf<Any>()
    private var running: CindyBackgroundWorkService? = null

    fun acquire(context: Context, token: Any): Boolean {
      owners.add(token)
      return try {
        if (context.startService(Intent(context, CindyBackgroundWorkService::class.java)) == null) {
          release(token); false
        } else true
      } catch (_: IllegalStateException) {
        // Android refuses a new service when already background/restricted.
        // Never escalate to a foreground service or request another permission.
        release(token); false
      } catch (_: SecurityException) {
        release(token); false
      }
    }

    fun release(token: Any) {
      owners.remove(token)
      if (owners.isEmpty()) running?.stopSelf()
    }
  }
}
