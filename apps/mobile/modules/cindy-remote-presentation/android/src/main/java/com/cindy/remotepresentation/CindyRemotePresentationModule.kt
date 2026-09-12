package com.cindy.remotepresentation

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.util.Base64
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.functions.Queues
import android.os.Build
import android.text.Html
import androidx.core.content.FileProvider
import java.io.File
import java.util.UUID
import org.json.JSONObject
import java.io.ByteArrayOutputStream

class CindyRemotePresentationModule : Module() {
  private val clipboard: ClipboardManager
    get() = appContext.reactContext!!.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager

  override fun definition() = ModuleDefinition {
    Name("CindyRemotePresentation")
    // Android WebView owns playback; only iOS needs an AVAudioSession override.
    AsyncFunction("playback") { _: Boolean -> Unit }
    AsyncFunction("clipboardVersion") { foreground(); clipboardVersion() }.runOnQueue(Queues.MAIN)
    AsyncFunction("readClipboard") { foreground(); readClipboard() }.runOnQueue(Queues.MAIN)
    AsyncFunction("syncClipboard") { json: String, version: String ->
      foreground()
      if (clipboardVersion() != version) throw Exception("CLIPBOARD_CHANGED")
      writeClipboard(json, version)
      clipboardVersion()
    }.runOnQueue(Queues.MAIN)
    AsyncFunction("writeClipboard") { json: String -> foreground(); writeClipboard(json, null) }.runOnQueue(Queues.MAIN)
  }

  private fun foreground() {
    if (appContext.currentActivity?.hasWindowFocus() != true) throw Exception("CLIPBOARD_NOT_ALLOWED")
  }

  // The same snapshot identity is used by polling and compare-before-write.
  // Do not decode images or open content providers just to poll for a new copy.
  private fun clipboardVersion(): String = clipboard.primaryClip?.let { clip ->
    val stamp = if (Build.VERSION.SDK_INT >= 26) clip.description.timestamp else 0L
    val items = (0 until clip.itemCount).map { i ->
      val item = clip.getItemAt(i)
      listOf(item.text?.toString(), item.htmlText, item.uri?.toString()).toString()
    }
    "$stamp:${items.hashCode()}"
  } ?: "0"

  private fun readClipboard(): String {
    val clip = clipboard.primaryClip ?: throw Exception("CLIPBOARD_EMPTY")
    if (clip.itemCount != 1) throw Exception("CLIPBOARD_UNSUPPORTED")
    val item = clip.getItemAt(0)
    val result = JSONObject()
    item.text?.toString()?.takeIf { it.isNotEmpty() }?.let { result.put("text", it) }
    item.htmlText?.takeIf { it.isNotEmpty() }?.let { result.put("html", it) }
    item.uri?.let { uri -> if (uri.scheme == "http" || uri.scheme == "https") result.put("url", uri.toString()) }
    item.uri?.takeIf { it.scheme == "content" }?.let { uri ->
      val resolver = appContext.reactContext!!.contentResolver
      if (resolver.getType(uri)?.startsWith("image/") == true) {
        val bytes = resolver.openInputStream(uri)?.use { input ->
          val output = ByteArrayOutputStream()
          val buffer = ByteArray(8192)
          while (true) {
            val count = input.read(buffer)
            if (count < 0) break
            if (output.size() + count > 24 * 1024 * 1024) throw Exception("CLIPBOARD_TOO_LONG")
            output.write(buffer, 0, count)
          }
          output.toByteArray()
        } ?: throw Exception("CLIPBOARD_UNSUPPORTED")
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0 || bounds.outWidth.toLong() * bounds.outHeight > 16_000_000)
          throw Exception("CLIPBOARD_TOO_LONG")
        val bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.size) ?: throw Exception("CLIPBOARD_UNSUPPORTED")
        try {
          val output = ByteArrayOutputStream()
          bitmap.compress(Bitmap.CompressFormat.PNG, 100, output)
          result.put("png", Base64.encodeToString(output.toByteArray(), Base64.NO_WRAP))
        } finally { bitmap.recycle() }
      }
    }
    if (result.length() == 0) throw Exception("CLIPBOARD_UNSUPPORTED")
    return result.toString().also { if (it.length > 32 * 1024 * 1024) throw Exception("CLIPBOARD_TOO_LONG") }
  }

  private fun writeClipboard(json: String, expectedVersion: String?) {
    if (expectedVersion != null && clipboardVersion() != expectedVersion) throw Exception("CLIPBOARD_CHANGED")
    if (json.length > 32 * 1024 * 1024) throw Exception("CLIPBOARD_TOO_LONG")
    val content = JSONObject(json)
    val html = content.optString("html", null)
    val text = content.optString("text", null) ?: html?.let { Html.fromHtml(it, Html.FROM_HTML_MODE_LEGACY).toString() }
    val uri = content.optString("url", null)?.let { Uri.parse(it) }
    val png = content.optString("png", null)
    var imageFile: File? = null
    val clip = when {
      png != null -> {
        val bytes = Base64.decode(png, Base64.DEFAULT)
        if (bytes.size < 8 || !bytes.copyOfRange(0, 8).contentEquals(byteArrayOf(-119,80,78,71,13,10,26,10)))
          throw Exception("CLIPBOARD_UNSUPPORTED")
        val context = appContext.reactContext!!
        val directory = File(context.cacheDir, "remote-clipboard").apply { mkdirs() }
        // Temporary, grant-scoped clipboard images. Keep recent URIs readable;
        // sweep older images on the next write, outside all media libraries.
        directory.listFiles()?.filter { System.currentTimeMillis() - it.lastModified() > 3_600_000 }?.forEach { it.delete() }
        imageFile = File(directory, "${UUID.randomUUID()}.png").apply { writeBytes(bytes) }
        val imageUri = FileProvider.getUriForFile(context, "${context.packageName}.remoteclipboard", imageFile!!)
        ClipData("Cindy", arrayOf("image/png"), ClipData.Item(text, html, null, imageUri))
      }
      text != null && html != null -> ClipData.newHtmlText("Cindy", text, html)
      text != null -> ClipData.newPlainText("Cindy", text)
      uri != null -> ClipData.newRawUri("Cindy", uri)
      else -> throw Exception("CLIPBOARD_UNSUPPORTED")
    }
    try {
      foreground()
      if (expectedVersion != null && clipboardVersion() != expectedVersion) throw Exception("CLIPBOARD_CHANGED")
      clipboard.setPrimaryClip(clip)
    } catch (error: Exception) { imageFile?.delete(); throw error }
  }
}
