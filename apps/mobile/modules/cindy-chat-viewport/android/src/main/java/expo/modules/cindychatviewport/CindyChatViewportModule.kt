package expo.modules.cindychatviewport

import android.content.Context
import android.graphics.Rect
import android.os.Build
import android.view.WindowInsets
import android.view.WindowInsetsAnimation
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import android.view.ViewGroup
import android.view.ViewTreeObserver
import android.widget.ScrollView
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.views.ExpoView
import expo.modules.kotlin.viewevent.EventDispatcher
import java.lang.ref.WeakReference
import kotlin.math.abs
import kotlin.math.exp
import kotlin.math.roundToInt

class CindyChatViewportModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("CindyChatViewport")
    Constant("available") { true }
    Constant("manualFollowingAvailable") { true }
    Constant("composerViewportAvailable") { true }
    Constant("keyboardViewportAvailable") { Build.VERSION.SDK_INT >= 30 }
    View(ChatViewport::class) {
      Prop("active") { view: ChatViewport, value: Boolean -> view.active = value }
      Prop("followLatest") { view: ChatViewport, value: Boolean -> view.followLatest = value }
      Prop("reduceMotion") { view: ChatViewport, value: Boolean -> view.reduceMotion = value }
      Prop("durationMs") { view: ChatViewport, value: Double -> view.durationMs = value.coerceAtLeast(1.0) }
      Events("onViewportInsetChange")
      Prop("composerSurfaceId") { view: ChatViewport, value: String -> view.composerSurfaceId = value }
      Prop("composerContentPadding") { view: ChatViewport, value: Double -> view.composerContentPadding = value }
      Prop("autoFollow") { view: ChatViewport, value: Boolean -> view.autoFollow = value }
      AsyncFunction("moveTo") { view: ChatViewport, offset: Double, animate: Boolean, observedInset: Double -> view.moveTo(offset, animate, observedInset) }
      AsyncFunction("cancelFollowing") { view: ChatViewport -> view.cancelFollowing() }
      GroupView<ChatViewport> {
        AddChildView { parent: ChatViewport, child: View, index: Int -> parent.addView(child, index) }
        GetChildCount { parent: ChatViewport -> parent.childCount }
        GetChildViewAt { parent: ChatViewport, index: Int -> parent.getChildAt(index) }
        RemoveChildViewAt { parent: ChatViewport, index: Int -> parent.removeViewAt(index) }
        RemoveChildView { parent: ChatViewport, child: View -> parent.removeView(child) }
      }
    }
    View(ComposerAnchor::class) {
      Name("ComposerAnchor")
      Prop("surfaceId") { view: ComposerAnchor, value: String -> view.surfaceId = value }
      Prop("followKeyboard") { view: ComposerAnchor, value: Boolean -> view.followKeyboard = value }
      GroupView<ComposerAnchor> {
        AddChildView { parent: ComposerAnchor, child: View, index: Int -> parent.addView(child, index) }
        GetChildCount { parent: ComposerAnchor -> parent.childCount }
        GetChildViewAt { parent: ComposerAnchor, index: Int -> parent.getChildAt(index) }
        RemoveChildViewAt { parent: ComposerAnchor, index: Int -> parent.removeViewAt(index) }
        RemoveChildView { parent: ComposerAnchor, child: View -> parent.removeView(child) }
      }
    }
  }
}

private val composerAnchors = mutableMapOf<String, WeakReference<ComposerAnchor>>()
class ComposerAnchor(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  private var keyboardAnimating = false
  var followKeyboard = false
    set(value) {
      field = value
      if (!value) translationY = 0f else rootWindowInsets?.let(::applyKeyboard)
    }
  private fun applyKeyboard(insets: WindowInsets) {
    if (followKeyboard && Build.VERSION.SDK_INT >= 30) {
      translationY = -insets.getInsets(WindowInsets.Type.ime()).bottom.toFloat()
    }
  }
  init {
    if (Build.VERSION.SDK_INT >= 30) {
      // KAV receives Android's didShow event only after the IME has moved. Keep
      // this surface's layout intact and follow the OS's actual animation frames.
      setWindowInsetsAnimationCallback(object : WindowInsetsAnimation.Callback(DISPATCH_MODE_CONTINUE_ON_SUBTREE) {
        override fun onPrepare(animation: WindowInsetsAnimation) {
          if (animation.typeMask and WindowInsets.Type.ime() != 0) keyboardAnimating = true
        }
        override fun onProgress(insets: WindowInsets, animations: MutableList<WindowInsetsAnimation>): WindowInsets {
          applyKeyboard(insets)
          return insets
        }
        override fun onEnd(animation: WindowInsetsAnimation) {
          if (animation.typeMask and WindowInsets.Type.ime() != 0) {
            keyboardAnimating = false
            rootWindowInsets?.let(::applyKeyboard)
          }
        }
      })
      setOnApplyWindowInsetsListener { _, insets ->
        if (!keyboardAnimating) applyKeyboard(insets)
        insets
      }
    }
  }
  var surfaceId = ""
    set(value) {
      if (composerAnchors[field]?.get() === this) composerAnchors.remove(field)
      field = value
      if (isAttachedToWindow && value.isNotEmpty()) composerAnchors[value] = WeakReference(this)
    }
  override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) = Unit
  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    if (surfaceId.isNotEmpty()) composerAnchors[surfaceId] = WeakReference(this)
    requestApplyInsets()
  }
  override fun onDetachedFromWindow() {
    if (composerAnchors[surfaceId]?.get() === this) composerAnchors.remove(surfaceId)
    super.onDetachedFromWindow()
  }
}

