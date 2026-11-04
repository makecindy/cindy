package app.cindy.usagewidgets

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Path
import android.graphics.RectF
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

enum class WidgetKind { Quota, Usage }

enum class WidgetFamily(val refWidth: Float, val refHeight: Float) {
  /** One launcher row (Android only; iOS has no equivalent): the sources side by side, tube beside its numbers. */
  Strip(110f, 48f), Small(158f, 158f), Medium(338f, 158f), Large(338f, 354f);

  companion object {
    /** Which iOS layout a launcher cell grid is closest to; a single row gets the strip. */
    fun of(widthDp: Float, heightDp: Float): WidgetFamily = when {
      // One launcher row is 40–110dp tall depending on the launcher. Wide enough for the sources to sit side by
      // side (four fit from about 260dp), the strip beats a shrunk tile; a narrower row keeps the shrunk Small tile.
      heightDp < 120f && widthDp >= 250f && widthDp >= heightDp * 1.4f -> Strip
      widthDp < 220f -> Small
      heightDp >= 240f -> Large
      else -> Medium
    }
  }
}

/**
 * Draws the quota and daily usage widgets as bitmaps, laid out like the iOS widgets: the same
 * three layouts at the iOS point sizes, scaled down uniformly when the launcher cell is smaller
 * and stretched through the flexible spaces when it is larger.
 */
object WidgetRenderer {
  fun render(
    context: Context, kind: WidgetKind, state: WidgetState, widthDp: Float, heightDp: Float, density: Float, dark: Boolean,
    nowMs: Long = System.currentTimeMillis(), family: WidgetFamily = WidgetFamily.of(widthDp, heightDp),
    pinnedCount: Int = 0,
  ): Bitmap {
    val pxWidth = max(1, (widthDp * density).roundToInt())
    val pxHeight = max(1, (heightDp * density).roundToInt())
    val bitmap = Bitmap.createBitmap(pxWidth, pxHeight, Bitmap.Config.ARGB_8888)
    val canvas = Canvas(bitmap)
    // Smaller than the iOS size in either direction: shrink everything together; never enlarge.
    val scale = min(1f, min(widthDp / family.refWidth, heightDp / family.refHeight))
    val width = widthDp / scale
    val height = heightDp / scale
    canvas.scale(density * scale, density * scale)
    val palette = WidgetPalette(dark)
    val painter = WidgetPainter(context, canvas, palette)
    val corner = cornerRadiusDp(context) / scale
    drawBackdrop(painter, palette, width, height, corner)
    canvas.clipPath(Path().apply { addRoundRect(RectF(0f, 0f, width, height), corner, corner, Path.Direction.CW) })
    val scene = Scene(painter, palette, WidgetFormat(context, state.snapshotOrNull, nowMs), width, height, family, pinnedCount)
    when (kind) {
      WidgetKind.Quota -> scene.quota(state)
      WidgetKind.Usage -> scene.usage(state)
    }
    return bitmap
  }

  private fun cornerRadiusDp(context: Context): Float {
    val fallback = 22f
    if (android.os.Build.VERSION.SDK_INT < 31) return fallback
    return try {
      context.resources.getDimension(android.R.dimen.system_app_widget_background_radius) / context.resources.displayMetrics.density
    } catch (_: Exception) {
      fallback
    }
  }

  /** Warm tint with the panel's faint Heart Orange glow in the top-left corner. */
  private fun drawBackdrop(p: WidgetPainter, pal: WidgetPalette, width: Float, height: Float, corner: Float) {
    p.fillRect(RectF(0f, 0f, width, height), corner, pal.background)
    p.clipped(RectF(0f, 0f, width, height), corner) {
      p.glow(0f, 0f, 240f, 240f, pal.glow)
      p.glow(width, height * 0.18f, 220f, 220f, pal.glow2)
    }
  }

