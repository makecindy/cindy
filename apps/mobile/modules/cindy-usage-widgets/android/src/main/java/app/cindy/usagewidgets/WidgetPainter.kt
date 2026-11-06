package app.cindy.usagewidgets

import android.content.Context
import android.graphics.Canvas
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RadialGradient
import android.graphics.RectF
import android.graphics.Shader
import android.graphics.Typeface
import android.os.Build
import android.text.Layout
import android.text.StaticLayout
import android.text.TextPaint
import android.text.TextUtils
import androidx.core.graphics.PathParser
import kotlin.math.max
import kotlin.math.min

enum class Weight(val value: Int) { Regular(400), Medium(500), Semibold(600) }

/** A text style in dp; `barlow` draws the numbers in Barlow Condensed like the Mac panel. */
class TextStyle(val size: Float, val color: Int, val weight: Weight = Weight.Regular, val barlow: Boolean = false)

enum class Align { Start, Center, End }

/**
 * Immediate-mode drawing in dp. The canvas is scaled once to the density, so every number here
 * is a point-sized iOS value; text is placed by its line box (top of the box, not the baseline).
 */
class WidgetPainter(val context: Context, val canvas: Canvas, val palette: WidgetPalette) {
  private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
  private val textPaint = TextPaint(Paint.ANTI_ALIAS_FLAG)

  // ---- text ----

  private fun typeface(style: TextStyle): Typeface {
    if (style.barlow) {
      val face = fonts(context)
      return if (style.weight == Weight.Semibold) face.semibold else face.medium
    }
    return systemFace(style.weight)
  }

  private fun configure(style: TextStyle): TextPaint = textPaint.apply {
    reset()
    isAntiAlias = true
    textSize = style.size
    color = style.color
    typeface = typeface(style)
  }

  fun lineHeight(style: TextStyle): Float {
    val metrics = configure(style).fontMetrics
    return metrics.descent - metrics.ascent
  }

  fun textWidth(text: String, style: TextStyle): Float = configure(style).measureText(text)

  /** Distance from the top of the line box to the baseline. */
  fun ascent(style: TextStyle): Float = -configure(style).fontMetrics.ascent

  /** Draws one line by baseline, for pieces of different sizes that share a baseline. */
  fun textAt(text: String, x: Float, baseline: Float, style: TextStyle) {
    canvas.drawText(text, x, baseline, configure(style))
  }

  /** Draws one line in a box whose top-left is (x, top), aligned inside `width` when given. */
  fun text(text: String, x: Float, top: Float, style: TextStyle, width: Float = 0f, align: Align = Align.Start) {
    val p = configure(style)
    val metrics = p.fontMetrics
    val measured = p.measureText(text)
    val left = when (align) {
      Align.Start -> x
      Align.Center -> x + (width - measured) / 2
      Align.End -> x + width - measured
    }
    canvas.drawText(text, left, top - metrics.ascent, p)
  }

  /** One line shrunk down to `minScale` and then ellipsized to fit `width`; returns the drawn width. */
  fun fitText(
    text: String, x: Float, top: Float, style: TextStyle, width: Float, align: Align = Align.Start, minScale: Float = 1f,
  ): Float {
    // The line box of the unscaled style keeps the baseline still when the text shrinks. It must be read
    // first: lineHeight() configures the shared paint, which would undo the shrink below.
    val box = lineHeight(style)
    var size = style.size
    var p = configure(style)
    var measured = p.measureText(text)
    if (measured > width && minScale < 1f) {
      size = max(style.size * minScale, style.size * width / measured)
      p = configure(TextStyle(size, style.color, style.weight, style.barlow))
      measured = p.measureText(text)
    }
    val shown = if (measured > width) TextUtils.ellipsize(text, p, width, TextUtils.TruncateAt.END).toString() else text
    val shownWidth = p.measureText(shown)
    val metrics = p.fontMetrics
    val left = when (align) {
      Align.Start -> x
      Align.Center -> x + (width - shownWidth) / 2
      Align.End -> x + width - shownWidth
    }
    val baselineTop = top + (box - (metrics.descent - metrics.ascent)) / 2
    canvas.drawText(shown, left, baselineTop - metrics.ascent, p)
    return shownWidth
  }

  /** A wrapped paragraph; returns its height. */
  fun paragraph(text: String, x: Float, top: Float, width: Float, style: TextStyle, maxLines: Int): Float {
    val p = configure(style)
    val layout = StaticLayout.Builder.obtain(text, 0, text.length, p, width.toInt().coerceAtLeast(1))
      .setAlignment(Layout.Alignment.ALIGN_NORMAL)
      .setMaxLines(maxLines)
      .setEllipsize(TextUtils.TruncateAt.END)
      .build()
    canvas.save()
    canvas.translate(x, top)
    layout.draw(canvas)
    canvas.restore()
    return layout.height.toFloat()
  }

