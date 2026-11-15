package com.cindy.handheld

import android.app.Activity
import android.app.ActivityOptions
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.graphics.Rect
import android.graphics.drawable.GradientDrawable
import android.hardware.display.DisplayManager
import android.hardware.input.InputManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.DisplayMetrics
import android.util.Log
import android.view.Choreographer
import android.view.Display
import android.view.InputDevice
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.ViewTreeObserver
import android.view.Window
import android.widget.ScrollView
import com.facebook.react.uimanager.util.ReactFindViewUtil
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.lang.ref.WeakReference
import java.util.WeakHashMap
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min

private const val TAG = "CindyHandheld"
private const val DEFAULT_HOLD_MS = 350
private const val STICK_DEAD_ZONE = 0.18f
private const val STICK_MAX_DP_PER_SECOND = 1600f
private const val SCROLL_TARGET_TTL_MS = 400L
private const val MIN_FOCUS_TARGET_DP = 8f
private const val MIN_SCROLL_TARGET_DP = 120f
private const val MAX_SKIPPED_FOCUSABLES = 64
private val NAVIGATION_KEYS = setOf(
  KeyEvent.KEYCODE_DPAD_UP,
  KeyEvent.KEYCODE_DPAD_DOWN,
  KeyEvent.KEYCODE_DPAD_LEFT,
  KeyEvent.KEYCODE_DPAD_RIGHT,
  KeyEvent.KEYCODE_DPAD_CENTER,
  KeyEvent.KEYCODE_ENTER,
  KeyEvent.KEYCODE_BUTTON_A,
)

/**
 * Handheld (gamepad) mode for Android game handhelds.
 *
 * The module wraps the activity window callback so it sees hardware keys before
 * React Native and the composer WebView: the configured voice key becomes a
 * hold-to-talk button, L1/R1 page the visible list and the right stick scrolls it.
 * The focused task also accepts trigger + D-pad scrolling and a scoped Start
 * receipt, with the configured voice key taking priority over both shortcuts.
 * D-pad/left-stick focus movement, A (confirm) and B (back) stay with Android's
 * own focus navigation and gamepad fallback keys; a focus ring makes the
 * focused control visible. Everything passes through untouched while disabled.
 */
class CindyHandheldModule : Module() {
  private val main = Handler(Looper.getMainLooper())
  private var enabled = false
  private var voiceKeyCode = KeyEvent.KEYCODE_BUTTON_X
  private var holdMs = DEFAULT_HOLD_MS.toLong()
  private var focusColor = Color.parseColor("#F70121")
  private var capturing = false
  private var swallowKeyCode = KeyEvent.KEYCODE_UNKNOWN
  private var voiceDown = false
  private var voiceActive = false
  private var lastNavDirection = View.FOCUS_DOWN
  private var gamepadPresent = false
  private var sessionScope: String? = null
  private var sessionSendTarget: String? = null
  private var inputManager: InputManager? = null
  private val controllers = mutableMapOf<Int, ControllerState>()
  private val wrappedWindows = WeakHashMap<Window, HandheldWindowCallback>()
  private var ring: FocusRing? = null
  private val scroller = StickScroller()

  private class ControllerState {
    var l2Key = false
    var r2Key = false
    var l2Axis = false
    var r2Axis = false
    var hatY = 0f
    var startDown = false
    val scrollKeys = mutableSetOf<Int>()
    val l2 get() = l2Key || l2Axis
    val r2 get() = r2Key || r2Axis
  }

  private val inputListener = object : InputManager.InputDeviceListener {
    override fun onInputDeviceAdded(deviceId: Int) { gamepadPresent = gamepadNames().isNotEmpty() }
    override fun onInputDeviceChanged(deviceId: Int) { resetInput(); gamepadPresent = gamepadNames().isNotEmpty() }
    override fun onInputDeviceRemoved(deviceId: Int) { resetInput(); gamepadPresent = gamepadNames().isNotEmpty() }
  }

  private val holdRunnable = Runnable {
    if (!voiceDown || voiceActive) return@Runnable
    voiceActive = true
    sendEvent("onVoiceKey", mapOf("phase" to "start"))
  }