  private class Scene(
    val p: WidgetPainter, val pal: WidgetPalette, val f: WidgetFormat, val w: Float, val h: Float, val family: WidgetFamily,
    /** Leading sources the widget's settings placed first; the narrow layouts keep them as placed. */
    val pinnedCount: Int = 0,
  ) {
    fun sys(size: Float, color: Int, weight: Weight = Weight.Regular) = TextStyle(size, color, weight)
    fun num(size: Float, color: Int, weight: Weight = Weight.Semibold) = TextStyle(size, color, weight, barlow = true)

    // ---------------------------------------------------------------- shared pieces

    fun empty(title: String, body: String, pad: Float = 16f) {
      if (family == WidgetFamily.Strip) {
        val style = sys(13f, pal.ink, Weight.Semibold)
        p.cindyMark(12f, (h - 16f) / 2, 16f, pal.ink3)
        p.fitText(title, 36f, (h - p.lineHeight(style)) / 2, style, w - 48f)
        return
      }
      p.cindyMark(pad, pad, 16f, pal.ink3)
      val bodyStyle = sys(12f, pal.ink3)
      val titleStyle = sys(15f, pal.ink, Weight.Semibold)
      val width = w - 2 * pad
      val bodyHeight = p.paragraphHeight(body, width, bodyStyle, 3)
      val bodyTop = h - pad - bodyHeight
      p.text(title, pad, bodyTop - 3 - p.lineHeight(titleStyle), titleStyle)
      p.paragraph(body, pad, bodyTop, width, bodyStyle, 3)
    }

    /** Orange "updated 7 hours ago" line, shown only when the readings are old. */
    fun staleLine(text: String, x: Float, y: Float, width: Float): Float {
      val style = sys(11f, pal.warn, Weight.Medium)
      p.fitText(text, x, y, style, width)
      return p.lineHeight(style)
    }

    /** The Mac panel's glass tube, without motion: widgets are still snapshots. */
    fun tube(s: WidgetSource, x: Float, y: Float, width: Float, height: Float) {
      val inset = 3f
      val radius = min(13f, width / 2)
      val rect = RectF(x, y, x + width, y + height)
      val fraction = s.fill.coerceIn(0.0, 1.0).toFloat()
      val tint = pal.level(s.level)
      val bounds = RectF(x - 30, y - 20, x + width + 30, y + height + 30)
      p.faded(if (s.stale) 0.45f else 1f, bounds) {
        if (tint != null && fraction > 0) p.glow(x + width / 2, y + height, 17f, 7f, withAlpha(tint, 0.5f * 0.45f), blur = 4f)
        p.fillGradient(rect, radius, pal.wellTop, pal.wellBottom)
        p.innerShadow(rect, radius, pal.wellShade, dy = 1f, blur = 1.5f)
        val well = RectF(x + inset, y + inset, x + width - inset, y + height - inset)
        if (s.reserve) {
          p.clipped(well, max(0f, radius - inset)) {
            val hatch = Path()
            var hx = -well.height()
            while (hx < well.width()) {
              hatch.moveTo(well.left + hx, well.bottom)
              hatch.lineTo(well.left + hx + well.height(), well.top)
              hx += 7f
            }
            p.strokePath(hatch, 2f, pal.ink4)
          }
        }
        val liquid = if (fraction > 0) max(3f, fraction * well.height()) else 0f
        if (liquid > 0) {
          p.clipped(well, max(0f, radius - inset)) {
            // The surface's corners are softly rounded (4dp, less for a very low level) rather
            // than a hard flat edge, as on iPhone; the well's rounded bottom still shapes low levels.
            val surface = min(4f, liquid / 2)
            val shape = Path().apply {
              addRoundRect(
                RectF(well.left, well.bottom - liquid, well.right, well.bottom),
                floatArrayOf(surface, surface, surface, surface, 0f, 0f, 0f, 0f),
                Path.Direction.CW,
              )
            }
            p.fillPath(shape, tint ?: pal.plenty)
          }
        }
        if (s.emphasized) p.borderRect(rect, radius, 1f, pal.ink2) else p.borderRect(rect, radius, 0.5f, pal.ink4)
      }
    }

    /** Number above the tube; it keeps its ink at every level, the liquid alone carries the quota color. */
    fun sourceValue(s: WidgetSource, x: Float, bottom: Float, width: Float, size: Float, unitSize: Float) {
      val value = s.value
      if (value == null) {
        val style = sys(10.5f, pal.ink2, Weight.Semibold)
        p.fitText(s.label ?: "—", x, bottom - p.lineHeight(style), style, width, Align.Center, minScale = 0.8f)
        return
      }
      val numSize = if (s.kind == "balance") size - 2 else size
      val ink = if (s.stale) withAlpha(pal.ink, 0.5f) else pal.ink
      val unit = s.unit
      var scale = 1f
      val natural = p.textWidth(value, num(numSize, ink)) + (if (unit != null) 1f + p.textWidth(unit, num(unitSize, ink)) else 0f)
      if (natural > width) scale = max(0.7f, width / natural)
      val numStyle = num(numSize * scale, ink)
      val unitStyle = num(unitSize * scale, if (s.stale) withAlpha(pal.ink3, 0.5f) else pal.ink3)
      val total = p.textWidth(value, numStyle) + (if (unit != null) 1f + p.textWidth(unit, unitStyle) else 0f)
      val left = x + (width - total) / 2
      val baseline = bottom - p.lineHeight(numStyle) + p.ascent(numStyle)
      p.textAt(value, left, baseline, numStyle)
      if (unit != null) p.textAt(unit, left + p.textWidth(value, numStyle) + 1f, baseline, unitStyle)
    }

    /** Reset time under a tube; it colors only when quota will go unused at the reset. */
    fun sourceWhen(text: String, level: String, size: Float, x: Float, y: Float, width: Float) {
      val style = sys(size, pal.level(level) ?: pal.ink2, Weight.Medium)
      p.fitText(text, x, y, style, width, Align.Center)
    }

    fun columnHeight(valueSize: Float, nameSize: Float, whenSize: Float, stacked: Boolean): Float {
      val nameStyle = sys(nameSize, pal.ink2)
      val nameBlock = if (stacked) nameSize + 1.5f + 4f + p.lineHeight(nameStyle) else max(10f, p.lineHeight(nameStyle))
      return valueSize + 2f + (if (stacked) 6f else 4f) + (if (stacked) 8f else 6f) + nameBlock +
        (if (stacked) 3f else 1f) + p.lineHeight(sys(whenSize, pal.ink2, Weight.Medium))
    }

    fun column(
      s: WidgetSource, x: Float, top: Float, width: Float, tubeWidth: Float, tubeHeight: Float,
      valueSize: Float, unitSize: Float, nameSize: Float = 10.5f, whenSize: Float = 10f, stacked: Boolean = false, coarseWhen: Boolean = false,
    ) {
      var y = top
      sourceValue(s, x, y + valueSize + 2f, width, valueSize, unitSize)
      y += valueSize + 2f + (if (stacked) 6f else 4f)
      tube(s, x + (width - tubeWidth) / 2, y, tubeWidth, tubeHeight)
      y += tubeHeight + (if (stacked) 8f else 6f)
      val nameStyle = sys(nameSize, pal.ink2)
      if (stacked) {
        val logo = nameSize + 1.5f
        p.logo(s.logo, s.monogram, x + (width - logo) / 2, y, logo, pal.ink)
        y += logo + 4f
        p.fitText(s.name, x + 2, y, nameStyle, width - 4, Align.Center)
        y += p.lineHeight(nameStyle)
      } else {
        val textWidth = min(p.textWidth(s.name, nameStyle), width - 13f)
        val left = x + (width - (10f + 3f + textWidth)) / 2
        val rowHeight = max(10f, p.lineHeight(nameStyle))
        p.logo(s.logo, s.monogram, left, y + (rowHeight - 10f) / 2, 10f, pal.ink)
        p.fitText(s.name, left + 13f, y + (rowHeight - p.lineHeight(nameStyle)) / 2, nameStyle, textWidth)
        y += rowHeight
      }
      y += if (stacked) 3f else 1f
      sourceWhen(f.whenText(s, coarseWhen), f.resetLevel(s), whenSize, x, y, width)
    }

    /** A row of columns, bottom-anchored between `top` and `bottom`; the tube takes the spare height. */
    fun columns(
      list: List<WidgetSource>, left: Float, right: Float, top: Float, bottom: Float, gap: Float,
      tubeWidth: Float, tubeHeight: Float, maxTubeHeight: Float, valueSize: Float, unitSize: Float,
      nameSize: Float, whenSize: Float, stacked: Boolean, coarseWhen: Boolean,
    ) {
      val fixed = columnHeight(valueSize, nameSize, whenSize, stacked)
      val tubeH = (bottom - top - fixed).coerceIn(min(tubeHeight, 32f), min(maxTubeHeight, tubeWidth * 8))
      val colWidth = (right - left - gap * (list.size - 1)) / list.size
      // Taller than the tubes can sensibly grow (a tall, narrow cell): center the block instead of leaving the top empty.
      val blockTop = top + max(0f, (bottom - top - fixed - tubeH) / 2)
      list.forEachIndexed { i, s ->
        column(s, left + i * (colWidth + gap), blockTop, colWidth, tubeWidth, tubeH, valueSize, unitSize, nameSize, whenSize, stacked, coarseWhen)
      }
    }

    // ---------------------------------------------------------------- quota widget

    fun quota(state: WidgetState) {
      when (state) {
        is WidgetState.UpdateDesktop -> empty(f.text("updateTitle"), f.text("updateBody"))
        is WidgetState.Empty -> empty(f.text("emptyTitle"), f.text("emptyBody"))
        is WidgetState.Snapshot -> {
          val snapshot = state.snapshot
          val sources = snapshot.sources
          val single = sources.singleOrNull()?.detail
          when {
            sources.isEmpty() -> empty(f.text("noSources"), f.text("emptyBody"))
            single != null -> singleSource(sources[0], single)
            else -> quotaColumns(sources)
          }
        }
      }
    }

    /** One row: each source is a short tube with its number, name and reset time stacked beside it. */
    private fun quotaStrip(sources: List<WidgetSource>) {
      val pool = subscriptionsFirst(sources)
      val pad = 10f
      val count = ((w - 2 * pad) / 66f).toInt().coerceIn(1, 6).coerceAtMost(pool.size)
      val list = pool.take(count)
      val colWidth = (w - 2 * pad) / list.size
      val valueStyle = num(17f, pal.ink)
      val nameStyle = sys(9.5f, pal.ink2)
      val whenStyle = sys(9.5f, pal.ink2, Weight.Medium)
      val stack = p.lineHeight(valueStyle) + p.lineHeight(nameStyle) + p.lineHeight(whenStyle)
      val tubeHeight = min(h - 12f, max(30f, stack))
      val top = (h - tubeHeight) / 2
      list.forEachIndexed { i, s ->
        val x = pad + i * colWidth
        tube(s, x + 2, top, 12f, tubeHeight)
        val tx = x + 2 + 12f + 7f
        val width = colWidth - (tx - x) - 2f
        var y = (h - stack) / 2
        val value = s.value
        if (value != null) {
          val ink = if (s.stale) withAlpha(pal.ink, 0.5f) else pal.ink
          val numStyle = num(if (s.kind == "balance") 15f else 17f, ink)
          val unit = s.unit
          val unitStyle = num(10f, pal.ink3)
          val baseline = y + p.ascent(numStyle)
          p.textAt(value, tx, baseline, numStyle)
          if (unit != null) p.textAt(unit, tx + p.textWidth(value, numStyle) + 1f, baseline, unitStyle)
        } else {
          p.fitText(s.label ?: "—", tx, y, sys(10.5f, pal.ink2, Weight.Semibold), width)
        }
        y += p.lineHeight(valueStyle)
        p.fitText(s.name, tx, y, nameStyle, width)
        y += p.lineHeight(nameStyle)
        p.fitText(f.whenText(s, coarse = true), tx, y, sys(9.5f, pal.level(f.resetLevel(s)) ?: pal.ink2, Weight.Medium), width)
      }
    }

    /**
     * The narrow layouts' pick: accounts the widget placed first as placed, then subscriptions
     * (the Cindy balance is not a subscription), or every other source when there are none.
     */
    private fun subscriptionsFirst(sources: List<WidgetSource>): List<WidgetSource> {
      val rest = sources.drop(pinnedCount)
      val subscriptions = rest.filter { it.kind == "subscription" }
      return sources.take(pinnedCount) + (if (subscriptions.isEmpty()) rest else subscriptions)
    }

    private fun quotaColumns(sources: List<WidgetSource>) {
      when (family) {
        WidgetFamily.Strip -> quotaStrip(sources)
        WidgetFamily.Small -> {
          val list = subscriptionsFirst(sources).take(4)
          val stale = f.staleLabel(6.0)
          var top = 13f
          if (stale != null) top += staleLine(stale, 8f, 13f, w - 16f) + 4f
          columns(list, 8f, w - 8f, top, h - 12f, 0f, 22f, if (stale == null) 62f else 44f, 400f, 16f, 9.5f, 10f, 10f, stacked = true, coarseWhen = true)
        }
        WidgetFamily.Large -> {
          val list = sources.take(7)
          val stale = f.staleLabel(6.0) != null
          val update = sys(11f, if (stale) pal.warn else pal.ink3, if (stale) Weight.Medium else Weight.Regular)
          p.fitText(f.updatedLabel(), 14f, 16f, update, w - 28f, Align.End)
          val card = monthCardHeight()
          val top = 16f + p.lineHeight(update) + 10f
          columns(list, 14f, w - 14f, top, h - 14f - card - 8f, if (list.size > 6) 2f else 4f, 38f, 100f, 400f, 20f, 12f, 10.5f, 10.5f, stacked = true, coarseWhen = false)
          monthCard(f.snapshot, 14f, h - 14f - card, w - 28f, card)
        }
        WidgetFamily.Medium -> {
          val list = sources.take(6)
          val stale = f.staleLabel(6.0)
          var top = 14f
          if (stale != null) top += staleLine(stale, 16f, 14f, w - 32f) + 4f
          columns(list, 12f, w - 12f, top, h - 12f, 0f, 28f, if (stale == null) 72f else 54f, 400f, 18f, 11f, 10.5f, 10f, stacked = false, coarseWhen = false)
        }
      }
    }

    // ---------------------------------------------------------------- month card

    fun monthCardHeight(): Float = 18f + max(28f, p.lineHeight(sys(10.5f, pal.ink3)) + p.lineHeight(num(22f, pal.ink)))

    /** "Last 30 days · All devices" total with the stacked area chart, as on the Mac panel. */
    fun monthCard(snapshot: WidgetSnapshot?, x: Float, y: Float, width: Float, height: Float) {
      val daily = snapshot?.usage?.daily ?: emptyList()
      val total = daily.sumOf { it.total }
      val card = RectF(x, y, x + width, y + height)
      p.fillRect(card, 14f, pal.tile)
      p.borderRect(card, 14f, 0.5f, pal.line)
      val label = f.s(if (snapshot?.usage?.scope == "local") "monthScopeLocal" else "monthScopeAll")
      val labelStyle = sys(10.5f, pal.ink3)
      val money = f.money(total)
      val moneyStyle = num(22f, pal.ink)
      val textWidth = max(p.textWidth(label, labelStyle), p.textWidth(money, moneyStyle))
      val textHeight = p.lineHeight(labelStyle) + p.lineHeight(moneyStyle)
      val textTop = y + (height - textHeight) / 2
      p.fitText(label, x + 12, textTop, labelStyle, textWidth + 1)
      p.fitText(money, x + 12, textTop + p.lineHeight(labelStyle), moneyStyle, textWidth + 1)
      val chartLeft = x + 12 + textWidth + 12
      val chart = RectF(chartLeft, y + (height - 28f) / 2, x + width - 12, y + (height + 28f) / 2)
      if (chart.width() > 20) p.stackedArea(daily, UsageBreakdown(snapshot, true), chart)
    }

    // ---------------------------------------------------------------- single source

    private fun detailHeader(s: WidgetSource, d: WidgetDetail, x: Float, y: Float, width: Float, size: Float = 13f): Float {
      val title = sys(size, pal.ink, Weight.Semibold)
      val plan = sys(size - 2.5f, pal.ink3, Weight.Medium)
      val rowHeight = max(size, p.lineHeight(title))
      p.logo(s.logo, s.monogram, x, y + (rowHeight - size) / 2, size, pal.ink)
      var left = x + size + 5
      val titleWidth = min(p.textWidth(d.title, title), width - (left - x))
      p.fitText(d.title, left, y + (rowHeight - p.lineHeight(title)) / 2, title, titleWidth)
      left += titleWidth + 5
      if (left < x + width - 8) p.fitText(d.plan, left, y + (rowHeight - p.lineHeight(plan)) / 2, plan, x + width - left)
      return rowHeight
    }

    private fun detailLegend(d: WidgetDetail, x: Float, y: Float, width: Float, vertical: Boolean): Float {
      val style = sys(11f, pal.ink2)
      val rowHeight = max(7f, p.lineHeight(style))
      if (vertical) {
        d.legend.forEachIndexed { i, item ->
          val top = y + i * (rowHeight + 5f)
          p.circle(x + 3.5f, top + rowHeight / 2, 3.5f, pal.named(item.color))
          p.fitText(item.label, x + 12, top, style, width - 12)
        }
        return d.legend.size * rowHeight + max(0, d.legend.size - 1) * 5f
      }
      val widths = d.legend.map { 12f + p.textWidth(it.label, style) }
      val total = widths.sum() + 12f * max(0, d.legend.size - 1)
      var left = x + (width - min(total, width)) / 2
      d.legend.forEachIndexed { i, item ->
        p.circle(left + 3.5f, y + rowHeight / 2, 3.5f, pal.named(item.color))
        p.fitText(item.label, left + 12, y, style, max(10f, min(widths[i] - 12f, x + width - left - 12f)))
        left += widths[i] + 12f
      }
      return rowHeight
    }

    /** Nested rings with the big value in the middle, sized like the Mac detail page. */
    private fun detailRings(d: WidgetDetail, cx: Float, cy: Float, size: Float, showCaption: Boolean = true) {
      val lineWidth = (size * (if (d.rings.size > 1) 0.06f else 0.068f)).roundToInt().toFloat()
      val gap = max(2f, size / 63f)
      val scale = size / 188f
      d.rings.forEachIndexed { index, ring ->
        val inset = 3 * scale + index * (lineWidth + gap)
        val radius = size / 2 - inset - lineWidth / 2
        p.ringTrack(cx, cy, radius, lineWidth, pal.ink5)
        p.ringArc(cx, cy, radius, lineWidth, ring.fraction.coerceIn(0.0, 1.0), pal.named(ring.color))
      }
      val inner = size - 2 * (3 * scale + d.rings.size * (lineWidth + gap)) - 6
      val bigStyle = num((if (d.bigCompact) 48f else 68f) * scale, d.bigColor?.let { pal.named(it) } ?: pal.ink, Weight.Medium)
      val unit = d.bigUnit
      val unitStyle = num(24f * scale, pal.ink3, Weight.Medium)
      var fit = 1f
      val natural = p.textWidth(d.bigValue, bigStyle) + (if (unit != null) 2f + p.textWidth(unit, unitStyle) else 0f)
      if (natural > inner) fit = max(0.6f, inner / natural)
      val big = num(bigStyle.size * fit, bigStyle.color, Weight.Medium)
      val unitFit = num(unitStyle.size * fit, pal.ink3, Weight.Medium)
      val caption = sys(max(9.5f, 11f * scale), pal.ink3)
      val bigHeight = p.lineHeight(big)
      val captionHeight = if (showCaption) p.lineHeight(caption) + 2 * scale else 0f
      val top = cy - (bigHeight + captionHeight) / 2
      val total = p.textWidth(d.bigValue, big) + (if (unit != null) 2f + p.textWidth(unit, unitFit) else 0f)
      val left = cx - total / 2
      val baseline = top + p.ascent(big)
      p.textAt(d.bigValue, left, baseline, big)
      if (unit != null) p.textAt(unit, left + p.textWidth(d.bigValue, big) + 2f, baseline, unitFit)
      if (showCaption) p.fitText(d.bigCaption, cx - inner / 2, top + bigHeight + 2 * scale, caption, inner, Align.Center, minScale = 0.8f)
    }

    private fun resetLine(s: WidgetSource): String =
      if (s.resetsAtMs == null) s.whenText else f.s("resetsIn", mapOf("duration" to f.whenText(s)))

    /** One source: the Mac detail ring instead of a lone tube in an empty row. */
    private fun singleSource(s: WidgetSource, d: WidgetDetail) {
      val stale = f.staleLabel(6.0)
      when (family) {
        WidgetFamily.Strip -> quotaStrip(listOf(s))
        WidgetFamily.Small -> {
          val top = 14f
          val headerHeight = if (stale != null) staleLine(stale, 14f, top, w - 28f) else detailHeader(s, d, 14f, top, w - 28f, 12f)
          val size = min(104f, min(w - 28f, h - top - 13f - headerHeight - 6f))
          detailRings(d, w / 2, top + headerHeight + 6f + (h - top - 13f - headerHeight - 6f) / 2, size)
        }
        WidgetFamily.Large -> {
          val update = sys(11f, if (stale == null) pal.ink3 else pal.warn, if (stale == null) Weight.Regular else Weight.Medium)
          val updated = f.updatedLabel()
          val updatedWidth = min(p.textWidth(updated, update), (w - 28f) / 2)
          detailHeader(s, d, 14f, 16f, w - 28f - updatedWidth - 8f)
          p.fitText(updated, w - 14f - updatedWidth, 16f, update, updatedWidth, Align.End)
          val card = monthCardHeight()
          val whenStyle = sys(11f, pal.level(f.resetLevel(s)) ?: pal.ink2, Weight.Medium)
          val bottomBlock = card + 8f
          val legendHeight = if (d.legend.isNotEmpty()) 10f + p.lineHeight(sys(11f, pal.ink2)) else 0f
          val whenHeight = 4f + p.lineHeight(whenStyle)
          val region = h - 14f - bottomBlock - (16f + 16f) - legendHeight - whenHeight
          val size = min(170f, max(80f, region))
          val ringsTop = 16f + 16f + 6f
          detailRings(d, w / 2, ringsTop + size / 2, size)
          var y = ringsTop + size
          if (d.legend.isNotEmpty()) {
            y += 10f
            y += detailLegend(d, 14f, y, w - 28f, vertical = false)
          }
          y += 4f
          sourceWhen(resetLine(s), f.resetLevel(s), 11f, 14f, y, w - 28f)
          monthCard(f.snapshot, 14f, h - 14f - card, w - 28f, card)
        }
        WidgetFamily.Medium -> {
          val size = min(124f, h - 32f)
          detailRings(d, 16f + size / 2, h / 2, size, showCaption = false)
          val left = 16f + size + 16f
          val width = w - 16f - left
          var y = 16f
          if (stale != null) y += staleLine(stale, left, y, width) + 4f
          y += detailHeader(s, d, left, y, width)
          val caption = sys(11f, pal.ink3)
          p.fitText(d.bigCaption, left, y + 3f, caption, width)
          if (d.legend.isNotEmpty()) detailLegend(d, left, y + 3f + p.lineHeight(caption) + 8f, width, vertical = true)
          val whenStyle = sys(11f, pal.ink2, Weight.Medium)
          sourceWhenStart(resetLine(s), f.resetLevel(s), 11f, left, h - 16f - p.lineHeight(whenStyle), width)
        }
      }
    }

    private fun sourceWhenStart(text: String, level: String, size: Float, x: Float, y: Float, width: Float) {
      p.fitText(text, x, y, sys(size, pal.level(level) ?: pal.ink2, Weight.Medium), width)
    }

    // ---------------------------------------------------------------- daily usage widget

    fun usage(state: WidgetState) {
      when (state) {
        is WidgetState.UpdateDesktop -> empty(f.text("updateTitle"), f.text("updateBody"))
        is WidgetState.Empty -> empty(f.text("emptyUsageTitle"), f.text("emptyUsageBody"))
        is WidgetState.Snapshot -> {
          val snapshot = state.snapshot
          if (snapshot.usage.daily.isEmpty() || snapshot.usage.days.isEmpty()) {
            empty(f.text("emptyUsageTitle"), f.text("emptyUsageBody"))
          } else {
            usageContent(snapshot, UsageBreakdown(snapshot, money = false))
          }
        }
      }
    }

    /** Today's tokens as the headline: Barlow digits with a quiet "token" unit. */
    private fun tokenFigure(tokens: Double, x: Float, top: Float, width: Float, size: Float): Float {
      val color = if (tokens > 0) pal.ink else pal.ink3
      val text = f.tokens(tokens)
      val unit = f.s("tokenUnit")
      val unitSize = (size * 0.34f).roundToInt().toFloat()
      var fit = 1f
      val natural = p.textWidth(text, num(size, color)) + 3f + p.textWidth(unit, sys(unitSize, pal.ink3, Weight.Medium))
      if (natural > width) fit = max(0.6f, width / natural)
      val big = num(size * fit, color)
      val small = sys(unitSize * fit, pal.ink3, Weight.Medium)
      val baseline = top + p.ascent(big)
      p.textAt(text, x, baseline, big)
      p.textAt(unit, x + p.textWidth(text, big) + 3f, baseline, small)
      return p.lineHeight(big)
    }

    private fun averageLegend(text: String, right: Float, y: Float) {
      val style = sys(10f, pal.ink3)
      val textWidth = p.textWidth(text, style)
      val left = right - textWidth - 4f - 12f
      p.hline(left, left + 12f, y + p.lineHeight(style) / 2, 1f, pal.ink2, floatArrayOf(2f, 2f))
      p.text(text, left + 16f, y, style)
    }

    private fun usageContent(snapshot: WidgetSnapshot, breakdown: UsageBreakdown) {
      val daily = snapshot.usage.daily
      val days = snapshot.usage.days
      val today = daily.last()
      val average = daily.sumOf { it.totalTokens } / daily.size
      // A snapshot that outlived its day shows its real date, never "today".
      val lastDay = days.last()
      val isCurrent = f.isToday(lastDay)
      val todayLabel = if (isCurrent) f.s("today") else f.monthDay(lastDay)
      val averageLabel = "${f.s("dailyAverage")} ${f.tokens(average)} ${f.s("tokenUnit")}"
      val todayValue = "${f.text("valueBasis")} ${f.money(today.total)}"
      val small = sys(11f, pal.ink3)
      when (family) {
        WidgetFamily.Strip -> {
          val label = sys(10f, pal.ink3)
          val figureTop = (h - (p.lineHeight(label) + p.lineHeight(num(26f, pal.ink)))) / 2
          p.fitText(todayLabel, 12f, figureTop, label, 120f)
          val figureWidth = min(w * 0.42f, 120f)
          tokenFigure(today.totalTokens, 12f, figureTop + p.lineHeight(label), figureWidth, 26f)
          val chartLeft = 12f + figureWidth + 12f
          val days14 = if (w - chartLeft > 140f) 14 else 7
          p.dailyBars(daily.takeLast(days14), breakdown, RectF(chartLeft, 10f, w - 12f, h - 10f), gap = 3f)
        }
        WidgetFamily.Small -> {
          val left = 16f
          val width = w - 32f
          var y = 15f
          p.fitText(todayLabel, left, y, small, width)
          if (isCurrent) p.fitText(f.monthDay(lastDay), left, y, small, width, Align.End)
          y += p.lineHeight(small) + 4f
          y += tokenFigure(today.totalTokens, left, y, width, 38f)
          p.fitText(if (today.totalTokens > 0 || !isCurrent) todayValue else f.text("todayNone"), left, y, small, width)
          y += p.lineHeight(small)
          val letterStyle = sys(9.5f, pal.ink3)
          val lettersTop = h - 12f - p.lineHeight(letterStyle)
          val barsBottom = lettersTop - 4f
          val barsHeight = min(60f, max(18f, barsBottom - y - 4f)).let { if (it > 36f) 36f + (it - 36f) * 0.5f else it }
          val week = daily.takeLast(7)
          val weekDays = days.takeLast(7)
          p.dailyBars(week, breakdown, RectF(left, barsBottom - barsHeight, left + width, barsBottom), gap = 8f)
          val column = width / weekDays.size
          weekDays.forEachIndexed { i, day ->
            val last = i == weekDays.size - 1
            val style = sys(9.5f, if (last) pal.ink else pal.ink3, if (last) Weight.Semibold else Weight.Regular)
            p.text(f.weekdayNarrow(day), left + i * column, lettersTop, style, column, Align.Center)
          }
        }
        WidgetFamily.Large -> {
          val left = 16f
          val width = w - 32f
          val total = daily.sumOf { it.total }
          val paid = daily.sumOf { it.paid }
          val tokens = daily.sumOf { it.totalTokens }
          var y = 16f
          val header = if (isCurrent) "$todayLabel · ${f.monthDay(lastDay)} ${f.weekday(lastDay)}" else "$todayLabel ${f.weekday(lastDay)}"
          val scope = f.s(if (snapshot.usage.scope == "local") "scopeLocal" else "scopeAll")
          val scopeWidth = min(p.textWidth(scope, small), width / 2)
          p.fitText(header, left, y, small, width - scopeWidth - 4f)
          p.fitText(scope, left + width - scopeWidth, y, small, scopeWidth, Align.End)
          y += p.lineHeight(small) + 5f
          y += tokenFigure(today.totalTokens, left, y, width, 46f) + 3f
          p.fitText("${f.text("valueBasisLong")} ${f.money(today.total)}", left, y, small, width)
          y += p.lineHeight(small)

          // Everything below hangs from the bottom; the space above absorbs the rest.
          val rows = breakdown.ranked(4) { key -> daily.sumOf { breakdown.value(it, key) } }
          val gridRows = (rows.size + 1) / 2
          val gridStyle = sys(10.5f, pal.ink2)
          val rowHeight = max(6f, max(p.lineHeight(gridStyle), p.lineHeight(num(14f, pal.ink))))
          val splitHeight = 4f + 8f + gridRows * rowHeight + max(0, gridRows - 1) * 5f
          val summaryHeight = max(p.lineHeight(small), p.lineHeight(num(18f, pal.ink)))
          val dateStyle = sys(10f, pal.ink3)
          val legendHeight = p.lineHeight(sys(10f, pal.ink3)) + 5f
          val barsHeight = 100f
          val bottomBlock = legendHeight + barsHeight + 4f + p.lineHeight(dateStyle) + 10f + 0.5f + 9f + summaryHeight + 8f + splitHeight
          var by = max(y + 6f, h - 14f - bottomBlock)
          averageLegend(averageLabel, left + width, by)
          by += legendHeight
          p.dailyBars(daily, breakdown, RectF(left, by, left + width, by + barsHeight), gap = 3f, average = average)
          by += barsHeight + 4f
          p.text(f.monthDay(days.first()), left, by, dateStyle)
          p.text(todayLabel, left, by, dateStyle, width, Align.End)
          by += p.lineHeight(dateStyle) + 10f
          p.fillRect(RectF(left, by, left + width, by + 0.5f), 0f, pal.line)
          by += 0.5f + 9f
          val monthLabel = f.s(if (snapshot.usage.scope == "local") "monthScopeLocal" else "monthScopeAll").substringBefore(" · ")
          var sx = left
          val baseline = by + (summaryHeight - p.lineHeight(num(18f, pal.ink))) + p.ascent(num(18f, pal.ink))
          p.textAt(monthLabel, sx, baseline, small)
          sx += p.textWidth(monthLabel, small) + 6f
          val tokenText = f.tokens(tokens)
          p.textAt(tokenText, sx, baseline, num(18f, pal.ink))
          sx += p.textWidth(tokenText, num(18f, pal.ink)) + 6f
          val unit = f.s("tokenUnit")
          p.textAt(unit, sx, baseline, small)
          sx += p.textWidth(unit, small) + 4f
          val paidText = "${f.text("valueBasis")} ${f.money(total)} · ${f.s("paid")} ${f.money(paid)}"
          p.fitText(paidText, sx, by + (summaryHeight - p.lineHeight(small)) / 2, small, left + width - sx, Align.End, minScale = 0.8f)
          by += summaryHeight + 8f
          breakdownSplit(rows, tokens, breakdown, left, by, width, rowHeight)
        }
        WidgetFamily.Medium -> {
          val left = 16f
          val leftWidth = 124f
          var y = 15f
          p.fitText(todayLabel, left, y, small, leftWidth)
          y += p.lineHeight(small) + 4f
          y += tokenFigure(today.totalTokens, left, y, leftWidth, 36f)
          p.fitText(todayValue, left, y, small, leftWidth)
          val rows = breakdown.ranked(3) { breakdown.value(today, it) }
          val rowStyle = sys(10.5f, pal.ink2)
          val rowHeight = max(6f, max(p.lineHeight(rowStyle), p.lineHeight(num(14f, pal.ink))))
          var ry = h - 12f - (rows.size * rowHeight + max(0, rows.size - 1) * 4f)
          for ((key, value) in rows) {
            p.circle(left + 3f, ry + rowHeight / 2, 3f, breakdown.rowColor(key, pal))
            val amount = breakdown.amount(value, f)
            val amountStyle = num(14f, pal.ink)
            val amountWidth = p.textWidth(amount, amountStyle)
            p.text(amount, left + leftWidth - amountWidth, ry + (rowHeight - p.lineHeight(amountStyle)) / 2, amountStyle)
            p.fitText(breakdown.rowLabel(key, f), left + 11f, ry + (rowHeight - p.lineHeight(rowStyle)) / 2, rowStyle, leftWidth - 11f - amountWidth - 7f)
            ry += rowHeight + 4f
          }
          val right = w - 16f
          val chartLeft = left + leftWidth + 14f
          val dateStyle = sys(10f, pal.ink3)
          val datesTop = h - 12f - p.lineHeight(dateStyle)
          val barsBottom = datesTop - 4f
          val barsHeight = min(130f, max(30f, barsBottom - 15f - p.lineHeight(sys(10f, pal.ink3)) - 5f - 6f)).let { if (it > 80f) 80f + (it - 80f) * 0.8f else it }
          averageLegend(averageLabel, right, barsBottom - barsHeight - 5f - p.lineHeight(sys(10f, pal.ink3)))
          p.dailyBars(daily.takeLast(14), breakdown, RectF(chartLeft, barsBottom - barsHeight, right, barsBottom), gap = 4f, average = average)
          p.text(f.monthDay(days[max(0, days.size - 14)]), chartLeft, datesTop, dateStyle)
          p.text(todayLabel, chartLeft, datesTop, dateStyle, right - chartLeft, Align.End)
        }
      }
    }

    /** One thin bar, then the parts in two columns: dot, name and share, amount on the right. */
    private fun breakdownSplit(
      rows: List<Pair<Int, Double>>, total: Double, breakdown: UsageBreakdown, x: Float, y: Float, width: Float, rowHeight: Float,
    ) {
      val sum = max(total, 0.0001)
      val available = width - max(0, rows.size - 1) * 2f
      var bx = x
      for ((key, value) in rows) {
        val part = max(6f, (value / sum).toFloat() * available)
        p.fillRect(RectF(bx, y, bx + part, y + 4f), 2f, breakdown.rowColor(key, pal))
        bx += part + 2f
      }
      val style = sys(10.5f, pal.ink2)
      val percentStyle = sys(10.5f, pal.ink3)
      val amountStyle = num(14f, pal.ink)
      val columnWidth = (width - 14f) / 2
      rows.forEachIndexed { index, (key, value) ->
        val cx = x + (index % 2) * (columnWidth + 14f)
        val cy = y + 4f + 8f + (index / 2) * (rowHeight + 5f)
        p.circle(cx + 3f, cy + rowHeight / 2, 3f, breakdown.rowColor(key, pal))
        val amount = breakdown.amount(value, f)
        val amountWidth = p.textWidth(amount, amountStyle)
        p.text(amount, cx + columnWidth - amountWidth, cy + (rowHeight - p.lineHeight(amountStyle)) / 2, amountStyle)
        val percent = "${(value / sum * 100).roundToInt()}%"
        val percentWidth = p.textWidth(percent, percentStyle)
        val labelWidth = columnWidth - 11f - percentWidth - 5f - amountWidth - 7f
        val used = p.fitText(breakdown.rowLabel(key, f), cx + 11f, cy + (rowHeight - p.lineHeight(style)) / 2, style, max(10f, labelWidth))
        p.text(percent, cx + 11f + used + 5f, cy + (rowHeight - p.lineHeight(percentStyle)) / 2, percentStyle)
      }
    }
  }
}
