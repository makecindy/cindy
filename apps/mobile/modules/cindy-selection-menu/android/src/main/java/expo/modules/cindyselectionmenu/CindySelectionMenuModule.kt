package expo.modules.cindyselectionmenu

import android.graphics.Rect
import android.os.Handler
import android.os.Looper
import android.text.Selection
import android.text.Spannable
import android.view.ActionMode
import android.view.Menu
import android.view.MenuItem
import android.view.View
import android.widget.TextView
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.lang.ref.WeakReference

/** Adds actions to the existing TextView selection menu; leaves native layout and handles intact. */
class CindySelectionMenuModule : Module() {
  private data class Binding(
    val view: WeakReference<TextView>,
    val previous: ActionMode.Callback?,
    val callback: ActionMode.Callback,
  )
  private val bindings = mutableMapOf<String, Binding>()

  override fun definition() = ModuleDefinition {
    Name("CindySelectionMenu")
    Events("onAction")

    AsyncFunction("attach") { tag: Int, registration: String, quoteLabel: String, sideChatLabel: String ->
      val view = appContext.findView<View>(tag) as? TextView ?: return@AsyncFunction
      detach(registration)
      // Recycling/re-rendering can attach again before an earlier JS cleanup arrives.
      bindings.filterValues { it.view.get() === view }.keys.toList().forEach { detach(it) }
      val previous = view.customSelectionActionModeCallback
      val quoteId = View.generateViewId()
      val sideChatId = View.generateViewId()
      val callback = object : ActionMode.Callback2() {
        private fun addActions(menu: Menu) {
          if (quoteLabel.isNotEmpty() && menu.findItem(quoteId) == null) {
            menu.add(Menu.NONE, quoteId, 0, quoteLabel).setShowAsAction(MenuItem.SHOW_AS_ACTION_ALWAYS)
          }
          if (sideChatLabel.isNotEmpty() && menu.findItem(sideChatId) == null) {
            menu.add(Menu.NONE, sideChatId, 1, sideChatLabel).setShowAsAction(MenuItem.SHOW_AS_ACTION_ALWAYS)
          }
        }

        override fun onCreateActionMode(mode: ActionMode, menu: Menu): Boolean {
          if (previous?.onCreateActionMode(mode, menu) == false) return false
          addActions(menu)
          return true
        }

        override fun onPrepareActionMode(mode: ActionMode, menu: Menu): Boolean {
          val changed = previous?.onPrepareActionMode(mode, menu) ?: false
          addActions(menu)
          return changed
        }

        override fun onActionItemClicked(mode: ActionMode, item: MenuItem): Boolean {
          val action = when (item.itemId) {
            quoteId -> "quote"
            sideChatId -> "side-chat"
            else -> return previous?.onActionItemClicked(mode, item) ?: false
          }
          // Resolve at tap time: handles may have moved since the menu first appeared.
          val text = view.text
          val start = minOf(view.selectionStart, view.selectionEnd)
          val end = maxOf(view.selectionStart, view.selectionEnd)
          if (bindings[registration]?.callback === this && start >= 0 && end > start && end <= text.length) {
            sendEvent("onAction", mapOf("registration" to registration, "action" to action,
              "text" to text.subSequence(start, end).toString()))
          }
          mode.finish()
          if (text is Spannable) Selection.removeSelection(text)
          return true
        }

        override fun onDestroyActionMode(mode: ActionMode) {
          previous?.onDestroyActionMode(mode)
        }

        override fun onGetContentRect(mode: ActionMode, view: View, outRect: Rect) {
          if (previous is ActionMode.Callback2) previous.onGetContentRect(mode, view, outRect)
          else super.onGetContentRect(mode, view, outRect)
        }
      }
      bindings[registration] = Binding(WeakReference(view), previous, callback)
      view.customSelectionActionModeCallback = callback
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("detach") { registration: String -> detach(registration) }.runOnQueue(Queues.MAIN)

    OnDestroy {
      Handler(Looper.getMainLooper()).post {
        bindings.values.toList().forEach { restore(it) }
        bindings.clear()
      }
    }
  }

  private fun restore(binding: Binding) {
    val view = binding.view.get() ?: return
    if (view.customSelectionActionModeCallback === binding.callback) {
      view.customSelectionActionModeCallback = binding.previous
    }
  }

  private fun detach(registration: String) {
    bindings.remove(registration)?.let { restore(it) }
  }
}