/** One Android draw owns both viewport compensation and following new content.
 * JS layout events arrive after layout has already moved the viewport. Scrolling
 * from that callback exposes one frame of movement followed by a corrective jump.
 * This view leaves Yoga/IME layout intact and adjusts the native offset before draw.
 */
class ChatViewport(context: Context, appContext: AppContext) : ExpoView(context, appContext), ViewTreeObserver.OnPreDrawListener {
  val onViewportInsetChange by EventDispatcher()
  var composerSurfaceId = ""
  var composerContentPadding = 0.0
  private var managedInset = 0
  private val listLocation = IntArray(2)
  private val composerLocation = IntArray(2)
  var active = false
    set(value) { field = value; invalidate() }
  var followLatest = true
    set(value) {
      field = value
      dragging = false
      position = scroll?.get()?.scrollY?.toDouble() ?: position
      velocity = 0.0
      lastFrame = 0L
      invalidate()
    }
  var reduceMotion = true
  var durationMs = 200.0
  var autoFollow = true
  private var requestedEnd: Double? = null
  private var scroll: WeakReference<ScrollView>? = null
  private var previousHeight = 0
  private var previousOffset = 0
  private var positioned = false
  private var position = 0.0
  private var velocity = 0.0
  private var lastFrame = 0L
  private var touching = false
  private var dragging = false
  private var downY = 0f
  private val touchSlop = ViewConfiguration.get(context).scaledTouchSlop

  // Virtualized lists keep their existing target/restore policy in JS. Only the
  // trajectory and viewport delta move here; do not chase estimated content size.
  fun moveTo(offset: Double, animate: Boolean, observedInset: Double) {
    if (!offset.isFinite()) return
    // A fresh JS command is issued only after its drag/momentum policy yields.
    // Dragging down at the end need not toggle followLatest, so do not leave
    // that native gesture latch set forever after the finger is lifted.
    if (!touching && followLatest) dragging = false
    val target = scroll?.get() ?: findScroll(this) ?: return
    val pixels = ((offset - observedInset) * resources.displayMetrics.density + managedInset).coerceAtLeast(0.0)
    if (requestedEnd == null) position = target.scrollY.toDouble()
    requestedEnd = pixels
    if (android.util.Log.isLoggable("CindyMotion", android.util.Log.DEBUG)) android.util.Log.d("CindyMotion", "move target=$pixels inset=$managedInset observed=$observedInset animate=$animate offset=${target.scrollY}")
    if (!animate || reduceMotion) {
      target.scrollTo(target.scrollX, pixels.roundToInt())
      position = target.scrollY.toDouble()
      previousOffset = target.scrollY
      velocity = 0.0
      lastFrame = 0L
    }
    invalidate()
  }

  fun cancelFollowing() {
    requestedEnd = null
    velocity = 0.0
    lastFrame = 0L
  }

