package app.cindy.backgroundwork

import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.jstasks.HeadlessJsTaskConfig
import com.facebook.react.jstasks.HeadlessJsTaskContext
import expo.modules.kotlin.Promise
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/** Keep RN timers alive for a bounded user-initiated handoff. This does not
 * restart the process or prevent Android from killing it;
 * the durable outbox remains responsible for recovery. No wake lock/permission. */
class CindyBackgroundWorkModule : Module() {
  private val handler = Handler(Looper.getMainLooper())
  private var lastId = 0
  private val leases = mutableMapOf<Int, Lease>()

  private data class Lease(
    val context: HeadlessJsTaskContext,
    val taskId: Int,
    val deadline: Long,
    val timeout: Runnable,
    val serviceToken: Any,
    var completion: Promise? = null,
  )

  override fun definition() = ModuleDefinition {
    Name("CindyBackgroundWork")

    AsyncFunction("begin") {
      expireOverdue()
      val react = appContext.reactContext as? ReactApplicationContext
      val serviceToken = Any()
      if (react == null || !react.hasActiveReactInstance() || !CindyBackgroundWorkService.acquire(react, serviceToken)) {
        mapOf("id" to 0, "remainingMs" to 0)
      } else {
        val id = ++lastId
        val context = HeadlessJsTaskContext.getInstance(react)
        val data = Arguments.createMap().apply { putInt("id", id) }
        val taskId = try {
          context.startTask(HeadlessJsTaskConfig("CindyBackgroundWork", data, 20_000L, true))
        } catch (error: Exception) {
          CindyBackgroundWorkService.release(serviceToken)
          throw error
        }
        val timeout = Runnable { end(id) }
        leases[id] = Lease(context, taskId, SystemClock.elapsedRealtime() + 20_000L, timeout, serviceToken)
        // Native expiry is independent of suspended JS timers. RN's task timeout
        // also bounds execution if the JS completion has not arrived yet.
        handler.postDelayed(timeout, 20_000L)
        mapOf("id" to id, "remainingMs" to 20_000)
      }
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("waitUntilEnded") { id: Int, promise: Promise ->
      expireOverdue()
      val lease = leases[id]
      if (lease == null) promise.resolve(null)
      else {
        lease.completion?.resolve(null)
        lease.completion = promise
      }
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("end") { id: Int -> end(id) }.runOnQueue(Queues.MAIN)

    // Handler/RN timeouts use uptime; deep sleep must not renew an old grant.
    OnActivityEntersForeground { expireOverdue() }

    OnDestroy {
      handler.post { leases.keys.toList().forEach { end(it) } }
    }
  }

  private fun expireOverdue() {
    val now = SystemClock.elapsedRealtime()
    leases.filterValues { it.deadline <= now }.keys.toList().forEach { end(it) }
  }

  private fun end(id: Int) {
    val lease = leases.remove(id) ?: return
    handler.removeCallbacks(lease.timeout)
    lease.context.finishTask(lease.taskId)
    lease.completion?.resolve(null)
    CindyBackgroundWorkService.release(lease.serviceToken)
  }
}
