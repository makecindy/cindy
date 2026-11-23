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

    /** 目标数量，供 JS 判断写入是否生效；写失败返回 -1。 */
    Function("writeTargets") { json: String ->
      val context = appContext.reactContext ?: return@Function -1
      val written = EntryWidgetStore.write(context, json)
      if (!written) return@Function -1
      EntryWidgetProvider.refreshAll(context)
      EntryWidgetStore.targets(context).size
    }

    /** 当前已写入的目标数量；组件设置页与 JS 都据此决定显示什么。 */
    Function("targetCount") {
      val context = appContext.reactContext ?: return@Function 0
      EntryWidgetStore.targets(context).size
    }
  }
}
