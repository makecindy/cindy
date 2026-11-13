package app.cindy.usagewidgets

import android.graphics.Path
import android.graphics.RectF
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sqrt

/**
 * How a day's value is split: by model when the computer sends a model series (busiest first, the
 * rest last), otherwise by harness like the Mac chart (Codex, Claude Code, Pi).
 */
class UsageBreakdown(snapshot: WidgetSnapshot?, val money: Boolean) {
  /** Series keys in stacking order, bottom to top. */
  val keys: List<Int>
  private val models: List<WidgetModel>?

  init {
    val named = snapshot?.usage?.models
    if (named != null && named.isNotEmpty() &&
      snapshot.usage.daily.all { it.models?.size == named.size + 1 && it.modelTokens?.size == named.size + 1 }
    ) {
      models = named
      keys = (0..named.size).toList()
    } else {
      models = null
      keys = listOf(1, 0, 2)
    }
  }

  fun value(day: WidgetDay, key: Int): Double = when {
    models != null && money -> day.models?.getOrNull(key) ?: 0.0
    models != null -> day.modelTokens?.getOrNull(key) ?: 0.0
    money -> day.money.getOrNull(key) ?: 0.0
    else -> day.tokens.getOrNull(key) ?: 0.0
  }

  fun total(day: WidgetDay): Double = if (money) day.total else day.totalTokens

  fun amount(value: Double, format: WidgetFormat): String = if (money) format.money(value) else format.tokens(value)

  fun label(key: Int, format: WidgetFormat): String {
    val named = models ?: return format.s("harness.${listOf("claude-code", "codex", "pi")[key]}")
    return if (key < named.size) named[key].name else format.text("other")
  }

  fun color(key: Int, palette: WidgetPalette): Int {
    val named = models ?: return palette.harness(key)
    return if (key >= named.size) palette.otherModel else palette.model(key)
  }

  /** Non-zero parts of `total(key)`, largest first; beyond `limit` the smallest merge into one "other" row (key -1). */
  fun ranked(limit: Int, total: (Int) -> Double): List<Pair<Int, Double>> {
    val rows = keys.map { it to total(it) }.filter { it.second > 0 }.sortedByDescending { it.second }
    if (rows.size <= limit) return rows
    return rows.take(limit - 1) + (-1 to rows.drop(limit - 1).sumOf { it.second })
  }

  fun rowLabel(key: Int, format: WidgetFormat): String = if (key < 0) format.text("other") else label(key, format)

  fun rowColor(key: Int, palette: WidgetPalette): Int = if (key < 0) palette.otherModel else color(key, palette)
}

/** Monotone cubic through the points (no overshoot), like Swift Charts' `.monotone`. */
fun monotonePath(points: List<Pair<Float, Float>>, into: Path, move: Boolean) {
  val n = points.size
  if (n < 2) return
  val dx = FloatArray(n - 1)
  val m = FloatArray(n - 1)
  for (i in 0 until n - 1) {
    dx[i] = points[i + 1].first - points[i].first
    m[i] = if (dx[i] == 0f) 0f else (points[i + 1].second - points[i].second) / dx[i]
  }
  val t = FloatArray(n)
  t[0] = m[0]
  t[n - 1] = m[n - 2]
  if (n > 2) for (i in 1 until n - 1) t[i] = if (m[i - 1] * m[i] <= 0) 0f else (m[i - 1] + m[i]) / 2
  for (i in 0 until n - 1) {
    if (m[i] == 0f) {
      t[i] = 0f
      t[i + 1] = 0f
      continue
    }
    val a = t[i] / m[i]
    val b = t[i + 1] / m[i]
    val s = a * a + b * b
    if (s > 9) {
      val k = 3 / sqrt(s)
      t[i] = k * a * m[i]
      t[i + 1] = k * b * m[i]
    }
  }
  if (move) into.moveTo(points[0].first, points[0].second) else into.lineTo(points[0].first, points[0].second)
  for (i in 0 until n - 1) {
    val h = dx[i] / 3
    into.cubicTo(
      points[i].first + h, points[i].second + h * t[i],
      points[i + 1].first - h, points[i + 1].second - h * t[i + 1],
      points[i + 1].first, points[i + 1].second,
    )
  }
}

