package app.cindy.haptics

import android.content.Context
import android.media.AudioAttributes
import android.os.Build
import android.os.SystemClock
import android.os.VibrationEffect
import android.os.Vibrator
import android.provider.Settings
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class CindyHapticsModule : Module() {
  private var lastFeedback = -80L

  override fun definition() = ModuleDefinition {
    Name("CindyHaptics")
    AsyncFunction("play") { kind: String ->
      play(kind)
    }.runOnQueue(Queues.MAIN)
  }

  private fun play(kind: String): Boolean {
    if (kind != "selection" && kind != "commit") return false
    // API level, hasVibrator, or amplitude control alone do not establish rich haptics.
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return false
    val activity = appContext.currentActivity ?: return false
    val view = activity.window?.decorView ?: return false
    if (!view.hasWindowFocus() || !view.isHapticFeedbackEnabled) return false
    return runCatching {
      if (Settings.System.getInt(activity.contentResolver, Settings.System.HAPTIC_FEEDBACK_ENABLED, 0) != 1) {
        return false
      }
      @Suppress("DEPRECATION")
      val vibrator = activity.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator ?: return false
      val primitive = VibrationEffect.Composition.PRIMITIVE_TICK
      if (!vibrator.hasVibrator() || !vibrator.areAllPrimitivesSupported(primitive)) return false
      val now = SystemClock.uptimeMillis()
      if (now - lastFeedback < 80) return false
      val effect = VibrationEffect.startComposition()
        .addPrimitive(primitive, if (kind == "selection") 0.35f else 0.55f)
        .compose()
      val attributes = AudioAttributes.Builder()
        .setUsage(AudioAttributes.USAGE_ASSISTANCE_SONIFICATION)
        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build()
      // Only play the exact supported primitive; no predefined-effect or waveform fallback.
      vibrator.vibrate(effect, attributes)
      lastFeedback = now
      true
    }.getOrDefault(false)
  }
}
