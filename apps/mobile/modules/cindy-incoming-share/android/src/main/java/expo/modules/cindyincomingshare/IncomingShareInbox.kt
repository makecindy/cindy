package expo.modules.cindyincomingshare

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.OpenableColumns
import android.util.AtomicFile
import android.os.Process
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.UUID
import java.util.concurrent.CopyOnWriteArraySet
import java.util.concurrent.Executors

/** One commit per complete batch. Acknowledgement never removes uploader-owned bytes. */
internal object IncomingShareInbox {
  val executor = Executors.newSingleThreadExecutor()
  val listeners = CopyOnWriteArraySet<() -> Unit>()
  private val lock = Any()
  private var cachedEpoch: Long? = null
  private var boundAccount: String? = null
  private var quarantined = false
  @Volatile private var readFailure = false
  private fun file(context: Context) = AtomicFile(File(context.noBackupFilesDir, "cindy-incoming-share.json"))
  private fun state(context: Context): JSONObject {
    val store = file(context)
    return try { store.openRead().use { JSONObject(it.readBytes().toString(Charsets.UTF_8)) } }
    catch (failure: java.io.FileNotFoundException) {
      if (store.baseFile.exists()) throw failure
      JSONObject().put("epoch", 0).put("queue", JSONArray())
    }
  }
  private fun write(context: Context, value: JSONObject) {
    val store = file(context)
    val bytes = value.toString().toByteArray(Charsets.UTF_8)
    val output = store.startWrite()
    try {
      output.write(bytes)
      output.fd.sync()
      store.finishWrite(output)
      // AtomicFile can log a failed rename instead of throwing. Never acknowledge
      // a batch until reading back the exact committed state succeeds.
      check(store.openRead().use { it.readBytes() }.contentEquals(bytes)) { "INCOMING_SHARE_ACK_FAILED" }
    } catch (failure: Exception) { store.failWrite(output); throw failure }
  }
  private fun queue(context: Context) = state(context).getJSONArray("queue")
  private fun save(context: Context, queue: JSONArray) = write(context, state(context).put("queue", queue))
  fun epoch(context: Context): Long = synchronized(lock) {
    cachedEpoch ?: state(context).getLong("epoch").also { cachedEpoch = it }
  }
  fun failed() { readFailure = true; changed() }
  fun read(context: Context): String? = synchronized(lock) {
    check(!quarantined) { "INCOMING_SHARE_COPY_FAILED" }
    if (readFailure) { readFailure = false; error("INCOMING_SHARE_COPY_FAILED") }
    val stored = state(context)
    val account = stored.optString("account")
    // Auth restoration starts with a null JS owner. Do not let a persisted A
    // batch acquire B through the mailbox's legitimate first-login transition.
    if (account.isNotEmpty() && boundAccount != account) null
    else stored.getJSONArray("queue").optString(0).takeIf { it.isNotEmpty() }
  }
  fun bindAccount(context: Context, account: String) {
    synchronized(lock) {
      val previous = state(context).optString("account")
      if (!quarantined && previous == account) { boundAccount = account; return }
      if (quarantined || (previous.isNotEmpty() && previous != account)) discardAll(context)
      write(context, state(context).put("account", account))
      boundAccount = account
    }
  }
  fun clear(context: Context, expected: String): Boolean {
    val result = synchronized(lock) {
      val queue = queue(context)
      if (queue.optString(0) != expected) false else {
        queue.remove(0)
        save(context, queue)
        true
      }
    }
    if (result) changed()
    return result
  }
  fun discardAll(context: Context) {
    synchronized(lock) {
      // Fence in-flight copies before any fallible disk operation. A committed
      // AtomicFile write can still fail readback; never reopen the old epoch.
      val nextEpoch = epoch(context) + 1
      cachedEpoch = nextEpoch
      boundAccount = null
      quarantined = true
      val old = queue(context)
      write(context, state(context).put("queue", JSONArray()).put("epoch", nextEpoch).put("account", ""))
      quarantined = false
      // Only exact app-owned UUID directories, never a URI supplied by a sender.
      for (i in 0 until old.length()) {
        val payloads = JSONObject(old.getString(i)).optJSONArray("payloads") ?: continue
        for (j in 0 until payloads.length()) deleteCopy(context, payloads.getJSONObject(j).optString("value"))
      }
    }
    changed()
  }
  private fun deleteCopy(context: Context, value: String) {
    val uri = Uri.parse(value)
    if (uri.scheme != "file") return
    val directory = File(uri.path ?: return).parentFile ?: return
    if (directory.parentFile?.canonicalFile == context.cacheDir.canonicalFile &&
      directory.name.matches(Regex("cindy-share-[a-fA-F0-9-]{36}"))) directory.deleteRecursively()
  }
  private fun changed() { listeners.forEach { listener -> try { listener() } catch (_: Exception) { /* Module disposed. */ } } }

