package expo.modules.cindyincomingshare

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class CindyIncomingShareModule : Module() {
  private val context get() = requireNotNull(appContext.reactContext).applicationContext
  private val changed: () -> Unit = { sendEvent("onChange", emptyMap<String, Any>()) }
  override fun definition() = ModuleDefinition {
    Name("CindyIncomingShare")
    Events("onChange")
    OnCreate { IncomingShareInbox.listeners.add(changed) }
    OnDestroy { IncomingShareInbox.listeners.remove(changed) }
    Function("bindAccount") { account: String -> IncomingShareInbox.bindAccount(context, account) }
    Function("readSnapshot") { IncomingShareInbox.read(context) }
    AsyncFunction("readSnapshotAsync") { IncomingShareInbox.read(context) }
    Function("clearSnapshot") { expected: String -> IncomingShareInbox.clear(context, expected) }
    Function("discardAllSnapshots") { IncomingShareInbox.discardAll(context) }
    Function("rejectUnreadableSnapshot") { IncomingShareInbox.discardAll(context) }
  }
}
