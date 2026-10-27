package expo.modules.cindyhtmlpreview

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import android.os.Handler
import android.os.Looper
import android.view.View
import android.webkit.CookieManager
import expo.modules.kotlin.Promise

class CindyHtmlPreviewModule : Module() {
  private val servers = mutableMapOf<String, HtmlSnapshotServer>()
  private val appServers = mutableMapOf<String, HtmlSnapshotServer>()
  // A retiring WebView can still be detaching after JS stops its HTTP server.
  // Never assign its origin to another App in this process. Across process
  // restarts the trusted storage bootstrap clears that origin before App HTML.
  private companion object {
    val issuedAppOrigins = mutableSetOf<String>()
  }
  private val handler = Handler(Looper.getMainLooper())
  private var foreground = true
  override fun definition() = ModuleDefinition {
    Name("CindyHtmlPreview")
    Events("resourceRequest", "resourceClosed")
    Constant("appHostAvailable") { true }
    View(HtmlAppHost::class) {
      Name("AppHost")
      Prop("surfaceId") { view: HtmlAppHost, id: String -> view.surfaceId = id }
      GroupView<HtmlAppHost> {
        AddChildView { parent: HtmlAppHost, child: View, index: Int ->
          parent.content.addView(child, index, android.widget.FrameLayout.LayoutParams(-1, -1))
          HtmlAppSurfaces.attach(parent.surfaceId)
        }
        GetChildCount { parent: HtmlAppHost -> parent.content.childCount }
        GetChildViewAt { parent: HtmlAppHost, index: Int -> parent.content.getChildAt(index) }
        RemoveChildViewAt { parent: HtmlAppHost, index: Int -> parent.content.removeViewAt(index) }
        RemoveChildView { parent: HtmlAppHost, child: View -> parent.content.removeView(child) }
      }
    }
    View(HtmlAppSlot::class) {
      Name("AppSlot")
      Prop("surfaceId") { view: HtmlAppSlot, id: String -> view.surfaceId = id }
    }
    AsyncFunction("startApp") { root: String, entry: String, token: String, csp: String, files: List<List<String>>, promise: Promise ->
      var created: HtmlSnapshotServer? = null
      fun reject(error: Exception) {
        synchronized(servers) {
          if (created != null && appServers[token] === created) stopApp(token)
        }
        promise.reject("HTML_PREVIEW_START_FAILED", "Unable to start App resource", error)
      }
      try {
        val url = synchronized(servers) {
          val cache = File(requireNotNull(appContext.reactContext).cacheDir, "mcp-apps").canonicalPath
          require(File(root).canonicalPath.startsWith(cache + File.separator))
          require(foreground && appServers.size < 16 && !appServers.containsKey(token))
          val server = allocateAppServer(root, entry, token, csp, files)
          created = server
          appServers[token] = server
          server.start()
        }
        handler.post {
          try {
            synchronized(servers) { require(appServers[token] === created) }
            // Storage is cleared by the trusted bootstrap, which can await
            // completion. WebStorage.deleteOrigin has no completion callback.
            promise.resolve(url)
          } catch (error: Exception) { reject(error) }
        }
      } catch (error: Exception) { reject(error) }
    }
    AsyncFunction("start") { root: String, entry: String, token: String, csp: String, files: List<List<String>> ->
      synchronized(servers) {
        val cache = requireNotNull(appContext.reactContext).cacheDir.canonicalPath
        require(File(root).canonicalPath.startsWith(cache + File.separator))
        require(foreground && servers.size < 4 && !servers.containsKey(token))
        val server = HtmlSnapshotServer(root, entry, token, csp, files)
        servers[token] = server
        server.start()
      }
    }
    AsyncFunction("startOnDemand") { root: String, entry: String, token: String, csp: String ->
      synchronized(servers) {
        val cache = requireNotNull(appContext.reactContext).cacheDir.canonicalPath
        require(File(root).canonicalPath.startsWith(cache + File.separator))
        require(foreground && servers.size < 4 && !servers.containsKey(token))
        val server = HtmlSnapshotServer(root, entry, token, csp, emptyList(),
          onRequest = { id, path -> sendEvent("resourceRequest", mapOf("token" to token, "id" to id, "path" to path)) },
          onClose = { id -> sendEvent("resourceClosed", mapOf("token" to token, "id" to id)) })
        servers[token] = server
        server.start()
      }
    }
    AsyncFunction("resolveRequest") { token: String, id: String, filename: String, mime: String, status: Int ->
      synchronized(servers) { servers[token]?.resolve(id, filename, mime, status) ?: false }
    }
    AsyncFunction("stop") { token: String -> synchronized(servers) {
      servers.remove(token)?.stop(); stopApp(token); Unit
    } }
    OnActivityEntersBackground { synchronized(servers) {
      foreground = false
      stopPreviews()
      val tokens = appServers.keys.toList()
      handler.postDelayed({ synchronized(servers) { tokens.forEach { stopApp(it) } } }, 1000)
    } }
    OnActivityEntersForeground { synchronized(servers) { foreground = true } }
    OnDestroy { stopAll() }
  }
  private fun stopAll() = synchronized(servers) {
    stopPreviews()
    appServers.keys.toList().forEach { stopApp(it) }
  }
  private fun stopPreviews() {
    servers.values.forEach { it.stop() }
    servers.clear()
  }
  private fun stopApp(token: String) {
    val server = appServers.remove(token) ?: return
    val origin = server.origin
    server.stop()
    handler.post {
      try {
        CookieManager.getInstance().setCookie(origin, "cindy_$token=; Max-Age=0; Path=/")
      } catch (_: Exception) {}
    }
  }
  private fun allocateAppServer(root: String, entry: String, token: String, csp: String, files: List<List<String>>): HtmlSnapshotServer {
    repeat(128) {
      val candidate = HtmlSnapshotServer(root, entry, token, csp, files)
      if (synchronized(issuedAppOrigins) { issuedAppOrigins.add(candidate.origin) }) return candidate
      candidate.stop()
    }
    throw IllegalStateException("MCP_APP_ORIGIN_CAPACITY")
  }
}