  @Suppress("DEPRECATION")
  fun receive(context: Context, intent: Intent, generation: Long, cancelled: () -> Boolean) {
    val directories = mutableListOf<File>()
    val id = UUID.randomUUID().toString()
    val payloads = JSONArray()
    var failureCode: String? = null
    try {
      val streams = when (intent.action) {
        Intent.ACTION_SEND -> listOfNotNull(intent.getParcelableExtra<Uri>(Intent.EXTRA_STREAM))
        Intent.ACTION_SEND_MULTIPLE -> intent.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM)?.toList().orEmpty()
        else -> return
      }.ifEmpty {
        val clip = intent.clipData
        if (clip == null) emptyList() else {
          val uris = (0 until clip.itemCount).map { clip.getItemAt(it).uri }
          // A text-only ClipData accompanies ordinary EXTRA_TEXT shares. Mixed
          // file/non-file items must not silently turn into a partial file batch.
          if (uris.all { it == null }) emptyList()
          else uris.map { requireNotNull(it) { "INCOMING_SHARE_UNREADABLE" } }
        }
      }
      for (uri in streams) {
        check(!cancelled() && epoch(context) == generation) { "CANCELLED" }
        // File URIs could expose our own private files through this exported entry.
        require(uri.scheme == "content") { "INCOMING_SHARE_UNREADABLE" }
        val provider = context.packageManager.resolveContentProvider(uri.authority ?: "", 0)
        require(provider != null && provider.applicationInfo.uid != Process.myUid()) { "INCOMING_SHARE_UNREADABLE" }
        val resolver = context.contentResolver
        var name: String? = null
        resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
          val column = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
          if (column >= 0 && cursor.moveToFirst() && cursor.getType(column) == android.database.Cursor.FIELD_TYPE_STRING) {
            name = cursor.getString(column)
          }
        }
        // DISPLAY_NAME is optional. OpenableColumns specifies the URI's last
        // segment as fallback; unsafe/oversized names get a private generated name.
        val proposed = (name?.takeIf { it.isNotBlank() } ?: uri.lastPathSegment).orEmpty()
          .map { if (it == '/' || it == '\\' || it.code < 32 || it.code == 127) '_' else it }.joinToString("")
        val safeName = proposed.takeIf {
          it.isNotBlank() && it != "." && it != ".." && it.toByteArray(Charsets.UTF_8).size <= 240
        } ?: "shared-file-${UUID.randomUUID()}"
        val directory = File(context.cacheDir, "cindy-share-${UUID.randomUUID()}")
        check(directory.mkdir()) { "INCOMING_SHARE_COPY_FAILED" }
        directories.add(directory)
        val destination = File(directory, safeName)
        resolver.openInputStream(uri)?.use { input ->
          destination.outputStream().use { output ->
            val buffer = ByteArray(64 * 1024)
            while (true) {
              check(!cancelled() && epoch(context) == generation) { "CANCELLED" }
              val count = input.read(buffer)
              if (count < 0) break
              output.write(buffer, 0, count)
            }
            output.fd.sync()
          }
        } ?: error("INCOMING_SHARE_UNREADABLE")
        // Preserve bytes, including images; the existing composer owns upload policy.
        payloads.put(JSONObject().put("type", "file").put("value", Uri.fromFile(destination).toString())
          .put("preserveOriginal", true).put("mimeType",
            resolver.getType(uri)?.takeUnless { it.contains("*") }
              ?: intent.type?.takeUnless { it.contains("*") } ?: "application/octet-stream"))
      }
      intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString()?.takeIf { it.isNotBlank() }?.let {
        payloads.put(JSONObject().put("type", "text").put("value", it))
      }
      require(payloads.length() > 0) { "INCOMING_SHARE_UNREADABLE" }
    } catch (_: Exception) {
      directories.forEach { it.deleteRecursively() }
      failureCode = "INCOMING_SHARE_COPY_FAILED"
    }
    synchronized(lock) {
      if (quarantined || cancelled() || epoch(context) != generation) {
        directories.forEach { it.deleteRecursively() }
        return
      }
      val snapshot = JSONObject().put("version", 1).put("id", id)
        .put("payloads", if (failureCode == null) payloads else JSONArray())
      if (failureCode != null) snapshot.put("error", failureCode)
      try {
        val queue = queue(context)
        queue.put(snapshot.toString())
        save(context, queue)
      } catch (failure: Exception) {
        directories.forEach { it.deleteRecursively() }
        throw failure
      }
    }
    changed()
  }
}
