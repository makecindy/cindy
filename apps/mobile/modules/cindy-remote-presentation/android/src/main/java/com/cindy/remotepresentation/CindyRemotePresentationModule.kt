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
import expo.modules.kotlin.functions.Coroutine
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import android.os.Build
import android.os.Handler
import android.os.Looper
import java.util.concurrent.atomic.AtomicLong
import android.text.Html
import androidx.core.content.FileProvider
import java.io.File
import java.util.UUID
import org.json.JSONObject
import java.io.ByteArrayOutputStream

// Bound encoded buffers before Bitmap/JSON/Base64 can multiply their footprint.
private const val IMAGE_BYTES = 8 * 1024 * 1024
private const val IMAGE_PIXELS = 4_000_000L
private fun decodeClipboardPng(encoded: String): ByteArray {
  if (encoded.length > ((IMAGE_BYTES + 2) / 3) * 4) throw Exception("CLIPBOARD_TOO_LONG")
  val bytes = Base64.decode(encoded, Base64.DEFAULT)
  if (bytes.size > IMAGE_BYTES) throw Exception("CLIPBOARD_TOO_LONG")
  if (bytes.size < 33 || !bytes.copyOfRange(0, 16).contentEquals(
      byteArrayOf(-119,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82)))
    throw Exception("CLIPBOARD_UNSUPPORTED")
  fun dimension(offset: Int): Long = (offset until offset + 4).fold(0L) { value, index ->
    (value shl 8) or (bytes[index].toLong() and 255L)
  }
  val width = dimension(16)
  val height = dimension(20)
  if (width <= 0 || height <= 0 || width > IMAGE_PIXELS / height) throw Exception("CLIPBOARD_TOO_LONG")
  return bytes
}
private class ClipboardImageOutput : ByteArrayOutputStream(8192) {
  override fun write(value: Int) {
    if (count >= IMAGE_BYTES) throw Exception("CLIPBOARD_TOO_LONG")
    super.write(value)
  }
  override fun write(bytes: ByteArray, offset: Int, length: Int) {
    if (length > IMAGE_BYTES - count) throw Exception("CLIPBOARD_TOO_LONG")
    super.write(bytes, offset, length)
  }
  fun base64(): String = Base64.encodeToString(buf, 0, count, Base64.NO_WRAP)
}

class CindyRemotePresentationModule : Module() {
  private val clipboard: ClipboardManager
    get() = appContext.reactContext!!.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager

  // No payload is retained: notifications and foreground transitions only
  // invalidate the version. Atomic because Expo lifecycle callbacks may run
  // outside the MAIN queue used by clipboard operations.
  private val clipboardGeneration = AtomicLong(0)
  private val clipboardEpoch = UUID.randomUUID().toString()
  private var observedClipboard: ClipboardManager? = null
  private val clipboardListener = ClipboardManager.OnPrimaryClipChangedListener {
    clipboardGeneration.incrementAndGet()
  }

  override fun definition() = ModuleDefinition {
    Name("CindyRemotePresentation")
    OnActivityEntersForeground { clipboardGeneration.incrementAndGet() }
    OnDestroy {
      Handler(Looper.getMainLooper()).post {
        observedClipboard?.removePrimaryClipChangedListener(clipboardListener)
        observedClipboard = null
      }
    }
    // Android WebView owns playback; only iOS needs an AVAudioSession override.
    AsyncFunction("playback") { _: Boolean -> Unit }
    AsyncFunction("clipboardVersion") { foreground(); clipboardVersion() }.runOnQueue(Queues.MAIN)
    AsyncFunction("readClipboard") Coroutine { ->
      val clip = withContext(Dispatchers.Main.immediate) {
        foreground()
        clipboard.primaryClip ?: throw Exception("CLIPBOARD_EMPTY")
      }
      val result = withContext(Dispatchers.IO) { readClipboard(clip) }
      withContext(Dispatchers.Main.immediate) { foreground() }
      result
    }
    AsyncFunction("syncClipboard") Coroutine { json: String, version: String -> writeClipboard(json, version) }
    AsyncFunction("writeClipboard") Coroutine { json: String -> writeClipboard(json, null); Unit }
  }

  private fun foreground() {
    if (appContext.currentActivity?.hasWindowFocus() != true) throw Exception("CLIPBOARD_NOT_ALLOWED")
  }

  // Poll only a change token, never primaryClip or item text/HTML/URI. The
  // description timestamp also detects a change whose listener callback is
  // still queued; API 24/25 use the listener and foreground invalidation.
  private fun clipboardVersion(): String {
    val manager = clipboard
    if (observedClipboard == null) {
      manager.addPrimaryClipChangedListener(clipboardListener)
      observedClipboard = manager
    }
    val stamp = if (Build.VERSION.SDK_INT >= 26) manager.primaryClipDescription?.timestamp else null
    return "$clipboardEpoch:${clipboardGeneration.get()}:$stamp"
  }

