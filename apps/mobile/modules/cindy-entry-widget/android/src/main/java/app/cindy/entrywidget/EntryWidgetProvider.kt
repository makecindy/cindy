package app.cindy.entrywidget

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.res.Configuration
import android.net.Uri
import android.os.Bundle
import android.view.View
import android.widget.RemoteViews
import java.io.File

/**
 * 桌面入口组件。每个组件是一张卡片：头像 / 字 + 名字（标准版再加电脑名），点一下带着深链回到 App。
 *
 * 桌面上的每份组件各记一个目标（新建任务或某位伙伴），由 [EntryConfigActivity] 选择；
 * 目标列表和图标由 App 在登录后写入，组件自己不联网、也不读登录态。目标暂时缺失时显示
 * 说明文案并点开 App，而不是留一块空白。
 *
 * 尺寸：默认放上桌面是 2×2，可缩到 1 格。版式按启动器报告的实际格子尺寸选 —— 两格见方用
 * 标准卡，一格宽用紧凑竖排（头像 + 名字，高度不够时只留头像），宽而矮的一行用横排；
 * 拖动改变尺寸后系统会带着新尺寸重新调用 [onAppWidgetOptionsChanged]。
 */
class EntryWidgetProvider : AppWidgetProvider() {
  override fun onUpdate(context: Context, manager: AppWidgetManager, appWidgetIds: IntArray) {
    for (appWidgetId in appWidgetIds) render(context, manager, appWidgetId, null)
  }

  override fun onAppWidgetOptionsChanged(context: Context, manager: AppWidgetManager, appWidgetId: Int, newOptions: Bundle) {
    render(context, manager, appWidgetId, newOptions)
  }

  override fun onDeleted(context: Context, appWidgetIds: IntArray) {
    for (appWidgetId in appWidgetIds) EntryWidgetStore.forget(context, appWidgetId)
  }

