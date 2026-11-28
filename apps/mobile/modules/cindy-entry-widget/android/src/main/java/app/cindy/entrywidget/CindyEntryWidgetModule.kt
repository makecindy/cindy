package app.cindy.entrywidget

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * App → 桌面组件的单向通道：写入目标快照（新建任务 + 伙伴），随后重绘所有组件。
 * 组件读不到登录态，所以这里只写「已经能打开的深链」，不写凭证。
 */
class CindyEntryWidgetModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("CindyEntryWidget")

    /** 写入成功返回目标数量，失败返回 -1；JS 只判 `< 0`。 */
    Function("writeTargets") { json: String ->
      val context = appContext.reactContext ?: return@Function -1
      val written = EntryWidgetStore.write(context, json)
      if (written < 0) return@Function -1
      EntryWidgetProvider.refreshAll(context)
      written
    }
  }
}
