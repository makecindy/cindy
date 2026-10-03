package expo.modules.cindyquotawidget

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.res.Configuration
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.PorterDuff
import android.graphics.PorterDuffColorFilter
import android.graphics.RectF
import android.net.Uri
import android.os.Bundle
import android.text.SpannableString
import android.text.Spanned
import android.text.style.AbsoluteSizeSpan
import android.text.style.ForegroundColorSpan
import android.text.style.TypefaceSpan
import android.view.View
import android.util.TypedValue
import android.widget.RemoteViews
import org.json.JSONObject
import kotlin.math.ceil

class QuotaWidgetProvider : AppWidgetProvider() {
  override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) { ids.forEach { update(context, manager, it) } }
  override fun onAppWidgetOptionsChanged(context: Context, manager: AppWidgetManager, id: Int, options: Bundle) { update(context, manager, id) }
  companion object {
    fun updateAll(context: Context) {
      val manager = AppWidgetManager.getInstance(context)
      manager.getAppWidgetIds(ComponentName(context, QuotaWidgetProvider::class.java)).forEach { update(context, manager, it) }
    }
    private fun update(context: Context, manager: AppWidgetManager, id: Int) {
      val prefs = context.getSharedPreferences("cindy-quota-presentation", 0)
      val config = Configuration(context.resources.configuration)
      val mode = prefs.getString("appearance", "system")
      if (mode != "system") config.uiMode = (config.uiMode and Configuration.UI_MODE_NIGHT_MASK.inv()) or
        (if (mode == "dark") Configuration.UI_MODE_NIGHT_YES else Configuration.UI_MODE_NIGHT_NO)
      val themed = context.createConfigurationContext(config)
      val dark = (config.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES
      val snapshot = QuotaSnapshot.load(context)
      val rows = snapshot.getJSONArray("rows")
      val views = RemoteViews(context.packageName, R.layout.cindy_quota_widget)
      val options = manager.getAppWidgetOptions(id)
      val landscape = config.orientation == Configuration.ORIENTATION_LANDSCAPE
      val width = options.getInt(if (landscape) AppWidgetManager.OPTION_APPWIDGET_MAX_WIDTH else AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, 250)
      val height = options.getInt(if (landscape) AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT else AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT, 200)
      val layout = QuotaWidgetPresentation.layout(width, height, config.fontScale, rows.length())
      val wide = layout.columns == 2
      val count = layout.count
      val needsSpace = layout.needsSpace
      views.setInt(R.id.quota_root, "setBackgroundResource", if (dark) R.drawable.cindy_quota_background_dark else R.drawable.cindy_quota_background_light)
      views.setTextViewText(R.id.quota_heading, if (needsSpace) "Enlarge widget" else if (count < rows.length()) "Enlarge for all" else "")
      views.setTextColor(R.id.quota_heading, themed.getColor(R.color.cindy_widget_widget_secondary))
      views.setViewVisibility(R.id.quota_heading, if (needsSpace || layout.showMoreHint) View.VISIBLE else View.GONE)
      for (container in listOf(R.id.quota_column_0, R.id.quota_column_1, R.id.quota_bottom)) views.removeAllViews(container)
      views.setViewVisibility(R.id.quota_column_1, if (wide && count > 1) View.VISIBLE else View.GONE)
      val now = System.currentTimeMillis()
      for (index in 0 until count) {
        val row = if (rows.length() == 0) null else rows.getJSONObject(index)
        val destination = if (index == 0) R.id.quota_column_0 else if (index == 1 && wide) R.id.quota_column_1 else R.id.quota_bottom
        views.addView(destination, provider(themed, row, snapshot.getString("connection"), now))
      }
      val launch = context.packageManager.getLaunchIntentForPackage(context.packageName)
      val info = context.packageManager.getApplicationInfo(context.packageName, android.content.pm.PackageManager.GET_META_DATA)
      val scheme = info.metaData?.getString("cindy.quota.scheme")
      if (launch != null && scheme != null) {
        launch.action = Intent.ACTION_VIEW
        launch.data = Uri.parse("$scheme://subscription-widgets")
        launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        views.setOnClickPendingIntent(R.id.quota_root, PendingIntent.getActivity(context, id, launch, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE))
      }
      manager.updateAppWidget(id, views)
    }
    private fun provider(context: Context, row: JSONObject?, connection: String, now: Long): RemoteViews {
      val v = RemoteViews(context.packageName, R.layout.cindy_quota_provider)
      val secondary = context.getColor(R.color.cindy_widget_widget_secondary)
      val colors = listOf(R.color.cindy_widget_quota_weekly, R.color.cindy_widget_quota_session, R.color.cindy_widget_quota_scoped).map(context::getColor)
      val platform = row?.optString("platform") ?: ""
      val name = mapOf("claude" to "Claude", "codex" to "Codex", "xai" to "Grok")[platform] ?: "Cindy"
      val windows = row?.let(QuotaWidgetPresentation::windows) ?: emptyList()
      val week = windows.firstOrNull { QuotaWidgetPresentation.slot(it) == 0 }
      val session = windows.firstOrNull { QuotaWidgetPresentation.slot(it) == 1 }
      val scoped = windows.firstOrNull { QuotaWidgetPresentation.slot(it) == 2 }
      v.setTextViewText(R.id.provider_name, name)
      v.setTextViewText(R.id.provider_plan, row?.optString("plan")?.takeUnless { it == "null" || it.isBlank() } ?: " ")
      for (id in listOf(R.id.provider_name, R.id.provider_plan, R.id.provider_secondary, R.id.provider_tertiary)) v.setTextColor(id, secondary)
      val density = context.resources.displayMetrics.density
      // Reserve three brand/plan text lines equally in both columns, including
      // Android font rounding. A two-line plan must not move one quota baseline.
      v.setInt(R.id.provider_header, "setMinimumHeight", ceil(
        QuotaWidgetPresentation.HEADER_HEIGHT_DP * context.resources.configuration.fontScale.coerceAtLeast(1f) * density
      ).toInt())
      fun sp(size: Float) = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_SP, size, context.resources.displayMetrics).toInt()
      fun quota(window: JSONObject, primary: Boolean): CharSequence {
        val value = QuotaWidgetPresentation.value(row!!, window, connection, now)
        val label = if (primary) "" else " " + QuotaWidgetPresentation.label(window)
        val detail = if (window.optString("kind") == "scoped" && QuotaSnapshot.state(row,window,connection,now) == "fresh") "" else " " + QuotaWidgetPresentation.detail(row,window,connection,now)
        val s = SpannableString(value + label + detail)
        s.setSpan(ForegroundColorSpan(colors[QuotaWidgetPresentation.slot(window)]),0,value.length+label.length,Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        if (detail.isNotEmpty()) s.setSpan(ForegroundColorSpan(secondary),value.length+label.length,s.length,Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        s.setSpan(AbsoluteSizeSpan(sp(if(primary) QuotaWidgetMetrics.VALUE else QuotaWidgetMetrics.DETAIL)),0,value.length,Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        if (s.length > value.length) {
          s.setSpan(AbsoluteSizeSpan(sp(QuotaWidgetMetrics.DETAIL)),value.length,s.length,Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
          s.setSpan(TypefaceSpan("sans-serif"),value.length,s.length,Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        }
        return s
      }
      v.setTextColor(R.id.provider_primary, secondary)
      v.setTextViewText(R.id.provider_primary, week?.let { quota(it,true) } ?: "—")
      v.setTextViewText(R.id.provider_secondary, when { windows.isEmpty() -> QuotaWidgetPresentation.empty(row); platform=="claude" -> session?.let { quota(it,false) } ?: ""; week!=null -> "Weekly"; else -> "" })
      if(platform=="codex" && week!=null) v.setTextColor(R.id.provider_secondary,colors[1])
      v.setTextViewText(R.id.provider_tertiary, when(platform) { "claude" -> scoped?.let { quota(it,false) } ?: ""; "codex" -> "Extra resets: " + QuotaWidgetPresentation.extra(row,connection,now); else -> "" })
      val size = (QuotaWidgetMetrics.RING*density).toInt().coerceAtLeast(1)
      val bitmap=Bitmap.createBitmap(size,size,Bitmap.Config.ARGB_8888)
      val canvas=Canvas(bitmap); canvas.scale(density,density)
      val paint=Paint(Paint.ANTI_ALIAS_FLAG).apply { style=Paint.Style.STROKE;strokeWidth=QuotaWidgetMetrics.STROKE;strokeCap=Paint.Cap.ROUND }
      for(w in windows) {
        val slot=QuotaWidgetPresentation.slot(w); val r=listOf(18.75f,13.1f,7.45f)[slot]
        paint.color=colors[slot];paint.alpha=43;canvas.drawCircle(21f,21f,r,paint)
        if(row!=null && QuotaSnapshot.state(row,w,connection,now)=="fresh") {
          paint.alpha=255;val percentage=w.getDouble("remainingPercent").toFloat()
          if(percentage>0)canvas.drawArc(RectF(21-r,21-r,21+r,21+r),-90f,360*percentage/100,false,paint)
        }
      }
      v.setImageViewBitmap(R.id.provider_rings,bitmap)
      val iconId=mapOf("claude" to R.drawable.cindy_quota_claude,"codex" to R.drawable.cindy_quota_codex,"xai" to R.drawable.cindy_quota_xai)[platform]
      v.setViewVisibility(R.id.provider_icon,if(iconId==null)View.GONE else View.VISIBLE)
      if(iconId!=null) {
        val iconSize=(14*density).toInt().coerceAtLeast(1);val icon=Bitmap.createBitmap(iconSize,iconSize,Bitmap.Config.ARGB_8888)
        context.getDrawable(iconId)!!.mutate().apply { setBounds(0,0,iconSize,iconSize);colorFilter=PorterDuffColorFilter(secondary,PorterDuff.Mode.SRC_IN);draw(Canvas(icon)) }
        v.setImageViewBitmap(R.id.provider_icon,icon)
      }
      return v
    }
  }
}