  fun paragraphHeight(text: String, width: Float, style: TextStyle, maxLines: Int): Float {
    val p = configure(style)
    return StaticLayout.Builder.obtain(text, 0, text.length, p, width.toInt().coerceAtLeast(1))
      .setMaxLines(maxLines).setEllipsize(TextUtils.TruncateAt.END).build().height.toFloat()
  }

  // ---- shapes ----

  fun fillRect(rect: RectF, radius: Float, color: Int) {
    paint.reset(); paint.isAntiAlias = true
    paint.style = Paint.Style.FILL
    paint.color = color
    canvas.drawRoundRect(rect, radius, radius, paint)
  }

  fun fillGradient(rect: RectF, radius: Float, top: Int, bottom: Int) {
    paint.reset(); paint.isAntiAlias = true
    paint.shader = LinearGradient(rect.left, rect.top, rect.left, rect.bottom, top, bottom, Shader.TileMode.CLAMP)
    canvas.drawRoundRect(rect, radius, radius, paint)
  }

  /** A border drawn inside the rect, like SwiftUI's `strokeBorder`. */
  fun borderRect(rect: RectF, radius: Float, width: Float, color: Int) {
    paint.reset(); paint.isAntiAlias = true
    paint.style = Paint.Style.STROKE
    paint.strokeWidth = width
    paint.color = color
    val inner = RectF(rect.left + width / 2, rect.top + width / 2, rect.right - width / 2, rect.bottom - width / 2)
    canvas.drawRoundRect(inner, max(0f, radius - width / 2), max(0f, radius - width / 2), paint)
  }

  fun circle(cx: Float, cy: Float, radius: Float, color: Int) {
    paint.reset(); paint.isAntiAlias = true
    paint.color = color
    canvas.drawCircle(cx, cy, radius, paint)
  }

  fun hline(x1: Float, x2: Float, y: Float, width: Float, color: Int, dash: FloatArray? = null) {
    paint.reset(); paint.isAntiAlias = true
    paint.style = Paint.Style.STROKE
    paint.strokeWidth = width
    paint.color = color
    if (dash != null) paint.pathEffect = android.graphics.DashPathEffect(dash, 0f)
    canvas.drawLine(x1, y, x2, y, paint)
  }

  fun fillPath(path: Path, color: Int, alpha: Float = 1f) {
    paint.reset(); paint.isAntiAlias = true
    paint.color = color
    paint.alpha = (alpha * 255).toInt()
    canvas.drawPath(path, paint)
  }

  fun fillPathGradient(path: Path, top: Float, bottom: Float, from: Int, to: Int) {
    paint.reset(); paint.isAntiAlias = true
    paint.shader = LinearGradient(0f, top, 0f, bottom, from, to, Shader.TileMode.CLAMP)
    canvas.drawPath(path, paint)
  }

  fun strokePath(path: Path, width: Float, color: Int) {
    paint.reset(); paint.isAntiAlias = true
    paint.style = Paint.Style.STROKE
    paint.strokeWidth = width
    paint.color = color
    paint.strokeJoin = Paint.Join.ROUND
    canvas.drawPath(path, paint)
  }

  /** A ring arc whose visible stroke, round caps included, spans exactly 0…progress. */
  fun ringArc(cx: Float, cy: Float, radius: Float, lineWidth: Float, progress: Double, color: Int) {
    if (progress <= 0.0005 || radius <= 0) return
    paint.reset(); paint.isAntiAlias = true
    paint.style = Paint.Style.STROKE
    paint.strokeWidth = lineWidth
    paint.color = color
    val oval = RectF(cx - radius, cy - radius, cx + radius, cy + radius)
    if (progress >= 0.9995) {
      paint.strokeCap = Paint.Cap.BUTT
      canvas.drawArc(oval, -90f, 360f, false, paint)
      return
    }
    paint.strokeCap = Paint.Cap.ROUND
    val cap = Math.toDegrees((lineWidth / 2 / radius).toDouble()).toFloat()
    val sweep = max(0.01f, (360 * progress).toFloat() - 2 * cap)
    canvas.drawArc(oval, -90f + cap, sweep, false, paint)
  }

  fun ringTrack(cx: Float, cy: Float, radius: Float, lineWidth: Float, color: Int) {
    paint.reset(); paint.isAntiAlias = true
    paint.style = Paint.Style.STROKE
    paint.strokeWidth = lineWidth
    paint.color = color
    canvas.drawCircle(cx, cy, radius, paint)
  }

  /** The inset shadow of a glass well: darker along the top edge, fading inward. */
  fun innerShadow(rect: RectF, radius: Float, color: Int, dy: Float, blur: Float) {
    canvas.save()
    canvas.clipPath(Path().apply { addRoundRect(rect, radius, radius, Path.Direction.CW) })
    val ring = Path().apply {
      fillType = Path.FillType.EVEN_ODD
      addRect(RectF(rect.left - 20, rect.top - 20, rect.right + 20, rect.bottom + 20), Path.Direction.CW)
      addRoundRect(RectF(rect.left, rect.top + dy, rect.right, rect.bottom + dy), radius, radius, Path.Direction.CW)
    }
    paint.reset(); paint.isAntiAlias = true
    paint.color = color
    paint.maskFilter = android.graphics.BlurMaskFilter(blur, android.graphics.BlurMaskFilter.Blur.NORMAL)
    canvas.drawPath(ring, paint)
    canvas.restore()
  }

