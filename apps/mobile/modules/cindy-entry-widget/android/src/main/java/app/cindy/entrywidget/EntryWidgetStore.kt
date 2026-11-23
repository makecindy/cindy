package app.cindy.entrywidget

import android.content.Context
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/** 一个可放上桌面的入口：新建任务，或某台电脑上的某位伙伴。 */
internal data class EntryTarget(
  val id: String,
  val title: String,
  val subtitle: String,
  val url: String,
  /** 已解码好的图标文件；空表示用应用图标。 */
  val iconFile: String?,
)

/**
 * 同 `cindy-entry-widget` 的 SharedPreferences 与快照文件。
 *
 * 目标由 JS 写入（伙伴名单只在 JS 里），图标以 PNG 落成文件 —— 桌面每次重绘都读文件，
 * 不重新解码 base64；每个组件选的入口按 appWidgetId 记在偏好里。
 */
internal object EntryWidgetStore {
  private const val PREFS = "cindy-entry-widget"

  fun snapshotFile(context: Context) = File(context.noBackupFilesDir, "entry-widget-targets.json")

  private fun iconDir(context: Context) = File(context.noBackupFilesDir, "entry-widget-icons").apply { mkdirs() }

  fun targets(context: Context): List<EntryTarget> {
    val file = snapshotFile(context)
    if (!file.exists()) return emptyList()
    return try {
      read(JSONObject(file.readText()))
    } catch (_: Exception) {
      emptyList()
    }
  }

  private fun read(root: JSONObject): List<EntryTarget> {
    val rows = root.optJSONArray("targets") ?: JSONArray()
    val result = ArrayList<EntryTarget>(rows.length())
    for (index in 0 until rows.length()) {
      val row = rows.optJSONObject(index) ?: continue
      val id = row.optString("id").trim()
      val url = row.optString("url").trim()
      if (id.isEmpty() || url.isEmpty()) continue
      result.add(
        EntryTarget(
          id = id,
          title = row.optString("title").trim(),
          subtitle = row.optString("subtitle").trim(),
          url = url,
          iconFile = row.optString("icon").trim().ifEmpty { null },
        ),
      )
    }
    return result
  }

  /**
   * 原子写入快照：图标先落盘再换文件，桌面重绘时看到的要么是旧快照、要么是新快照，
   * 不会读到只写了一半的目标列表。返回写入条数；失败返回 -1，调用方不要把失败当成「没有目标」。
   */
  fun write(context: Context, json: String): Int = try {
    val rows = JSONObject(json).optJSONArray("targets") ?: JSONArray()
    val normalized = JSONArray()
    val directory = iconDir(context)
    val keep = LinkedHashSet<File>()
    for (index in 0 until rows.length()) {
      val row = rows.optJSONObject(index) ?: continue
      val id = row.optString("id").trim()
      val url = row.optString("url").trim()
      if (id.isEmpty() || url.isEmpty()) continue
      val icon = row.optJSONObject("icon")
      val file = icon?.let { iconFile(context, directory, id, it) }
      if (file != null) keep.add(file)
      normalized.put(
        JSONObject()
          .put("id", id)
          .put("title", row.optString("title"))
          .put("subtitle", row.optString("subtitle"))
          .put("url", url)
          .put("icon", file?.absolutePath ?: ""),
      )
    }
    // 换掉的头像文件不能留着，否则同一个伙伴会越攒越多。
    directory.listFiles()?.forEach { if (it !in keep) it.delete() }
    writeAtomically(snapshotFile(context), JSONObject().put("targets", normalized).toString())
    normalized.length()
  } catch (_: Exception) {
    -1
  }

  /**
   * 图标两种形态：JS 已经画好的 PNG（头像），或一个字 + 背景色（头像取不到时）。
   * 字由原生画，因为 JS 侧没有能产出 PNG 的文字渲染。
   */
  private fun iconFile(context: Context, directory: File, id: String, icon: JSONObject): File? {
    val bitmap = when (icon.optString("kind").trim()) {
      "image" -> icon.optString("pngBase64").trim().let { base64 ->
        if (base64.isEmpty()) null else runCatching {
          Base64.decode(base64, Base64.DEFAULT)
        }.getOrNull()?.let { EntryIcons.decode(it) }
      }
      "glyph" -> EntryIcons.glyph(
        text = icon.optString("text").trim(),
        background = icon.optString("background").trim(),
      )
      else -> null
    } ?: return null
    val file = File(directory, "${Integer.toHexString(id.hashCode())}.png")
    return try {
      file.outputStream().use { bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it) }
      bitmap.recycle()
      file
    } catch (_: Exception) {
      bitmap.recycle()
      null
    }
  }

  /** 这份组件选中的入口；还没选过时为 null，由调用方退回目标列表的第一项。 */
  fun selection(context: Context, appWidgetId: Int): String? =
    preferences(context).getString("target.$appWidgetId", null)?.trim()?.ifEmpty { null }

  fun setSelection(context: Context, appWidgetId: Int, targetId: String) {
    preferences(context).edit().putString("target.$appWidgetId", targetId).apply()
  }

  fun forget(context: Context, appWidgetId: Int) {
    preferences(context).edit().remove("target.$appWidgetId").apply()
  }

  private fun preferences(context: Context) =
    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

  private fun writeAtomically(file: File, text: String) {
    val temporary = File(file.parentFile, file.name + ".tmp")
    temporary.writeText(text)
    if (!temporary.renameTo(file)) {
      file.delete()
      if (!temporary.renameTo(file)) throw IllegalStateException("cannot replace $file")
    }
  }
}