  override fun definition() = ModuleDefinition {
    Name("CindyHandheld")
    Constant("available") { true }
    Events("onVoiceKey", "onKeyCaptured", "onSessionSend")

    // Plain map like the other local modules: Record conversion does not survive R8 here.
    AsyncFunction("configure") { config: Map<String, Any?> ->
      val nextVoiceKeyCode = (config["voiceKeyCode"] as? Number)?.toInt() ?: KeyEvent.KEYCODE_BUTTON_X
      if (nextVoiceKeyCode != voiceKeyCode) resetInput()
      voiceKeyCode = nextVoiceKeyCode
      val requestedHoldMs = (config["holdMs"] as? Number)?.toInt() ?: DEFAULT_HOLD_MS
      holdMs = min(max(requestedHoldMs, 150), 2000).toLong()
      (config["focusColor"] as? String)?.let { value -> runCatching { Color.parseColor(value) }.getOrNull()?.let { focusColor = it } }
      val wasEnabled = enabled
      enabled = config["enabled"] == true
      if (enabled) {
        install()
      } else if (wasEnabled) {
        resetInput()
        capturing = false
        if (!gamepadPresent) ring?.restoreAll()
      }
      ring?.setColor(focusColor)
      ring?.refresh()
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("setCapturing") { value: Boolean ->
      resetInput()
      capturing = value && enabled
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("setSessionControls") { config: Map<String, String>? ->
      if (sessionScope != config?.get("scope")) resetInput()
      sessionScope = config?.get("scope")
      sessionSendTarget = config?.get("sendTarget")
    }.runOnQueue(Queues.MAIN)

    Function("getDisplays") {
      val context = appContext.reactContext ?: return@Function emptyList<Map<String, Any>>()
      val manager = context.getSystemService(Context.DISPLAY_SERVICE) as DisplayManager
      val current = appContext.currentActivity?.let { displayIdOf(it) } ?: Display.DEFAULT_DISPLAY
      manager.displays.map { display ->
        val metrics = DisplayMetrics()
        @Suppress("DEPRECATION")
        display.getRealMetrics(metrics)
        mapOf(
          "id" to display.displayId,
          "name" to (display.name ?: ""),
          "width" to metrics.widthPixels,
          "height" to metrics.heightPixels,
          "density" to metrics.density,
          "isDefault" to (display.displayId == Display.DEFAULT_DISPLAY),
          "isCurrent" to (display.displayId == current),
          "isPresentation" to ((display.flags and Display.FLAG_PRESENTATION) != 0),
        )
      }
    }

    AsyncFunction("getCurrentDisplayId") {
      appContext.currentActivity?.let { displayIdOf(it) } ?: Display.DEFAULT_DISPLAY
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("moveToDisplay") { displayId: Int ->
      moveToDisplay(displayId)
    }.runOnQueue(Queues.MAIN)

    Function("getGamepads") { gamepadNames() }

    OnActivityEntersForeground {
      main.post {
        gamepadPresent = gamepadNames().isNotEmpty()
        if (enabled) install() else if (gamepadPresent) installFocusAssist()
      }
    }

    OnActivityEntersBackground {
      main.post {
        resetInput()
      }
    }

    OnActivityDestroys {
      main.post {
        resetInput()
        val activity = appContext.currentActivity
        if (ring?.isFor(activity) != true) {
          ring?.detach()
          ring = null
        }
      }
    }

    OnDestroy {
      main.removeCallbacksAndMessages(null)
      if (Looper.myLooper() == main.looper) uninstall() else main.post { uninstall() }
    }
  }

  private fun uninstall() {
    enabled = false
    capturing = false
    voiceDown = false
    voiceActive = false
    scroller.stop()
    controllers.clear()
    sessionScope = null
    sessionSendTarget = null
    inputManager?.unregisterInputDeviceListener(inputListener)
    inputManager = null
    ring?.detach()
    ring = null
    for ((window, callback) in wrappedWindows) {
      if (window.callback === callback) window.callback = callback.base
    }
    wrappedWindows.clear()
  }

  private fun install() {
    val activity = appContext.currentActivity ?: return
    val window = activity.window ?: return
    if (inputManager == null) {
      inputManager = activity.getSystemService(Context.INPUT_SERVICE) as InputManager
      inputManager?.registerInputDeviceListener(inputListener, main)
    }
    if (!wrappedWindows.containsKey(window)) {
      val base = window.callback
      if (base != null) {
        val callback = HandheldWindowCallback(base)
        window.callback = callback
        wrappedWindows[window] = callback
      }
    }
    installFocusAssist()
  }

  /**
   * Focus listener only (no key interception, no ring while disabled), so a
   * controller can already reach the settings toggle before handheld mode is on.
   */
  private fun installFocusAssist() {
    val activity = appContext.currentActivity ?: return
    if (ring?.isFor(activity) != true) {
      ring?.detach()
      ring = FocusRing(activity).also { it.attach() }
    }
  }

  private fun gamepadNames(): List<String> =
    InputDevice.getDeviceIds().toList().mapNotNull { id ->
      val device = InputDevice.getDevice(id) ?: return@mapNotNull null
      val sources = device.sources
      val gamepad = (sources and InputDevice.SOURCE_GAMEPAD) == InputDevice.SOURCE_GAMEPAD ||
        (sources and InputDevice.SOURCE_JOYSTICK) == InputDevice.SOURCE_JOYSTICK
      if (gamepad && !device.isVirtual) device.name else null
    }.distinct()

  /** Skipping hidden focus targets helps any controller user, not only in handheld mode. */
  private fun focusAssistActive(): Boolean = enabled || gamepadPresent

  private fun displayIdOf(activity: Activity): Int {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      return activity.display?.displayId ?: Display.DEFAULT_DISPLAY
    }
    @Suppress("DEPRECATION")
    return activity.windowManager.defaultDisplay.displayId
  }

  private fun moveToDisplay(displayId: Int): Boolean {
    val activity = appContext.currentActivity ?: return false
    if (displayIdOf(activity) == displayId) return true
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return false
    val manager = activity.getSystemService(Context.DISPLAY_SERVICE) as DisplayManager
    if (manager.getDisplay(displayId) == null) return false
    // MainActivity is singleTask: relaunching its task with a launch display
    // makes the system reparent the existing task (and its React root) there.
    val intent = Intent(activity, activity.javaClass).apply {
      action = Intent.ACTION_MAIN
      addCategory(Intent.CATEGORY_LAUNCHER)
      addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    }
    val options = ActivityOptions.makeBasic().setLaunchDisplayId(displayId)
    return try {
      activity.startActivity(intent, options.toBundle())
      true
    } catch (error: Exception) {
      Log.w(TAG, "Unable to move to display $displayId", error)
      false
    }
  }

  private fun handleKey(event: KeyEvent): Boolean {
    if (!enabled) return false
    val code = event.keyCode
    if (code == swallowKeyCode) {
      if (event.action == KeyEvent.ACTION_UP) swallowKeyCode = KeyEvent.KEYCODE_UNKNOWN
      return true
    }
    if (capturing && event.action == KeyEvent.ACTION_DOWN && KeyEvent.isGamepadButton(code)) {
      capturing = false
      swallowKeyCode = code
      sendEvent("onKeyCaptured", mapOf("keyCode" to code, "name" to KeyEvent.keyCodeToString(code)))
      return true
    }
    if (code == KeyEvent.KEYCODE_BUTTON_L2 || code == KeyEvent.KEYCODE_BUTTON_R2) {
      val state = controllers.getOrPut(event.deviceId) { ControllerState() }
      if (event.action == KeyEvent.ACTION_UP || (event.action == KeyEvent.ACTION_DOWN && event.repeatCount == 0)) {
        val down = event.action == KeyEvent.ACTION_DOWN
        if (code == KeyEvent.KEYCODE_BUTTON_L2) state.l2Key = down else state.r2Key = down
      }
      updateTriggerVoice()
      updateDpadScroll()
      return code == voiceKeyCode || sessionScope != null
    }
    if (code == voiceKeyCode) {
      handleVoiceKey(event)
      return true
    }
    if (sessionScope != null && code == KeyEvent.KEYCODE_BUTTON_START) {
      val state = controllers.getOrPut(event.deviceId) { ControllerState() }
      if (event.action == KeyEvent.ACTION_UP) state.startDown = false
      if (event.action == KeyEvent.ACTION_DOWN && event.repeatCount == 0 && !state.startDown) {
        state.startDown = true
        val decor = appContext.currentActivity?.window?.decorView
        val target = sessionSendTarget?.let { id -> decor?.let { ReactFindViewUtil.findView(it, id) } }
        if (decor != null && decor.hasWindowFocus() && target != null &&
          isVisiblyAttached(target) && !isCovered(target, decor)) {
          sendEvent("onSessionSend", mapOf("scope" to sessionScope))
        }
      }
      // Never let Android turn Start into another focused action (or stop).
      return true
    }
    if (sessionScope != null && (code == KeyEvent.KEYCODE_DPAD_UP || code == KeyEvent.KEYCODE_DPAD_DOWN)) {
      val state = controllers.getOrPut(event.deviceId) { ControllerState() }
      if (event.action == KeyEvent.ACTION_UP && state.scrollKeys.remove(code)) {
        updateDpadScroll()
        return true
      }
      val leftStickFallback = (event.flags and KeyEvent.FLAG_FALLBACK) != 0 &&
        event.isFromSource(InputDevice.SOURCE_JOYSTICK) && state.hatY == 0f
      if (event.action == KeyEvent.ACTION_DOWN && !leftStickFallback && scrollModifier(state)) {
        state.scrollKeys.add(code)
        updateDpadScroll()
        return true
      }
    }
    if (code == KeyEvent.KEYCODE_BUTTON_L1 || code == KeyEvent.KEYCODE_BUTTON_R1) {
      if (event.action == KeyEvent.ACTION_DOWN) {
        scroller.page(if (code == KeyEvent.KEYCODE_BUTTON_L1) -1 else 1)
      }
      return true
    }
    if (code in NAVIGATION_KEYS) {
      // After a page opens, focus can stay on a control of the page underneath.
      // Move it onto the page the user sees instead of navigating or clicking
      // behind it; the key-up of that press is swallowed too.
      val decor = appContext.currentActivity?.window?.decorView
      val focused = decor?.findFocus()
      if (decor != null && event.action == KeyEvent.ACTION_DOWN && event.repeatCount == 0 &&
        !decor.isInTouchMode && (focused == null || isCovered(focused, decor))
      ) {
        if (focusTopLayer(decor)) {
          swallowKeyCode = code
          return true
        }
      }
    }
    if (event.action == KeyEvent.ACTION_DOWN) {
      when (code) {
        KeyEvent.KEYCODE_DPAD_UP -> lastNavDirection = View.FOCUS_UP
        KeyEvent.KEYCODE_DPAD_DOWN -> lastNavDirection = View.FOCUS_DOWN
        KeyEvent.KEYCODE_DPAD_LEFT -> lastNavDirection = View.FOCUS_LEFT
        KeyEvent.KEYCODE_DPAD_RIGHT -> lastNavDirection = View.FOCUS_RIGHT
      }
    }
    return false
  }

  private val hitRect = Rect()

  /** Whether another page or layer is drawn over the centre of [view]. */
  private fun isCovered(view: View, root: View): Boolean {
    val bounds = Rect()
    if (!view.getGlobalVisibleRect(bounds)) return true
    val top = topmostAt(root, bounds.centerX(), bounds.centerY()) ?: return false
    return !isAncestorOrSelf(view, top) && !isAncestorOrSelf(top, view)
  }

  /** Deepest drawn view at a window point; empty transparent containers let the point through. */
  private fun topmostAt(view: View, x: Int, y: Int): View? {
    // RN mounts this transparent, non-interactive full-window drawing surface
    // in development builds even when no inspector highlight is being drawn.
    // It does not cover the content or the real send button beneath it.
    if (view.javaClass.name == "com.facebook.react.views.debuggingoverlay.DebuggingOverlay") return null
    if (view.visibility != View.VISIBLE || view.alpha <= 0.01f) return null
    if (!view.getGlobalVisibleRect(hitRect) || !hitRect.contains(x, y)) return null
    if (view is ViewGroup) {
      for (index in view.childCount - 1 downTo 0) {
        topmostAt(view.getChildAt(index), x, y)?.let { return it }
      }
      return if (view.background != null) view else null
    }
    return view
  }

  private fun isAncestorOrSelf(ancestor: View, view: View): Boolean {
    var current: View? = view
    while (current != null) {
      if (current === ancestor) return true
      current = current.parent as? View
    }
    return false
  }

  private fun isVisiblyAttached(view: View): Boolean {
    if (!view.isAttachedToWindow || !view.isShown) return false
    var current: View? = view
    while (current != null) {
      if (current.alpha <= 0.01f) return false
      current = current.parent as? View
    }
    return true
  }

  /** Focus the top-left visible control of the page the user is looking at. */
  private fun focusTopLayer(decor: View): Boolean {
    val density = decor.resources.displayMetrics.density
    val minSide = MIN_FOCUS_TARGET_DP * density
    val bounds = Rect()
    val target = decor.getFocusables(View.FOCUS_FORWARD)
      .filter { candidate ->
        candidate !== decor && candidate.isShown && candidate.getGlobalVisibleRect(bounds) &&
          bounds.width() >= minSide && bounds.height() >= minSide && !isCovered(candidate, decor)
      }
      .minWithOrNull(compareBy<View>({ view -> view.globalTop() }, { view -> view.globalLeft() }))
      ?: return false
    return target.requestFocus()
  }

  private fun View.globalTop(): Int = IntArray(2).also { getLocationInWindow(it) }[1]
  private fun View.globalLeft(): Int = IntArray(2).also { getLocationInWindow(it) }[0]

  private fun handleVoiceKey(event: KeyEvent) {
    when (event.action) {
      KeyEvent.ACTION_DOWN -> {
        if (event.repeatCount == 0 && !voiceDown) {
          voiceDown = true
          voiceActive = false
          main.removeCallbacks(holdRunnable)
          main.postDelayed(holdRunnable, holdMs)
        }
      }
      KeyEvent.ACTION_UP -> {
        if (!voiceDown) return
        main.removeCallbacks(holdRunnable)
        val wasActive = voiceActive
        voiceDown = false
        voiceActive = false
        val canceled = (event.flags and KeyEvent.FLAG_CANCELED) != 0
        val phase = when {
          wasActive && canceled -> "cancel"
          wasActive -> "end"
          else -> "tap"
        }
        sendEvent("onVoiceKey", mapOf("phase" to phase))
      }
    }
  }

  /**
   * Ends a hold whose key-up will never reach this window (permission dialog,
   * notification shade, background). Treated as a normal release so a started
   * recording stops and keeps its text.
   */
  private fun releaseVoice() {
    main.removeCallbacks(holdRunnable)
    val wasActive = voiceActive
    voiceDown = false
    voiceActive = false
    if (wasActive) sendEvent("onVoiceKey", mapOf("phase" to "end"))
  }

  private fun resetInput() {
    releaseVoice()
    controllers.clear()
    swallowKeyCode = KeyEvent.KEYCODE_UNKNOWN
    scroller.stop()
  }

  private fun scrollModifier(state: ControllerState): Boolean =
    (state.l2 && voiceKeyCode != KeyEvent.KEYCODE_BUTTON_L2) ||
      (state.r2 && voiceKeyCode != KeyEvent.KEYCODE_BUTTON_R2)

  private fun updateDpadScroll() {
    val direction = if (sessionScope == null) 0 else controllers.values.sumOf { state ->
      if (!scrollModifier(state)) 0 else
        (if (KeyEvent.KEYCODE_DPAD_DOWN in state.scrollKeys) 1 else 0) -
          (if (KeyEvent.KEYCODE_DPAD_UP in state.scrollKeys) 1 else 0)
    }
    scroller.updateDpad(direction.coerceIn(-1, 1).toFloat())
  }

  private fun updateTriggerVoice() {
    val down = when (voiceKeyCode) {
      KeyEvent.KEYCODE_BUTTON_L2 -> controllers.values.any { it.l2 }
      KeyEvent.KEYCODE_BUTTON_R2 -> controllers.values.any { it.r2 }
      else -> return
    }
    if (down == voiceDown) return
    handleVoiceKey(KeyEvent(if (down) KeyEvent.ACTION_DOWN else KeyEvent.ACTION_UP, voiceKeyCode))
  }

  private fun handleMotion(event: MotionEvent) {
    if (!enabled) return
    if (!event.isFromSource(InputDevice.SOURCE_JOYSTICK) || event.actionMasked != MotionEvent.ACTION_MOVE) return
    val state = controllers.getOrPut(event.deviceId) { ControllerState() }
    // Android maps triggers to LTRIGGER/RTRIGGER or BRAKE/GAS. Use the device's
    // neutral range/flat rather than imposing one controller's actuation threshold.
    fun pressed(axis: Int): Boolean {
      val range = event.device?.getMotionRange(axis, event.source)
      return event.getAxisValue(axis) > max(0f, range?.min ?: 0f) + (range?.flat ?: 0f)
    }
    state.l2Axis = pressed(MotionEvent.AXIS_LTRIGGER) || pressed(MotionEvent.AXIS_BRAKE)
    state.r2Axis = pressed(MotionEvent.AXIS_RTRIGGER) || pressed(MotionEvent.AXIS_GAS)
    state.hatY = event.getAxisValue(MotionEvent.AXIS_HAT_Y)
    updateTriggerVoice()
    updateDpadScroll()
    scroller.update(event.getAxisValue(MotionEvent.AXIS_RZ))
  }

  private inner class HandheldWindowCallback(val base: Window.Callback) : Window.Callback by base {
    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
      if (handleKey(event)) return true
      return base.dispatchKeyEvent(event)
    }

    override fun dispatchGenericMotionEvent(event: MotionEvent): Boolean {
      // Observe only: the same event carries the left stick / hat that Android
      // turns into D-pad KeyEvents when left unconsumed. Those keys go through
      // handleKey too, so trigger + HAT_Y scrolls without stealing left-stick input.
      handleMotion(event)
      return base.dispatchGenericMotionEvent(event)
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
      if (!hasFocus) {
        resetInput()
      }
      base.onWindowFocusChanged(hasFocus)
    }
  }

  /** Draws a ring around the focused view while the user navigates with keys. */
  private inner class FocusRing(activity: Activity) :
    ViewTreeObserver.OnGlobalFocusChangeListener,
    ViewTreeObserver.OnPreDrawListener,
    ViewTreeObserver.OnTouchModeChangeListener {
    private val activityRef = WeakReference(activity)
    private val decor: View = activity.window.decorView
    private val density = decor.resources.displayMetrics.density
    private val drawable = GradientDrawable().apply {
      shape = GradientDrawable.RECTANGLE
      cornerRadius = 12f * density
      setColor(Color.TRANSPARENT)
    }
    private var focused: WeakReference<View>? = null
    private val next = Rect()
    private val current = Rect()
    private var attached = false

    fun isFor(activity: Activity?): Boolean = activity != null && activityRef.get() === activity && attached

    fun attach() {
      if (attached) return
      attached = true
      setColor(focusColor)
      val observer = decor.viewTreeObserver
      observer.addOnGlobalFocusChangeListener(this)
      observer.addOnPreDrawListener(this)
      observer.addOnTouchModeChangeListener(this)
      decor.overlay.add(drawable)
      focused = decor.findFocus()?.let { WeakReference(it) }
      refresh()
    }

    fun detach() {
      if (!attached) return
      restoreAll()
      attached = false
      val observer = decor.viewTreeObserver
      if (observer.isAlive) {
        observer.removeOnGlobalFocusChangeListener(this)
        observer.removeOnPreDrawListener(this)
        observer.removeOnTouchModeChangeListener(this)
      }
      decor.overlay.remove(drawable)
    }

    fun setColor(color: Int) {
      drawable.setStroke((3f * density).toInt().coerceAtLeast(2), color)
      decor.invalidate()
    }

    override fun onGlobalFocusChanged(oldFocus: View?, newFocus: View?) {
      if (focusAssistActive() && newFocus != null && newFocus !== decor && !isUsable(newFocus)) {
        skip(newFocus, oldFocus)
        return
      }
      focused = newFocus?.let { WeakReference(it) }
      refresh()
    }

    override fun onTouchModeChanged(isInTouchMode: Boolean) {
      refresh()
    }

    override fun onPreDraw(): Boolean {
      restoreUsable()
      refresh()
      return true
    }

    private val probe = Rect()
    private val skipped = WeakHashMap<View, Boolean>()
    private var lastRestoreCheck = 0L

    /** Hidden or near-invisible views (pre-warmed 2×2 WebViews) can't be a key-navigation target. */
    private fun isUsable(view: View): Boolean {
      if (!view.isShown || !view.getGlobalVisibleRect(probe)) return false
      val min = MIN_FOCUS_TARGET_DP * density
      return probe.width() >= min && probe.height() >= min
    }

    /**
     * Take an unusable view out of key navigation for as long as handheld mode
     * is on, and continue in the direction the user was moving.
     */
    private fun skip(view: View, previous: View?) {
      if (skipped.size >= MAX_SKIPPED_FOCUSABLES) return
      skipped[view] = view.isFocusableInTouchMode
      view.isFocusable = false
      val direction = lastNavDirection
      main.post {
        if (!attached || !focusAssistActive()) return@post
        val from = previous?.takeIf { it.isAttachedToWindow && it.isFocusable && isUsable(it) }
        val target = from?.focusSearch(direction)
        when {
          target != null -> target.requestFocus(direction)
          from != null -> from.requestFocus()
          else -> decor.requestFocus(View.FOCUS_DOWN)
        }
      }
    }

    /** Give skipped views their focus back once they are real on-screen controls again. */
    private fun restoreUsable() {
      if (skipped.isEmpty()) return
      val now = System.currentTimeMillis()
      if (now - lastRestoreCheck < 500L) return
      lastRestoreCheck = now
      val iterator = skipped.entries.iterator()
      while (iterator.hasNext()) {
        val (view, focusableInTouchMode) = iterator.next()
        if (!focusAssistActive() || (view.isAttachedToWindow && isUsable(view))) {
          view.isFocusable = true
          view.isFocusableInTouchMode = focusableInTouchMode
          iterator.remove()
        }
      }
    }

    fun restoreAll() {
      for ((view, focusableInTouchMode) in skipped) {
        view.isFocusable = true
        view.isFocusableInTouchMode = focusableInTouchMode
      }
      skipped.clear()
    }

    fun refresh() {
      if (!attached) return
      val view = focused?.get()
      val visible = focusAssistActive() && !decor.isInTouchMode && view != null && view !== decor &&
        view.isAttachedToWindow && view.isShown && !isCovered(view, decor) && view.getGlobalVisibleRect(next)
      if (visible) {
        val pad = (3f * density).toInt()
        next.inset(-pad, -pad)
      } else {
        next.setEmpty()
      }
      if (next != current) {
        current.set(next)
        drawable.bounds = current
        decor.invalidate()
      }
    }
  }

  /** Right-stick continuous scrolling and L1/R1 paging of the list the user is looking at. */
  private inner class StickScroller : Choreographer.FrameCallback {
    private var velocity = 0f
    private var stick = 0f
    private var dpad = 0f
    private var running = false
    private var lastFrameNanos = 0L
    private var remainder = 0f
    private var cachedTarget: WeakReference<View>? = null
    private var cachedAt = 0L

    fun update(value: Float) {
      stick = if (abs(value) < STICK_DEAD_ZONE) 0f else value
      updateVelocity()
    }

    fun updateDpad(value: Float) {
      dpad = value * 0.6f
      updateVelocity()
    }

    private fun updateVelocity() {
      velocity = if (dpad != 0f) dpad else stick
      if (velocity != 0f && !running) {
        running = true
        lastFrameNanos = 0L
        remainder = 0f
        Choreographer.getInstance().postFrameCallback(this)
      }
    }

    fun stop() {
      velocity = 0f
      stick = 0f
      dpad = 0f
      Choreographer.getInstance().removeFrameCallback(this)
      running = false
      cachedTarget = null
      cachedAt = 0L
    }

    fun page(direction: Int) {
      val target = target() ?: return
      val distance = (target.height * 0.8f).toInt() * direction * orientation(target)
      if (target is ScrollView) target.smoothScrollBy(0, distance) else target.scrollBy(0, distance)
    }

    override fun doFrame(frameTimeNanos: Long) {
      if (velocity == 0f || !enabled) {
        running = false
        return
      }
      val elapsed = if (lastFrameNanos == 0L) 1f / 60f else (frameTimeNanos - lastFrameNanos) / 1_000_000_000f
      lastFrameNanos = frameTimeNanos
      val target = target()
      if (target != null) {
        val density = target.resources.displayMetrics.density
        // Quadratic response: fine control near the centre, fast at full tilt.
        val speed = velocity * abs(velocity) * STICK_MAX_DP_PER_SECOND * density
        remainder += speed * elapsed.coerceIn(0f, 0.05f) * orientation(target)
        val step = remainder.toInt()
        if (step != 0) {
          remainder -= step
          target.scrollBy(0, step)
        }
      }
      Choreographer.getInstance().postFrameCallback(this)
    }

    private fun target(): View? {
      val now = System.currentTimeMillis()
      cachedTarget?.get()?.let { view ->
        val decor = appContext.currentActivity?.window?.decorView
        if (now - cachedAt < SCROLL_TARGET_TTL_MS && decor != null &&
          isVisiblyAttached(view) && !isCovered(view, decor)) return view
      }
      val decor = appContext.currentActivity?.window?.decorView ?: return null
      val found = findScrollTarget(decor)
      cachedTarget = found?.let { WeakReference(it) }
      cachedAt = now
      return found
    }

    private fun findScrollTarget(decor: View): View? {
      val rect = Rect()
      val minSide = MIN_SCROLL_TARGET_DP * decor.resources.displayMetrics.density
      // Pre-warmed hidden WebViews are scrollable too; only real on-screen lists count.
      fun visibleEnough(candidate: View): Boolean =
        isVisiblyAttached(candidate) && candidate.getGlobalVisibleRect(rect) &&
          rect.width() >= minSide && rect.height() >= minSide && !isCovered(candidate, decor)
      var view: View? = decor.findFocus()
      while (view != null && view !== decor) {
        if (view.isShown && scrollsVertically(view) && visibleEnough(view)) return view
        view = view.parent as? View
      }
      var best: View? = null
      var bestArea = 0
      fun walk(candidate: View) {
        if (!candidate.isShown || candidate.alpha <= 0.01f) return
        if (scrollsVertically(candidate) && visibleEnough(candidate)) {
          val area = rect.width() * rect.height()
          if (area > bestArea) {
            bestArea = area
            best = candidate
          }
        }
        if (candidate is ViewGroup) {
          for (index in 0 until candidate.childCount) walk(candidate.getChildAt(index))
        }
      }
      walk(decor)
      return best
    }

    private fun scrollsVertically(view: View): Boolean =
      view.canScrollVertically(1) || view.canScrollVertically(-1)

    /** Inverted chat lists flip their scroll view; keep stick direction visual. */
    private fun orientation(view: View): Int {
      var sign = 1
      var current: View? = view
      while (current != null) {
        if (current.scaleY < 0f) sign = -sign
        current = current.parent as? View
      }
      return sign
    }
  }
}
