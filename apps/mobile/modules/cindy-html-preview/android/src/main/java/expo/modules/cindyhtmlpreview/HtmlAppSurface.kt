package expo.modules.cindyhtmlpreview

import android.content.Context
import android.view.ViewGroup
import android.view.View.MeasureSpec
import android.widget.FrameLayout
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.views.ExpoView
import java.lang.ref.WeakReference

// Fabric's parent remains AppHost. Moving only a plain native container keeps
// the WebView instance alive when its route-owned slot is removed.
internal object HtmlAppSurfaces {
  val hosts = mutableMapOf<String, WeakReference<HtmlAppHost>>()
  private val slots = mutableListOf<WeakReference<HtmlAppSlot>>()
  fun register(slot: HtmlAppSlot) { slots.add(WeakReference(slot)) }
  fun attach(key: String) {
    slots.removeAll { it.get() == null }
    val host = hosts[key]?.get() ?: return
    val target: ViewGroup = slots.mapNotNull { it.get() }
      .lastOrNull { it.surfaceId == key && it.attached } ?: host
    if (host.content.parent !== target) {
      (host.content.parent as? ViewGroup)?.removeView(host.content)
      target.addView(host.content, ViewGroup.LayoutParams(-1, -1))
    }
    layoutContent(host.content, target.width, target.height)
  }
  fun layoutContent(content: FrameLayout, width: Int, height: Int) {
    content.measure(MeasureSpec.makeMeasureSpec(width, MeasureSpec.EXACTLY),
      MeasureSpec.makeMeasureSpec(height, MeasureSpec.EXACTLY))
    content.layout(0, 0, width, height)
  }
}

class HtmlAppHost(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  val content = FrameLayout(context)
  var surfaceId: String = ""
    set(value) {
      if (field == value) return
      if (HtmlAppSurfaces.hosts[field]?.get() === this) HtmlAppSurfaces.hosts.remove(field)
      field = value
      HtmlAppSurfaces.hosts[value] = WeakReference(this)
      HtmlAppSurfaces.attach(value)
    }
  override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
    if (content.parent === this) HtmlAppSurfaces.layoutContent(content, width, height)
  }
  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    HtmlAppSurfaces.hosts[surfaceId] = WeakReference(this)
    HtmlAppSurfaces.attach(surfaceId)
  }
  override fun onDetachedFromWindow() {
    super.onDetachedFromWindow()
    if (HtmlAppSurfaces.hosts[surfaceId]?.get() === this) HtmlAppSurfaces.hosts.remove(surfaceId)
    (content.parent as? ViewGroup)?.removeView(content)
  }
}

class HtmlAppSlot(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  internal var attached = false
  var surfaceId: String = ""
    set(value) { val previous = field; field = value; HtmlAppSurfaces.attach(previous); HtmlAppSurfaces.attach(value) }
  init { clipChildren = true; HtmlAppSurfaces.register(this) }
  override fun onAttachedToWindow() { super.onAttachedToWindow(); attached = true; HtmlAppSurfaces.attach(surfaceId) }
  override fun onDetachedFromWindow() {
    attached = false
    super.onDetachedFromWindow()
    HtmlAppSurfaces.attach(surfaceId)
  }
  override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
    for (index in 0 until childCount) {
      (getChildAt(index) as? FrameLayout)?.let { HtmlAppSurfaces.layoutContent(it, width, height) }
    }
  }
}
