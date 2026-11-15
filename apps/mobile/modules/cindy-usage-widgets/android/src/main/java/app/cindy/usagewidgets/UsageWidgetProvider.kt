package app.cindy.usagewidgets

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.res.Configuration
import android.os.Build
import android.os.Bundle
import android.util.SizeF
import android.widget.RemoteViews

/**
 * Home-screen widgets. Each is one bitmap drawn at the launcher cell's size ([WidgetRenderer]),
 * redrawn when the app hands over new data, when the widget is resized, and every 30 minutes so
 * reset countdowns and the "updated" age stay current.
 */
abstract class UsageWidgetProviderBase(private val kind: WidgetKind) : AppWidgetProvider() {
  // Drawing is the slow part (a bitmap per size and theme), so no update runs on the receiver's thread: it
  // goes to the one drawing thread and the broadcast stays pending until the widgets are done.
  override fun onUpdate(context: Context, manager: AppWidgetManager, appWidgetIds: IntArray) {
    updateAsync(context, appWidgetIds, kind, goAsync())
  }

  override fun onAppWidgetOptionsChanged(context: Context, manager: AppWidgetManager, appWidgetId: Int, newOptions: Bundle) {
    updateAsync(context, intArrayOf(appWidgetId), kind, goAsync())
  }

  /**
   * Debug builds only: `adb shell am broadcast -a app.cindy.usagewidgets.RENDER_PREVIEWS -n <provider>` writes the
   * widgets, drawn from sample data at every layout in both themes, to `cache/widget-previews`.
   */
  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action == ACTION_RENDER_PREVIEWS && context.applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE != 0) {
      renderPreviews(context, intent.getStringExtra("variant") ?: "multi", intent.getFloatExtra("width", 0f), intent.getFloatExtra("height", 0f))
      return
    }
    super.onReceive(context, intent)
  }

  override fun onDeleted(context: Context, appWidgetIds: IntArray) {
    for (id in appWidgetIds) WidgetStore.forget(context, id)
  }

  companion object {
    private const val MIN_DRAW_DENSITY = 0.3f

    const val ACTION_RENDER_PREVIEWS = "app.cindy.usagewidgets.RENDER_PREVIEWS"

    private fun renderPreviews(context: Context, variant: String, width: Float, height: Float) {
      val directory = java.io.File(context.cacheDir, "widget-previews").apply { mkdirs() }
      val sizes = if (width > 0 && height > 0) mapOf(WidgetFamily.of(width, height) to Pair(width, height)) else mapOf(
        WidgetFamily.Small to Pair(158f, 158f), WidgetFamily.Medium to Pair(338f, 158f), WidgetFamily.Large to Pair(338f, 354f),
      )
      val states = if (variant == "empty") mapOf("empty" to WidgetState.Empty) else mapOf(variant to WidgetSamples.state(variant))
      for ((name, state) in states) for ((family, size) in sizes) for (dark in listOf(false, true)) for (kind in WidgetKind.values()) {
        val bitmap = WidgetRenderer.render(context, kind, state, size.first, size.second, 3f, dark, family = family)
        java.io.File(directory, "${kind.name.lowercase()}-$name-${family.name.lowercase()}${if (width > 0) "-${width.toInt()}x${height.toInt()}" else ""}-${if (dark) "dark" else "light"}.png").outputStream().use {
          bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it)
        }
      }
    }

    private val redraw = java.util.concurrent.Executors.newSingleThreadExecutor { task -> Thread(task, "cindy-usage-widgets").apply { isDaemon = true } }
    private val redrawQueued = java.util.concurrent.atomic.AtomicBoolean(false)

    /**
     * Redraws on a background thread, so the app's JS thread never waits for the bitmaps. One thread runs
     * the draws in order and every draw reads the file as it is then, so a draw that started before a
     * sign-out cannot leave old data behind: the redraw queued after the sign-out runs last.
     */
    fun updateAllAsync(context: Context) {
      val app = context.applicationContext
      if (!redrawQueued.compareAndSet(false, true)) return
      redraw.execute {
        redrawQueued.set(false)
        try {
          updateAll(app)
        } catch (_: Exception) {
          // A launcher that went away mid-update; the next update draws again.
        }
      }
    }

    /** Draws the given widgets of one kind on the drawing thread, then releases the broadcast, if any. */
    fun updateAsync(context: Context, appWidgetIds: IntArray, kind: WidgetKind, pending: PendingResult? = null) {
      val app = context.applicationContext
      redraw.execute {
        try {
          val manager = AppWidgetManager.getInstance(app)
          for (id in appWidgetIds) {
            // One widget the launcher refuses must not stop the others from being drawn.
            try {
              update(app, manager, id, kind)
            } catch (_: Exception) {
              // Drawn again at the next update.
            }
          }
        } finally {
          pending?.finish()
        }
      }
    }

    /** Redraws every widget of both kinds, for example after the app wrote new data. */
    fun updateAll(context: Context) {
      val manager = AppWidgetManager.getInstance(context)
      for ((provider, kind) in listOf(QuotaWidgetProvider::class.java to WidgetKind.Quota, UsageWidgetProvider::class.java to WidgetKind.Usage)) {
        for (id in manager.getAppWidgetIds(ComponentName(context, provider))) {
          // One widget the launcher refuses must not stop the others from being redrawn.
          try {
            update(context, manager, id, kind)
          } catch (_: Exception) {
            // Drawn again at the next update.
          }
        }
      }
    }

    fun update(context: Context, manager: AppWidgetManager, appWidgetId: Int, kind: WidgetKind) {
      val options = manager.getAppWidgetOptions(appWidgetId)
      val computer = WidgetStore.computerOf(context, appWidgetId)
      if (computer != WidgetStore.AUTO) WidgetStore.recordPin(context, computer)
      val loaded = WidgetStore.loadState(context, computer)
      val arranged = if (kind == WidgetKind.Quota) {
        loaded.arranged(WidgetStore.pinnedOf(context, appWidgetId), WidgetStore.hiddenOf(context, appWidgetId))
      } else {
        null
      }
      val state = arranged?.first ?: loaded
      val pinnedCount = arranged?.second ?: 0
      val now = System.currentTimeMillis()
      // Android 12+ lists every size the launcher may show (portrait / landscape, folded / unfolded): one
      // drawing per size, and the launcher picks. Older systems only give a min/max range of the current
      // orientation, so one drawing for that.
      val sizes = if (Build.VERSION.SDK_INT >= 31) {
        options.getParcelableArrayList<SizeF>(AppWidgetManager.OPTION_APPWIDGET_SIZES)?.filter { it.width > 0 && it.height > 0 }
      } else {
        null
      }
      val views = if (!sizes.isNullOrEmpty()) {
        val distinct = sizes.distinctBy { "${it.width.toInt()}x${it.height.toInt()}" }.take(4)
        RemoteViews(distinct.associateWith { buildViews(context, kind, state, it.width, it.height, distinct.size, now, pinnedCount) })
      } else {
        val landscape = context.resources.configuration.orientation == Configuration.ORIENTATION_LANDSCAPE
        val width = (if (landscape) options.getInt(AppWidgetManager.OPTION_APPWIDGET_MAX_WIDTH) else options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH))
          .takeIf { it > 0 }?.toFloat() ?: 160f
        val height = (if (landscape) options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT) else options.getInt(AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT))
          .takeIf { it > 0 }?.toFloat() ?: 160f
        buildViews(context, kind, state, width, height, 1, now, pinnedCount)
      }
      try {
        manager.updateAppWidget(appWidgetId, views)
      } catch (_: IllegalArgumentException) {
        // Still over the launcher's bitmap memory limit (it counts every size and both themes): one size, smaller.
        val width = sizes?.firstOrNull()?.width ?: 160f
        val height = sizes?.firstOrNull()?.height ?: 160f
        manager.updateAppWidget(appWidgetId, buildViews(context, kind, state, width, height, 4, now, pinnedCount))
      }
    }

    /** One drawing at one size: both themes as bitmaps, kept under the launcher's memory budget for `sharedBy` sizes. */
    private fun buildViews(
      context: Context, kind: WidgetKind, state: WidgetState, width: Float, height: Float, sharedBy: Int, now: Long, pinnedCount: Int,
    ): RemoteViews {
      val metrics = context.resources.displayMetrics
      var density = metrics.density
      // A remote bitmap above the launcher's memory budget is rejected (two per size are sent, one per theme).
      val budget = metrics.widthPixels.toLong() * metrics.heightPixels * 4 * 3 / 2 / (2 * sharedBy)
      // Below 1 px/dp when it has to be: a rejected update leaves the widget stale, a softer picture does not.
      while (width * density * height * density * 4 > budget && density > MIN_DRAW_DENSITY) density *= 0.9f
      val views = RemoteViews(context.packageName, R.layout.cindy_usage_widget)
      val description = describe(context, kind, state)
      for ((dark, id) in listOf(false to R.id.cindy_usage_widget_image, true to R.id.cindy_usage_widget_image_dark)) {
        views.setImageViewBitmap(id, WidgetRenderer.render(context, kind, state, width, height, density, dark, now, pinnedCount = pinnedCount))
        views.setContentDescription(id, description)
      }
      openAppIntent(context)?.let { views.setOnClickPendingIntent(R.id.cindy_usage_widget_root, it) }
      return views
    }

    private fun describe(context: Context, kind: WidgetKind, state: WidgetState): String {
      val format = WidgetFormat(context, state.snapshotOrNull, System.currentTimeMillis())
      val title = format.text(if (kind == WidgetKind.Quota) "quotaName" else "usageName")
      val snapshot = state.snapshotOrNull ?: return title
      return when (kind) {
        WidgetKind.Quota -> title + ": " + snapshot.sources.joinToString(", ") { source ->
          listOfNotNull(source.name, source.value?.let { it + (source.unit ?: "") }).joinToString(" ")
        }
        WidgetKind.Usage -> {
          val today = snapshot.usage.daily.lastOrNull()
          if (today == null) title else "$title: ${format.tokens(today.totalTokens)} ${format.s("tokenUnit")}"
        }
      }
    }

    private fun openAppIntent(context: Context): PendingIntent? {
      val launch = context.packageManager.getLaunchIntentForPackage(context.packageName) ?: return null
      launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED)
      return PendingIntent.getActivity(context, 0, launch, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }
  }
}

class QuotaWidgetProvider : UsageWidgetProviderBase(WidgetKind.Quota)

class UsageWidgetProvider : UsageWidgetProviderBase(WidgetKind.Usage)
