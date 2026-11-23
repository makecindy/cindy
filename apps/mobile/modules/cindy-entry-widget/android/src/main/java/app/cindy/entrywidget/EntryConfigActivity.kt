package app.cindy.entrywidget

import android.app.Activity
import android.app.AlertDialog
import android.appwidget.AppWidgetManager
import android.content.Intent
import android.content.res.Configuration
import android.os.Bundle

/**
 * 组件的设置页：加组件时（以及桌面的「编辑组件」）列出「新建任务」和每位伙伴。
 * 列表来自 App 写下的快照；还没有快照时只留「新建任务」，并提示先打开 App。
 */
class EntryConfigActivity : Activity() {
  private var appWidgetId = AppWidgetManager.INVALID_APPWIDGET_ID

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    appWidgetId = intent?.getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID)
      ?: AppWidgetManager.INVALID_APPWIDGET_ID
    setResult(RESULT_CANCELED, Intent().putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, appWidgetId))
    if (appWidgetId == AppWidgetManager.INVALID_APPWIDGET_ID) return finish()

    val targets = EntryWidgetStore.targets(this)
    if (targets.isEmpty()) {
      // 还没有名单：组件本身能显示「打开 App」的空态，不拦着用户放上去。
      return done(EntryWidgetStore.NEW_TASK_ID)
    }
    val ids = targets.map { it.id }
    val labels = targets.map { target ->
      if (target.subtitle.isEmpty()) target.title else "${target.title} · ${target.subtitle}"
    }
    val current = ids.indexOf(EntryWidgetStore.selection(this, appWidgetId)).coerceAtLeast(0)
    AlertDialog.Builder(this, dialogTheme())
      .setTitle(getString(R.string.cindy_entry_widget_pick_title))
      .setSingleChoiceItems(labels.toTypedArray(), current) { dialog, which ->
        dialog.dismiss()
        done(ids[which])
      }
      .setOnCancelListener { finish() }
      .show()
  }

  private fun done(targetId: String) {
    EntryWidgetStore.setSelection(this, appWidgetId, targetId)
    EntryWidgetProvider.refreshAll(this)
    setResult(RESULT_OK, Intent().putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, appWidgetId))
    finish()
  }

  private val night: Boolean
    get() = (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES

  private fun dialogTheme() =
    if (night) android.R.style.Theme_DeviceDefault_Dialog_Alert else android.R.style.Theme_DeviceDefault_Light_Dialog_Alert
}
