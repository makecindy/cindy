package app.cindy.entrywidget

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Typeface

/**
 * 桌面图标。头像 PNG 裁成圆形；只有字时按背景色画一个圆形底色 —— 与设置页里那套
 * 「头像优先、取不到就画字」的规则一致，桌面因此在离线时也不会出现空白方块。
 */
internal object EntryIcons {
  private const val SIZE = 192

  fun decode(bytes: ByteArray): Bitmap? = BitmapFactory.decodeByteArray(bytes, 0, bytes.size)?.let(::circle)

  fun glyph(text: String, background: String): Bitmap? {
    if (text.isEmpty()) return null
    val color = color(background) ?: DEFAULT_BACKGROUND
    val bitmap = Bitmap.createBitmap(SIZE, SIZE, Bitmap.Config.ARGB_8888)
    val canvas = Canvas(bitmap)
    val radius = SIZE / 2f
    canvas.drawCircle(radius, radius, radius, Paint(Paint.ANTI_ALIAS_FLAG).apply { this.color = color })
    val ink = if (luminance(color) > 0.6) Color.BLACK else Color.WHITE
    val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
      this.color = ink
      textAlign = Paint.Align.CENTER
      textSize = SIZE * 0.46f
      typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
    }
    // JS 已经按用户看到的字符切好了一段（ZWJ emoji 也是完整的），这里原样画整段 ——
    // 再按 code point 截断就会把 `👨‍👩‍👧` 画成 `👨‍`，桌面显示的不再是用户选的头像。
    // 万一更长，按可用宽度缩字号，而不是切字。
    val available = SIZE * 0.86f
    val width = paint.measureText(text)
    if (width > available) paint.textSize = paint.textSize * available / width
    val metrics = paint.fontMetrics
    canvas.drawText(text, radius, radius - (metrics.ascent + metrics.descent) / 2f, paint)
    return bitmap
  }

  private fun circle(source: Bitmap): Bitmap {
    val side = minOf(source.width, source.height).coerceAtLeast(1)
    val square = Bitmap.createBitmap(source, (source.width - side) / 2, (source.height - side) / 2, side, side)
    val scaled = Bitmap.createScaledBitmap(square, SIZE, SIZE, true)
    val output = Bitmap.createBitmap(SIZE, SIZE, Bitmap.Config.ARGB_8888)
    val canvas = Canvas(output)
    val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
      shader = android.graphics.BitmapShader(scaled, android.graphics.Shader.TileMode.CLAMP, android.graphics.Shader.TileMode.CLAMP)
    }
    val radius = SIZE / 2f
    canvas.drawCircle(radius, radius, radius, paint)
    if (scaled !== square) scaled.recycle()
    if (square !== source) square.recycle()
    if (output !== source) source.recycle()
    return output
  }

  private fun luminance(color: Int): Double =
    0.2126 * Color.red(color) / 255.0 + 0.7152 * Color.green(color) / 255.0 + 0.0722 * Color.blue(color) / 255.0

  private fun color(value: String): Int? {
    val text = value.trim()
    if (!text.startsWith("#")) return null
    return runCatching { Color.parseColor(text) }.getOrNull()
  }

  private const val DEFAULT_BACKGROUND = 0xFF2C2C2A.toInt()
}
