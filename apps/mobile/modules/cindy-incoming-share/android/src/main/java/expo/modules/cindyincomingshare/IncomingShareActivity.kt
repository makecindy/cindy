package expo.modules.cindyincomingshare

import android.app.Activity
import android.content.Intent
import android.os.Bundle

/** A separate task keeps every temporary grant alive until its queued copy finishes.
 * Bringing MainActivity forward must not destroy another still-copying receiver.
 */
class IncomingShareActivity : Activity() {
  @Volatile private var cancelled = false
  private var pendingCopies = 0

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    if (savedInstanceState != null) { finish(); return }
    receive(intent)
  }
  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    receive(intent)
  }
  private fun receive(intent: Intent) {
    if (intent.action !in setOf(Intent.ACTION_SEND, Intent.ACTION_SEND_MULTIPLE)) {
      if (pendingCopies == 0) finish()
      return
    }
    val source = Intent(intent)
    val context = applicationContext
    val generation = try { IncomingShareInbox.epoch(context) } catch (_: Exception) {
      IncomingShareInbox.failed()
      showApp()
      if (pendingCopies == 0) finish()
      return
    }
    pendingCopies += 1
    IncomingShareInbox.executor.execute {
      try {
        IncomingShareInbox.receive(context, source, generation) { cancelled }
      } catch (_: Exception) {
        IncomingShareInbox.failed()
      } finally {
        runOnUiThread {
          pendingCopies -= 1
          if (!cancelled) showApp()
          if (pendingCopies == 0) finish()
        }
      }
    }
  }
  private fun showApp() {
    packageManager.getLaunchIntentForPackage(packageName)?.let {
      it.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
      startActivity(it)
    }
  }
  override fun onDestroy() {
    cancelled = true
    super.onDestroy()
  }
}
