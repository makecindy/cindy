package app.cindy.usagewidgets

import android.app.Activity
import android.app.AlertDialog
import android.appwidget.AppWidgetManager
import android.content.Context
import android.content.Intent
import android.content.res.Configuration
import android.graphics.Bitmap
import android.content.res.ColorStateList
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.BitmapDrawable
import android.os.Bundle
import android.view.ContextThemeWrapper
import android.view.Gravity
import android.view.View
import android.widget.LinearLayout
import android.widget.Switch
import android.widget.ScrollView
import android.widget.TextView
import java.util.Locale

/**
 * A widget's settings, shown when it is added and from the launcher's reconfigure action. Every
 * widget picks its computer, or "automatic" (the one that answered the app last). The quota widget
 * also places accounts first and hides accounts, like the iOS edit sheet and the Mac menu bar's
 * settings; every other account, including ones added later, follows in the computer's order.
 */
class ComputerConfigActivity : Activity() {
  private var appWidgetId = AppWidgetManager.INVALID_APPWIDGET_ID
  private val locale: Locale get() = Locale.getDefault()

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    appWidgetId = intent?.getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID)
      ?: AppWidgetManager.INVALID_APPWIDGET_ID
    setResult(RESULT_CANCELED, Intent().putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, appWidgetId))
    if (appWidgetId == AppWidgetManager.INVALID_APPWIDGET_ID) return finish()

    val store = WidgetStore.load(this)
    val computers = store?.computers ?: emptyList()
    if (computers.isEmpty()) {
      // Nothing to choose from yet: stay on "automatic" and let the widget say what is missing.
      return done(WidgetStore.AUTO)
    }
    if (kindOf(AppWidgetManager.getInstance(this), appWidgetId) == WidgetKind.Quota) {
      QuotaSettings(this, computers).show()
      return
    }
    val ids = listOf(WidgetStore.AUTO) + computers.map { it.id }
    val names = listOf(text("sourceAuto")) + computers.map { it.name }
    val current = ids.indexOf(WidgetStore.computerOf(this, appWidgetId)).coerceAtLeast(0)
    AlertDialog.Builder(this, dialogTheme())
      .setTitle(text("sourceTitle"))
      .setSingleChoiceItems(names.toTypedArray(), current) { dialog, which ->
        dialog.dismiss()
        done(ids[which])
      }
      .setOnCancelListener { finish() }
      .show()
  }

  private fun done(computer: String, pinned: List<String>? = null, hidden: List<String>? = null) {
    WidgetStore.setComputer(this, appWidgetId, computer)
    if (pinned != null && hidden != null) WidgetStore.setAccounts(this, appWidgetId, pinned, hidden)
    UsageWidgetProviderBase.updateAsync(this, intArrayOf(appWidgetId), kindOf(AppWidgetManager.getInstance(this), appWidgetId))
    setResult(RESULT_OK, Intent().putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, appWidgetId))
    finish()
  }

  private fun text(key: String) = WidgetText.text(this, key, locale)

  private val night: Boolean
    get() = (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES

  private fun dialogTheme() =
    if (night) android.R.style.Theme_DeviceDefault_Dialog_Alert else android.R.style.Theme_DeviceDefault_Light_Dialog_Alert

  private fun kindOf(manager: AppWidgetManager, id: Int): WidgetKind =
    if (manager.getAppWidgetInfo(id)?.provider?.className == UsageWidgetProvider::class.java.name) WidgetKind.Usage else WidgetKind.Quota

  /**
   * The quota widget's settings: the computer, the accounts placed first (in order, up to what the
   * large size shows) and the hidden accounts. The lists offer the chosen computer's accounts;
   * choices that name another computer's account stay and find it again by logo and name.
   */
  private inner class QuotaSettings(context: Context, private val computers: List<WidgetStore.Computer>) {
    private val ui = ContextThemeWrapper(context, dialogTheme())
    // A computer that is gone (removed, remote control off, another account) shows as "automatic", so that is
    // also what Done saves; otherwise the widget would keep the missing id and stay empty.
    private var computer = WidgetStore.computerOf(context, appWidgetId)
      .takeIf { id -> id == WidgetStore.AUTO || computers.any { it.id == id } } ?: WidgetStore.AUTO
    private val pinned = WidgetStore.pinnedOf(context, appWidgetId).toMutableList()
    private val hidden = WidgetStore.hiddenOf(context, appWidgetId).toMutableList()
    private val accountsBox = LinearLayout(ui).apply { orientation = LinearLayout.VERTICAL }

    private val pal = WidgetPalette(night)

    fun show() {
      val content = LinearLayout(ui).apply {
        orientation = LinearLayout.VERTICAL
        setPadding(dp(22), dp(22), dp(22), dp(6))
        addView(TextView(ui).apply {
          text = text("quotaName")
          textSize = 20f
          typeface = WidgetPainter.systemFace(Weight.Semibold)
          setTextColor(pal.ink)
        })
        addView(header(text("configComputer")))
        addView(computerChoice())
        addView(accountsBox)
      }
      renderAccounts()
      val dialog = AlertDialog.Builder(ui)
        .setView(ScrollView(ui).apply { addView(content) })
        .setPositiveButton(text("configDone")) { _, _ -> done(computer, pinned.toList(), hidden.toList()) }
        .setNegativeButton(text("configCancel")) { _, _ -> finish() }
        .setOnCancelListener { finish() }
        .create()
      dialog.setOnShowListener {
        // The widget's own surface and ink, so the settings look like what they configure.
        dialog.window?.setBackgroundDrawable(shape(pal.background, pal.line, 28, 1))
        for (which in listOf(AlertDialog.BUTTON_POSITIVE, AlertDialog.BUTTON_NEGATIVE)) {
          dialog.getButton(which)?.apply {
            isAllCaps = false
            setTextColor(if (which == AlertDialog.BUTTON_POSITIVE) pal.plenty else pal.ink2)
          }
        }
      }
      dialog.show()
    }

    /** A rounded surface; `stroke` of 0 is no border. */
    private fun shape(fill: Int, stroke: Int, radius: Int, strokeDp: Int = 1) = GradientDrawable().apply {
      setColor(fill)
      cornerRadius = dp(radius).toFloat()
      if (strokeDp > 0) setStroke(dp(strokeDp), stroke)
    }

    /** One choice per row: a tile that takes the teal outline and a check when chosen. */
    private fun computerChoice(): View {
      val ids = listOf(WidgetStore.AUTO) + computers.map { it.id }
      val names = listOf(text("sourceAuto")) + computers.map { it.name }
      val box = LinearLayout(ui).apply { orientation = LinearLayout.VERTICAL }
      fun render() {
        box.removeAllViews()
        ids.forEachIndexed { index, id ->
          val chosen = id == computer
          box.addView(LinearLayout(ui).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            minimumHeight = dp(46)
            setPadding(dp(14), 0, dp(14), 0)
            background = if (chosen) shape(withAlpha(pal.plenty, 0.10f), pal.plenty, 14, 2) else shape(pal.tile, pal.line, 14, 1)
            addView(TextView(ui).apply {
              text = names[index]
              textSize = 15f
              setTextColor(pal.ink)
            }, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
            if (chosen) addView(TextView(ui).apply {
              text = "✓"
              textSize = 16f
              typeface = WidgetPainter.systemFace(Weight.Semibold)
              setTextColor(pal.plenty)
            })
            setOnClickListener {
              if (computer != id) {
                computer = id
                render()
                renderAccounts()
              }
            }
          }, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(6) })
        }
      }
      render()
      return box
    }

    /** The chosen computer's accounts, in its order (hidden ones on the computer are not sent). */
    private fun sources(): List<WidgetSource> =
      WidgetStore.loadState(ui, computer).snapshotOrNull?.sources ?: emptyList()

    private fun renderAccounts() {
      accountsBox.removeAllViews()
      val sources = sources()
      accountsBox.addView(header(text("configPinned")))
      pinned.forEachIndexed { index, encoded ->
        val key = AccountKey.decode(encoded)
        accountsBox.addView(row(key.logo, key.name) {
          addView(glyphButton("↑", text("configMoveUp"), index > 0) { move(index, -1) })
          addView(glyphButton("↓", text("configMoveDown"), index < pinned.size - 1) { move(index, 1) })
          addView(glyphButton("✕", text("configRemove"), true) {
            pinned.removeAt(index)
            renderAccounts()
          })
        })
      }
      val addable = sources.filter { AccountKey.matching(pinned, listOf(it)).isEmpty() }
      if (pinned.size < MAX_PINNED && addable.isNotEmpty()) {
        accountsBox.addView(TextView(ui).apply {
          text = "+  " + text("configAdd")
          setTextColor(pal.plenty)
          textSize = 14f
          typeface = WidgetPainter.systemFace(Weight.Medium)
          gravity = Gravity.CENTER
          background = shape(Color.TRANSPARENT, withAlpha(pal.plenty, 0.5f), 14, 1)
          setOnClickListener { pickPinned(addable) }
        }, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(42)).apply { topMargin = dp(8) })
      }
      accountsBox.addView(hint(text("configPinnedHint")))

      accountsBox.addView(header(text("configHidden")))
      if (sources.isEmpty()) accountsBox.addView(hint(text("noSources")))
      for (source in sources) {
        val switch = Switch(ui).apply {
          isChecked = AccountKey.matching(hidden, listOf(source)).isNotEmpty()
          thumbTintList = ColorStateList(
            arrayOf(intArrayOf(android.R.attr.state_checked), intArrayOf()), intArrayOf(pal.plenty, pal.ink3),
          )
          trackTintList = ColorStateList(
            arrayOf(intArrayOf(android.R.attr.state_checked), intArrayOf()), intArrayOf(withAlpha(pal.plenty, 0.35f), pal.ink4),
          )
          setOnCheckedChangeListener { _, checked ->
            // Unchecking also drops the same account saved from another computer.
            hidden.removeAll { AccountKey.matching(listOf(it), listOf(source)).isNotEmpty() }
            if (checked) hidden.add(AccountKey(source).encoded)
          }
        }
        accountsBox.addView(row(source.logo, source.name) { addView(switch) })
      }
    }

    private fun move(index: Int, by: Int) {
      val target = index + by
      if (target !in pinned.indices) return
      pinned.add(target, pinned.removeAt(index))
      renderAccounts()
    }

    private fun pickPinned(addable: List<WidgetSource>) {
      AlertDialog.Builder(ui)
        .setTitle(text("configPinned"))
        .setItems(addable.map { it.name }.toTypedArray()) { _, which ->
          pinned.add(AccountKey(addable[which]).encoded)
          renderAccounts()
        }
        .show()
    }

    /** An account as a tile: its mark and name, then whatever `actions` adds on the right. */
    private fun row(logo: String?, name: String, actions: LinearLayout.() -> Unit) = LinearLayout(ui).apply {
      orientation = LinearLayout.HORIZONTAL
      gravity = Gravity.CENTER_VERTICAL
      minimumHeight = dp(46)
      setPadding(dp(14), 0, dp(8), 0)
      background = shape(pal.tile, pal.line, 14, 1)
      addView(TextView(ui).apply {
        text = name
        textSize = 15f
        setTextColor(pal.ink)
        setCompoundDrawablesRelativeWithIntrinsicBounds(logo(logo, name.take(1).uppercase()), null, null, null)
        compoundDrawablePadding = dp(10)
      }, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
      actions()
      layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(6) }
    }

    private fun glyphButton(glyph: String, label: String, enabled: Boolean, onClick: () -> Unit) = TextView(ui).apply {
      text = glyph
      contentDescription = label
      textSize = 16f
      gravity = Gravity.CENTER
      setTextColor(pal.ink2)
      alpha = if (enabled) 1f else 0.25f
      isEnabled = enabled
      setOnClickListener { onClick() }
      layoutParams = LinearLayout.LayoutParams(dp(38), dp(38))
    }

    private fun header(label: String) = TextView(ui).apply {
      text = label
      textSize = 12f
      typeface = WidgetPainter.systemFace(Weight.Medium)
      letterSpacing = 0.04f
      setTextColor(pal.ink3)
      setPadding(dp(2), dp(20), 0, dp(0))
    }

    private fun hint(label: String) = TextView(ui).apply {
      text = label
      textSize = 12f
      setTextColor(pal.ink3)
      setPadding(dp(2), dp(8), 0, dp(0))
    }

    /** The account's mark, drawn like on the widget, in the dialog's secondary text color. */
    private fun logo(logo: String?, monogram: String): BitmapDrawable {
      val density = ui.resources.displayMetrics.density
      val size = 20f
      val bitmap = Bitmap.createBitmap((size * density).toInt(), (size * density).toInt(), Bitmap.Config.ARGB_8888)
      val canvas = Canvas(bitmap).apply { scale(density, density) }
      WidgetPainter(ui, canvas, pal).logo(logo, monogram, 0f, 0f, size, pal.ink2)
      return BitmapDrawable(ui.resources, bitmap)
    }

    private fun dp(value: Int) = (value * ui.resources.displayMetrics.density).toInt()
  }

  companion object {
    /** As many as the large layout shows. */
    private const val MAX_PINNED = 7
  }
}