/** The month card's stacked area with the total line. */
fun WidgetPainter.stackedArea(daily: List<WidgetDay>, breakdown: UsageBreakdown, area: RectF) {
  val n = daily.size
  if (n < 2) return
  val layers = ArrayList<DoubleArray>()
  layers.add(DoubleArray(n))
  for (key in breakdown.keys) {
    val previous = layers.last()
    layers.add(DoubleArray(n) { previous[it] + breakdown.value(daily[it], key) })
  }
  val maxTotal = max(layers.last().max(), 0.0001) * 1.08
  fun point(layer: DoubleArray, i: Int) = Pair(
    area.left + i.toFloat() / (n - 1) * area.width(),
    area.bottom - (layer[i] / maxTotal).toFloat() * area.height(),
  )
  breakdown.keys.forEachIndexed { k, key ->
    val path = Path()
    monotonePath((0 until n).map { point(layers[k + 1], it) }, path, move = true)
    monotonePath((n - 1 downTo 0).map { point(layers[k], it) }, path, move = false)
    path.close()
    val color = breakdown.color(key, palette)
    fillPathGradient(path, area.top, area.bottom, withAlpha(color, 0.95f), withAlpha(color, 0.55f))
  }
  val line = Path()
  monotonePath((0 until n).map { point(layers.last(), it) }, line, move = true)
  strokePath(line, 1f, withAlpha(palette.ink, 0.55f))
}

/** Daily stacked bars: today solid, earlier days at 60% (the usage-history emphasis rule). */
fun WidgetPainter.dailyBars(daily: List<WidgetDay>, breakdown: UsageBreakdown, area: RectF, gap: Float, average: Double? = null) {
  val n = max(daily.size, 1)
  val barWidth = max(1f, (area.width() - gap * (n - 1)) / n)
  val maxTotal = max(max(daily.maxOfOrNull { breakdown.total(it) } ?: 0.0, average ?: 0.0), 0.0001) * 1.08
  daily.forEachIndexed { i, day ->
    val x = area.left + i * (barWidth + gap)
    val dayTotal = breakdown.total(day)
    if (dayTotal <= 0) {
      fillRect(RectF(x, area.bottom - 2, x + barWidth, area.bottom), 1f, palette.ink4)
      return@forEachIndexed
    }
    val height = max(3f, (dayTotal / maxTotal).toFloat() * area.height())
    val bar = RectF(x, area.bottom - height, x + barWidth, area.bottom)
    val round = min(2f, barWidth / 2)
    val alpha = if (i == daily.size - 1) 1f else 0.6f
    faded(alpha, RectF(bar.left - 1, bar.top - 1, bar.right + 1, bar.bottom + 1)) {
      canvas.save()
      canvas.clipPath(Path().apply {
        addRoundRect(bar, floatArrayOf(round, round, round, round, 0f, 0f, 0f, 0f), Path.Direction.CW)
      })
      var top = bar.top
      for (key in breakdown.keys.reversed()) {
        val value = breakdown.value(day, key)
        if (value <= 0) continue
        val part = (value / dayTotal).toFloat() * height
        fillRect(RectF(bar.left, top, bar.right, top + part), 0f, breakdown.color(key, palette))
        top += part
      }
      canvas.restore()
    }
  }
  if (average != null && average > 0) {
    val y = area.bottom - (average / maxTotal).toFloat() * area.height()
    hline(area.left, area.right, y, 1f, palette.ink2, floatArrayOf(2f, 3f))
  }
}

fun withAlpha(color: Int, alpha: Float): Int =
  (color and 0x00FFFFFF) or ((((color ushr 24) * alpha).toInt().coerceIn(0, 255)) shl 24)
