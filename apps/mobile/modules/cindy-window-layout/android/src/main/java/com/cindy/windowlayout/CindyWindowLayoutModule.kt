package com.cindy.windowlayout

import android.content.Context
import android.util.Log
import android.view.ViewTreeObserver
import androidx.window.layout.FoldingFeature
import androidx.window.layout.WindowInfoTracker
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.launch

class CindyWindowLayoutModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("CindyWindowLayout")
    Constant("windowLayoutAvailable") { true }
    View(CindyWindowLayoutView::class) {
      Events("onGeometryChange")
    }
  }
}

/** One transparent probe per React window, matching the iOS geometry contract. */
class CindyWindowLayoutView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  private val onGeometryChange by EventDispatcher()
  private var scope: CoroutineScope? = null
  private var folds: List<FoldingFeature> = emptyList()
  private var lastGeometry: Map<String, Any>? = null
  private val layoutListener = ViewTreeObserver.OnGlobalLayoutListener { publishGeometry() }

  init {
    importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
    isClickable = false
    isFocusable = false
    // React's hit test ignores the JS pointerEvents prop on ExpoView, so this
    // full-window probe would capture every touch. It treats a disabled view
    // as box-none, and the probe has no children to receive touches.
    isEnabled = false
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    lastGeometry = null
    viewTreeObserver.addOnGlobalLayoutListener(layoutListener)
    val activity = appContext.currentActivity ?: return
    scope = CoroutineScope(Job() + Dispatchers.Main.immediate).also { observer ->
      observer.launch {
        WindowInfoTracker.getOrCreate(context).windowLayoutInfo(activity)
          .catch { error ->
            Log.w("CindyWindowLayout", "Fold observation unavailable", error)
            folds = emptyList()
            publishGeometry()
          }
          .collect { info ->
            // Flat continuous displays have a crease but no logical division.
            // Physical hinges remain separating even when opened flat.
            folds = info.displayFeatures.filterIsInstance<FoldingFeature>().filter { it.isSeparating }
            publishGeometry()
          }
      }
    }
  }

  override fun onDetachedFromWindow() {
    viewTreeObserver.removeOnGlobalLayoutListener(layoutListener)
    scope?.cancel()
    scope = null
    folds = emptyList()
    lastGeometry = null
    super.onDetachedFromWindow()
  }

  private fun publishGeometry() {
    if (!isAttachedToWindow || width <= 0 || height <= 0) return
    val density = resources.displayMetrics.density
    val origin = IntArray(2)
    getLocationInWindow(origin)
    val regions = folds.map { fold ->
      val bounds = fold.bounds
      // WindowManager uses window-relative physical pixels; RN uses local dp.
      // Do not Rect.intersect/isEmpty: zero-thickness folds are valid separators.
      mapOf(
        "kind" to "division",
        "x" to (bounds.left - origin[0]) / density,
        "y" to (bounds.top - origin[1]) / density,
        "width" to bounds.width() / density,
        "height" to bounds.height() / density,
      )
    }
    val geometry: Map<String, Any> = mapOf(
      "width" to width / density,
      "height" to height / density,
      "regions" to regions,
      "reservedRegionsSupported" to true,
    )
    if (geometry == lastGeometry) return
    lastGeometry = geometry
    onGeometryChange(geometry)
  }
}
