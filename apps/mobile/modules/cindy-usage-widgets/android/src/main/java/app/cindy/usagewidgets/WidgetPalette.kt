package app.cindy.usagewidgets

import android.graphics.Color
import kotlin.math.roundToInt

/**
 * The macOS menu bar panel's palette (`apps/desktop/native/menubar`), as in the iOS widgets: every
 * neutral is Cindy's warm black (Light) or warm white (Dark) at an opacity; only state, brand and
 * harness colors are solid.
 */
class WidgetPalette(val isDark: Boolean) {
  private fun rgb(value: Int, alpha: Float = 1f): Int =
    Color.argb((alpha * 255).roundToInt(), (value shr 16) and 0xFF, (value shr 8) and 0xFF, value and 0xFF)

  private fun neutral(light: Float, dark: Float): Int = if (isDark) rgb(WARM_WHITE, dark) else rgb(WARM_BLACK, light)

  private fun themed(light: Int, dark: Int): Int = if (isDark) dark else light

  val ink = neutral(0.92f, 0.94f)
  val ink2 = neutral(0.60f, 0.62f)
  val ink3 = neutral(0.42f, 0.42f)
  val ink4 = neutral(0.14f, 0.13f)
  val ink5 = neutral(0.05f, 0.05f)
  val line = neutral(0.08f, 0.07f)
  val tile = themed(Color.argb(140, 255, 255, 255), rgb(WARM_WHITE, 0.05f))
  val liquid = neutral(0.46f, 0.72f)
  val wellTop = themed(Color.argb(191, 255, 255, 255), rgb(WARM_WHITE, 0.07f))
  val wellBottom = themed(Color.argb(128, 255, 255, 255), rgb(WARM_WHITE, 0.025f))
  val wellShade = themed(Color.argb(20, 0, 0, 0), Color.argb(128, 0, 0, 0))
  val background = themed(rgb(0xF7F5F0), rgb(0x1C1A18))
  val glow = themed(rgb(0xEA6B17, 0.09f), rgb(0xEA6B17, 0.12f))
  val glow2 = themed(Color.argb(140, 255, 255, 255), rgb(0xFFF4E4, 0.04f))

  /** Old-data notices ("updated 7 hours ago"); not a quota state. */
  val warn = rgb(0xEA6B17)

  /**
   * Quota states, shared with the Mac panel and the apps (`@cindy/maker-shared/quota-level`):
   * plenty left is teal, 30% or less is yellow, 10% or less is red.
   */
  val plenty = themed(rgb(0x14B8A6), rgb(0x2DD4BF))
  val quotaWarn = rgb(0xF3A115)
  val error = rgb(0xEF4444)
  val claude = rgb(0xD97757)
  val codex = rgb(0x7A9DFF)
  val pi = plenty

  /** Neutral ring arcs (a balance) share the liquid's tone, like the panel. */
  val fill = neutral(0.42f, 0.80f)
  val claude2 = rgb(0xE8A184)
  val claude3 = rgb(0xF2C9B6)

  /** Usage History model palette (`--usage-model-1…5`): teal, rose, violet, indigo, amber. */
  private val models = listOf(
    themed(rgb(0x14B8A6), rgb(0x2DD4BF)),
    themed(rgb(0xF43F5E), rgb(0xFB7185)),
    themed(rgb(0x8B5CF6), rgb(0xA78BFA)),
    themed(rgb(0x6366F1), rgb(0x818CF8)),
    themed(rgb(0xF59E0B), rgb(0xFBBF24)),
  )

  fun model(rank: Int): Int = models[rank % models.size]

  /** Everything beyond the named models. */
  val otherModel = neutral(0.24f, 0.30f)

  /** The panel's semantic color names (`MenubarColor`). */
  fun named(name: String?): Int = when (name) {
    "ink2" -> ink2
    "ink3" -> ink3
    "fill" -> fill
    "warn" -> quotaWarn
    "error" -> error
    "claude" -> claude
    "claude2" -> claude2
    "claude3" -> claude3
    "codex" -> codex
    "pi" -> pi
    else -> ink
  }

  /** The tint for a quota level, or null while plenty is left. */
  fun level(level: String): Int? = when (level) {
    "warn" -> quotaWarn
    "error" -> error
    else -> null
  }

  /** Harness colors in stacking order index (0 claude-code, 1 codex, 2 pi). */
  fun harness(index: Int): Int = when (index) {
    0 -> claude
    1 -> codex
    else -> pi
  }

  companion object {
    private const val WARM_BLACK = 0x26221C
    private const val WARM_WHITE = 0xF2EFE9
  }
}