  companion object {
    /** 两格的实际尺寸；启动器按 1 格约 40–75dp、2 格 ≥110dp 折算。 */
    private const val TWO_CELLS_DP = 110f
    /** 紧凑版里放得下名字的高度：4dp×2 边距 + 40dp 头像 + 3dp 间距 + 11sp 字高（约 16dp）。
     *  比这更矮时只留头像，看起来就是一枚桌面图标。 */
    private const val COMPACT_NAME_MIN_DP = 68f
    /** 高度不足宽度的这个比例，按「1 行高」处理（2×1 约 0.43，两行见方约 0.9–1.0）。 */
    private const val ROW_HEIGHT_RATIO = 0.62f
    /** 取不到尺寸时按 2×2 画，与默认放置一致。 */
    private const val UNKNOWN_SIZE_DP = 110f

    private enum class Shape { CARD, COMPACT, ROW }

    private fun shape(widthDp: Float, heightDp: Float): Shape = when {
      widthDp < TWO_CELLS_DP -> Shape.COMPACT
      heightDp < widthDp * ROW_HEIGHT_RATIO -> Shape.ROW
      else -> Shape.CARD
    }

    private fun layoutFor(shape: Shape): Int = when (shape) {
      Shape.CARD -> R.layout.cindy_entry_widget
      Shape.COMPACT -> R.layout.cindy_entry_widget_compact
      Shape.ROW -> R.layout.cindy_entry_widget_row
    }

    /**
     * 启动器在竖屏把实际尺寸报成 MIN_WIDTH / MAX_HEIGHT，横屏反到 MAX_WIDTH / MIN_HEIGHT；
     * 与用量组件同一读法，旧系统没有逐尺寸快照时也能拿到当前格子大小。
     */
    private fun sizeDp(context: Context, options: Bundle?): Pair<Float, Float> {
      if (options == null) return UNKNOWN_SIZE_DP to UNKNOWN_SIZE_DP
      val landscape = context.resources.configuration.orientation == Configuration.ORIENTATION_LANDSCAPE
      val width = options.getInt(
        if (landscape) AppWidgetManager.OPTION_APPWIDGET_MAX_WIDTH else AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH,
      ).takeIf { it > 0 }?.toFloat() ?: UNKNOWN_SIZE_DP
      val height = options.getInt(
        if (landscape) AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT else AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT,
      ).takeIf { it > 0 }?.toFloat() ?: UNKNOWN_SIZE_DP
      return width to height
    }

    private fun render(context: Context, manager: AppWidgetManager, appWidgetId: Int, options: Bundle?) {
      val bundle = options ?: runCatching { manager.getAppWidgetOptions(appWidgetId) }.getOrNull()
      val (widthDp, heightDp) = sizeDp(context, bundle)
      val shape = shape(widthDp, heightDp)
      // 三套版式共用同一组 view id；只碰当前版式里存在的 id，缺 id 会让整次更新被桌面拒绝。
      val views = RemoteViews(context.packageName, layoutFor(shape))
      val targets = EntryWidgetStore.targets(context)
      val selected = EntryWidgetStore.selection(context, appWidgetId)
      val target = targets.firstOrNull { it.id == selected } ?: targets.firstOrNull()
      if (target == null) {
        // 空态：只有标准卡放得下说明文案，紧凑 / 横排换成应用图标，点开仍能继续设置。
        if (shape == Shape.CARD) {
          views.setTextViewText(R.id.cindy_entry_widget_title, context.getString(R.string.cindy_entry_widget_empty))
          views.setTextViewText(R.id.cindy_entry_widget_subtitle, "")
          views.setViewVisibility(R.id.cindy_entry_widget_icon, View.GONE)
        } else {
          views.setViewVisibility(R.id.cindy_entry_widget_title, View.GONE)
          views.setViewVisibility(R.id.cindy_entry_widget_icon, View.VISIBLE)
          views.setImageViewResource(R.id.cindy_entry_widget_icon, context.applicationInfo.icon)
        }
        views.setOnClickPendingIntent(R.id.cindy_entry_widget_root, launch(context, null, appWidgetId))
        views.setContentDescription(R.id.cindy_entry_widget_root, context.getString(R.string.cindy_entry_widget_empty))
      } else {
        // 1 格高多数桌面只有 60–75dp，紧凑版够高才画名字，否则只留头像。
        val showName = shape != Shape.COMPACT || heightDp >= COMPACT_NAME_MIN_DP
        views.setViewVisibility(R.id.cindy_entry_widget_title, if (showName) View.VISIBLE else View.GONE)
        if (showName) views.setTextViewText(R.id.cindy_entry_widget_title, target.title)
        if (shape == Shape.CARD) {
          // 两格见方才画得下电脑名；矮一点的标准卡只留名字，不让副标题被截半个字。
          val showSubtitle = heightDp >= TWO_CELLS_DP
          views.setViewVisibility(R.id.cindy_entry_widget_subtitle, if (showSubtitle) View.VISIBLE else View.GONE)
          if (showSubtitle) views.setTextViewText(R.id.cindy_entry_widget_subtitle, target.subtitle)
        }
        views.setViewVisibility(R.id.cindy_entry_widget_icon, View.VISIBLE)
        val icon = icon(target)
        if (icon != null) views.setImageViewBitmap(R.id.cindy_entry_widget_icon, icon)
        else views.setImageViewResource(R.id.cindy_entry_widget_icon, context.applicationInfo.icon)
        // 头像为主的 1×1 可能不显示名字，读屏仍要能说出这是谁。
        views.setContentDescription(
          R.id.cindy_entry_widget_root,
          listOf(target.title, target.subtitle).filter { it.isNotEmpty() }.joinToString(", "),
        )
        views.setOnClickPendingIntent(R.id.cindy_entry_widget_root, launch(context, target.url, appWidgetId))
      }
      manager.updateAppWidget(appWidgetId, views)
    }

    /** 每次重绘都从文件读，头像换了以后下一次 App 写入就会带上新文件。 */
    private fun icon(target: EntryTarget) = target.iconFile
      ?.let(::File)
      ?.takeIf { it.exists() }
      ?.let { file -> runCatching { file.readBytes() }.getOrNull() }
      ?.let { bytes -> runCatching { android.graphics.BitmapFactory.decodeByteArray(bytes, 0, bytes.size) }.getOrNull() }

    /**
     * 深链带 `desktopEntry` 标记，由根级 DesktopEntryHost 在登录就绪后校验白名单再跳转 ——
     * 组件不绕过登录墙，也不直接打开任意页面。
     */
    private fun launch(context: Context, url: String?, appWidgetId: Int): PendingIntent {
      val intent = (context.packageManager.getLaunchIntentForPackage(context.packageName) ?: Intent())
        .apply {
          addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
          setPackage(context.packageName)
          if (url != null) {
            action = Intent.ACTION_VIEW
            data = Uri.parse(url)
          }
        }
      return PendingIntent.getActivity(
        context,
        appWidgetId,
        intent,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
      )
    }

    /** App 写完新目标后调用；没有组件时什么都不做。 */
    fun refreshAll(context: Context) {
      val app = context.applicationContext
      val manager = AppWidgetManager.getInstance(app) ?: return
      val ids = manager.getAppWidgetIds(ComponentName(app, EntryWidgetProvider::class.java))
      if (ids.isEmpty()) return
      for (appWidgetId in ids) render(app, manager, appWidgetId, null)
    }
  }
}