  // React Native lays out these children through Yoga, not LinearLayout.
  override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) = Unit

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    viewTreeObserver.addOnPreDrawListener(this)
  }

  override fun onDetachedFromWindow() {
    if (viewTreeObserver.isAlive) viewTreeObserver.removeOnPreDrawListener(this)
    scroll = null
    positioned = false
    lastFrame = 0L
    super.onDetachedFromWindow()
  }

  override fun dispatchTouchEvent(event: MotionEvent): Boolean {
    when (event.actionMasked) {
      MotionEvent.ACTION_DOWN -> {
        val bounds = Rect()
        touching = scroll?.get()?.getGlobalVisibleRect(bounds) == true && bounds.contains(event.rawX.toInt(), event.rawY.toInt())
        downY = event.rawY
        if (touching) { velocity = 0.0; lastFrame = 0L }
      }
      MotionEvent.ACTION_MOVE -> if (touching && abs(event.rawY - downY) > touchSlop) dragging = true
      MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> { touching = false; invalidate() }
    }
    return super.dispatchTouchEvent(event)
  }

  private fun findScroll(view: View): ScrollView? {
    if (view is ScrollView) return view
    if (view is ViewGroup) for (index in 0 until view.childCount) findScroll(view.getChildAt(index))?.let { return it }
    return null
  }

  override fun onPreDraw(): Boolean {
    val target = scroll?.get()?.takeIf { it.isAttachedToWindow } ?: findScroll(this)?.also {
      scroll = WeakReference(it)
      positioned = false
    } ?: return true
    // The actual dock position is available in this draw, before delayed JS
    // onLayout callbacks. Reserve it here instead of resizing virtual content.
    val anchor = composerAnchors[composerSurfaceId]?.get()?.takeIf { it.isAttachedToWindow && it.rootView === rootView }
    val nextInset = if (anchor != null) {
      target.getLocationInWindow(listLocation)
      anchor.getLocationInWindow(composerLocation)
      (listLocation[1] + target.height - composerLocation[1] - composerContentPadding * resources.displayMetrics.density).roundToInt().coerceIn(0, target.height)
    } else 0
    val insetChanged = nextInset != managedInset
    val offsetBefore = target.scrollY
    if (insetChanged) {
      val base = target.paddingBottom - managedInset
      managedInset = nextInset
      target.setPadding(target.paddingLeft, target.paddingTop, target.paddingRight, base + managedInset)
    }
    val height = target.height - target.paddingTop - target.paddingBottom
    val contentHeight = target.getChildAt(0)?.height ?: 0
    if (height <= 0 || contentHeight <= 0) return true
    val rangeEnd = (contentHeight - height).coerceAtLeast(0).toDouble()
    if (positioned && height != previousHeight && requestedEnd != null && active && followLatest && !touching && !dragging) {
      requestedEnd = (requestedEnd!! + previousHeight - height).coerceAtLeast(0.0)
    }
    val end = (if (autoFollow) rangeEnd else requestedEnd ?: target.scrollY.toDouble()).coerceIn(0.0, rangeEnd)
    if (!active || !followLatest || touching || dragging) {
      position = target.scrollY.toDouble()
      velocity = 0.0
      lastFrame = 0L
    } else {
      if (!positioned) {
        // Restored history has a destination, not a new-message entrance.
        position = if (autoFollow) end else target.scrollY.toDouble()
        positioned = true
      } else if (height != previousHeight) {
        // Android may already have clamped scrollY after resizing. Use the prior
        // draw's offset once, so the native clamp is never counted a second time.
        position = (previousOffset + previousHeight - height).toDouble().coerceIn(0.0, rangeEnd)
      }
      val now = System.nanoTime()
      val refreshRate = display?.refreshRate?.takeIf { it > 0 } ?: 60f
      val dt = if (lastFrame == 0L) 1.0 / refreshRate else ((now - lastFrame) / 1e9).coerceIn(0.0, 0.032)
      if (reduceMotion) {
        position = end
        velocity = 0.0
      } else {
        // Analytic critically damped spring; retargeting preserves velocity.
        val omega = 8.0 / (durationMs / 1000.0)
        val displacement = position - end
        val step = velocity + omega * displacement
        val decay = exp(-omega * dt)
        position = (end + (displacement + step * dt) * decay).coerceIn(0.0, rangeEnd)
        velocity = (velocity - omega * step * dt) * decay
        if (abs(end - position) < 0.5 && abs(velocity) < 1.0) { position = end; velocity = 0.0 }
      }
      target.scrollTo(target.scrollX, position.roundToInt())
      if (abs(end - position) >= 0.5 || abs(velocity) >= 1.0) {
        lastFrame = now
        postInvalidateOnAnimation()
      } else lastFrame = 0L
    }
    if (android.util.Log.isLoggable("CindyMotion", android.util.Log.DEBUG) && (insetChanged || height != previousHeight)) android.util.Log.d("CindyMotion", "frame height=$height priorHeight=$previousHeight content=$contentHeight before=$offsetBefore after=${target.scrollY} priorOffset=$previousOffset inset=$managedInset end=$end position=$position active=$active follow=$followLatest")
    previousHeight = height
    previousOffset = target.scrollY
    if (insetChanged) {
      val density = resources.displayMetrics.density
      onViewportInsetChange(mapOf("bottom" to managedInset / density, "offsetY" to target.scrollY / density,
        "viewportHeight" to height / density, "contentHeight" to contentHeight / density))
    }
    return true
  }
}
