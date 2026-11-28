package __CINDY_ANDROID_PACKAGE__

import android.util.Log
import android.view.Choreographer.FrameCallback
import com.facebook.react.internal.ChoreographerProvider
import com.facebook.react.modules.core.ReactChoreographer

internal object ReactChoreographerResumeRepair {
  private const val TAG = "CindyTimerRecovery"

  fun rearmIfNeeded() {
    try {
      val reactChoreographer = ReactChoreographer.getInstance()
      val type = reactChoreographer.javaClass
      val queues = type.field("callbackQueues").get(reactChoreographer) ?: return
      synchronized(queues) {
        val totalCallbacks = type.field("totalCallbacks").getInt(reactChoreographer)
        val hasPostedCallback = type.field("hasPostedCallback")
        if (totalCallbacks == 0 || !hasPostedCallback.getBoolean(reactChoreographer)) return
        val platformChoreographer = type.field("choreographer").get(reactChoreographer) as? ChoreographerProvider.Choreographer ?: return
        val frameCallback = type.field("frameCallback").get(reactChoreographer) as FrameCallback
        platformChoreographer.removeFrameCallback(frameCallback)
        hasPostedCallback.setBoolean(reactChoreographer, false)
        platformChoreographer.postFrameCallback(frameCallback)
        hasPostedCallback.setBoolean(reactChoreographer, true)
      }
    } catch (_: IllegalStateException) {
    } catch (error: ReflectiveOperationException) {
      Log.w(TAG, "Unable to re-arm ReactChoreographer after host resume", error)
    }
  }

  private fun Class<*>.field(name: String) = getDeclaredField(name).apply { isAccessible = true }
}