  /** A soft colored blob: the glow under a tinted tube and the backdrop's corner lights. */
  fun glow(cx: Float, cy: Float, radiusX: Float, radiusY: Float, center: Int, blur: Float = 0f) {
    paint.reset(); paint.isAntiAlias = true
    val clear = center and 0x00FFFFFF
    paint.shader = RadialGradient(0f, 0f, radiusX, intArrayOf(center, clear), null, Shader.TileMode.CLAMP)
    if (blur > 0) paint.maskFilter = android.graphics.BlurMaskFilter(blur, android.graphics.BlurMaskFilter.Blur.NORMAL)
    canvas.save()
    canvas.translate(cx, cy)
    canvas.scale(1f, radiusY / radiusX)
    canvas.drawCircle(0f, 0f, radiusX, paint)
    canvas.restore()
  }

  /** Runs `block` with everything drawn in it at `alpha`. */
  inline fun faded(alpha: Float, bounds: RectF, block: () -> Unit) {
    if (alpha >= 1f) return block()
    val layer = canvas.saveLayerAlpha(bounds.left, bounds.top, bounds.right, bounds.bottom, (alpha * 255).toInt())
    block()
    canvas.restoreToCount(layer)
  }

  inline fun clipped(rect: RectF, radius: Float, block: () -> Unit) {
    canvas.save()
    val path = Path().apply { addRoundRect(rect, radius, radius, Path.Direction.CW) }
    canvas.clipPath(path)
    block()
    canvas.restore()
  }

  // ---- logos ----

  /** A harness logo in `color`, or a monogram in a rounded outline when there is none. */
  fun logo(logo: String?, monogram: String, x: Float, y: Float, size: Float, color: Int) {
    val data = WidgetLogos.paths[logo]
    if (logo != "kimi" && data == null) {
      val outline = RectF(x, y, x + size, y + size)
      borderRect(outline, size * 0.25f, 1f, color)
      val style = TextStyle(size * 0.7f, color, Weight.Semibold)
      val letter = monogram.take(1)
      text(letter, x, y + (size - lineHeight(style)) / 2, style, size, Align.Center)
      return
    }
    if (logo == "kimi") {
      // The Kimi mark is an outlined square with a "K", as in the asset catalog.
      val frame = RectF(x + size * 2.5f / 24, y + size * 2.5f / 24, x + size * 21.5f / 24, y + size * 21.5f / 24)
      borderRect(frame, size * 5f / 24, max(1f, size * 1.6f / 24), color)
      val style = TextStyle(size * 11f / 24, color, Weight.Semibold)
      text("K", x, y + (size - lineHeight(style)) / 2, style, size, Align.Center)
      return
    }
    paint.reset(); paint.isAntiAlias = true
    paint.color = color
    val path = Path(logoPath(data ?: return))
    val scale = size / 24f
    val matrix = android.graphics.Matrix().apply { postScale(scale, scale); postTranslate(x, y) }
    path.transform(matrix)
    canvas.drawPath(path, paint)
  }

  /** The Cindy mark for empty states. */
  fun cindyMark(x: Float, y: Float, size: Float, color: Int) {
    logo("cindy", "C", x, y, size, color)
  }

  companion object {
    private val faceCache = HashMap<Int, Typeface>()
    private val pathCache = HashMap<String, Path>()

    fun systemFace(weight: Weight): Typeface = faceCache.getOrPut(weight.value) {
      if (Build.VERSION.SDK_INT >= 28) Typeface.create(Typeface.DEFAULT, weight.value, false)
      else Typeface.create(Typeface.DEFAULT, if (weight.value >= 600) Typeface.BOLD else Typeface.NORMAL)
    }

    class Fonts(val medium: Typeface, val semibold: Typeface)

    @Volatile private var fontCache: Fonts? = null

    fun fonts(context: Context): Fonts = fontCache ?: synchronized(this) {
      fontCache ?: run {
        fun load(name: String, fallback: Weight) = try {
          Typeface.createFromAsset(context.assets, "usage-widgets/$name")
        } catch (_: Exception) {
          systemFace(fallback)
        }
        Fonts(load("BarlowCondensed-Medium.ttf", Weight.Medium), load("BarlowCondensed-SemiBold.ttf", Weight.Semibold))
      }.also { fontCache = it }
    }

    private fun logoPath(data: String): Path = pathCache.getOrPut(data) { PathParser.createPathFromPathData(data) ?: Path() }
  }
}