  private fun readClipboard(clip: ClipData): String {
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
          val output = ClipboardImageOutput()
          val buffer = ByteArray(8192)
          while (true) {
            val count = input.read(buffer)
            if (count < 0) break
            output.write(buffer, 0, count)
          }
          output.toByteArray()
        } ?: throw Exception("CLIPBOARD_UNSUPPORTED")
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0 || bounds.outWidth.toLong() * bounds.outHeight > IMAGE_PIXELS)
          throw Exception("CLIPBOARD_TOO_LONG")
        val bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.size) ?: throw Exception("CLIPBOARD_UNSUPPORTED")
        try {
          val output = ClipboardImageOutput()
          if (!bitmap.compress(Bitmap.CompressFormat.PNG, 100, output)) throw Exception("CLIPBOARD_TOO_LONG")
          bitmap.recycle()
          result.put("png", output.base64())
        } finally { bitmap.recycle() }
      }
    }
    if (result.length() == 0) throw Exception("CLIPBOARD_UNSUPPORTED")
    return result.toString().also { if (it.length > 32 * 1024 * 1024) throw Exception("CLIPBOARD_TOO_LONG") }
  }

  private suspend fun writeClipboard(json: String, expectedVersion: String?): String = withContext(Dispatchers.IO) {
    withContext(Dispatchers.Main.immediate) {
      foreground()
      if (expectedVersion != null && clipboardVersion() != expectedVersion) throw Exception("CLIPBOARD_CHANGED")
    }
    if (json.length > 32 * 1024 * 1024) throw Exception("CLIPBOARD_TOO_LONG")
    val content = JSONObject(json)
    val html = content.optString("html", null)
    val text = content.optString("text", null) ?: html?.let { Html.fromHtml(it, Html.FROM_HTML_MODE_LEGACY).toString() }
    val uri = content.optString("url", null)?.let { Uri.parse(it) }
    val png = content.optString("png", null)
    // Process incarnation, shared by all module instances without an ownership registry.
    val pendingPrefix = "${android.os.Process.myPid()}-${android.os.Process.getStartElapsedRealtime()}-"
    var imageFile: File? = null
    var committed = false
    try {
      val clip = when {
        png != null -> {
          val bytes = decodeClipboardPng(png)
          val context = appContext.reactContext!!
          val directory = File(context.cacheDir, "remote-clipboard").apply { mkdirs() }
          // Other writes must not reclaim an image that is still being prepared.
          imageFile = File(directory, "$pendingPrefix${UUID.randomUUID()}.png.pending")
          imageFile!!.writeBytes(bytes)
          val publishedFile = File(directory, imageFile!!.name.removeSuffix(".pending"))
          val imageUri = FileProvider.getUriForFile(context, "${context.packageName}.remoteclipboard", publishedFile)
          val mimeTypes = listOfNotNull(
            "image/png",
            text?.let { "text/plain" },
            html?.let { "text/html" },
          ).toTypedArray()
          ClipData("Cindy", mimeTypes, ClipData.Item(text, html, null, imageUri))
        }
        text != null && html != null -> ClipData.newHtmlText("Cindy", text, html)
        text != null -> ClipData.newPlainText("Cindy", text)
        uri != null -> ClipData.newRawUri("Cindy", uri)
        else -> throw Exception("CLIPBOARD_UNSUPPORTED")
      }
      withContext(Dispatchers.Main.immediate) {
        foreground()
        if (expectedVersion != null && clipboardVersion() != expectedVersion) throw Exception("CLIPBOARD_CHANGED")
        imageFile?.let { pending ->
          val published = File(pending.parentFile, pending.name.removeSuffix(".pending"))
          if (!pending.renameTo(published)) throw Exception("CLIPBOARD_UNAVAILABLE")
          imageFile = published
        }
        clipboard.setPrimaryClip(clip)
        committed = true
        // Change the token before returning even if the notification is delayed.
        clipboardGeneration.incrementAndGet()
        // Every replacement (including text/URL) reclaims published images.
        // Inspect metadata in this non-suspending publication block so concurrent
        // writes cannot escape the cap or lose their pending file. No image IO.
        // Failure to inspect the current clipboard means retaining every file.
        runCatching {
          val current = clipboard.primaryClip ?: return@runCatching
          val retained = (0 until current.itemCount).mapNotNull { current.getItemAt(it).uri }.toSet()
          val context = appContext.reactContext!!
          val images = File(context.cacheDir, "remote-clipboard").listFiles()
            ?.filter { it.extension == "png" || it.name.endsWith(".png.pending") }
            ?.sortedByDescending { it.lastModified() } ?: emptyList()
          var graceFiles = 0
          for (file in images) {
            val uri = FileProvider.getUriForFile(context, "${context.packageName}.remoteclipboard", file)
            if (uri in retained) continue
            if (file.name.endsWith(".png.pending")) {
              // Only stale files from previous processes (including legacy names).
              // Never age out this process's work, even across module recreation
              // or a long suspension. Pending files were never published as URIs.
              if (!file.name.startsWith(pendingPrefix) && System.currentTimeMillis() - file.lastModified() > 3_600_000) file.delete()
              continue
            }
            // At most three previous images (24 MiB) get a read grace period.
            if (System.currentTimeMillis() - file.lastModified() <= 3_600_000 && graceFiles < 3) {
              graceFiles++
            } else file.delete()
          }
        }
        clipboardVersion()
      }
    } finally {
      // Cancellation after publishing must not delete the image Android now owns.
      if (!committed) imageFile?.delete()
    }
  }
}
