package expo.modules.cindyhtmlpreview

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File

class CindyHtmlPreviewModule : Module() {
  private val servers = mutableMapOf<String, HtmlSnapshotServer>()
  private var foreground = true
  override fun definition() = ModuleDefinition {
    Name("CindyHtmlPreview")
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
    AsyncFunction("stop") { token: String -> synchronized(servers) { servers.remove(token)?.stop(); Unit } }
    OnActivityEntersBackground { synchronized(servers) { foreground = false; stopAll() } }
    OnActivityEntersForeground { synchronized(servers) { foreground = true } }
    OnDestroy { stopAll() }
  }
  private fun stopAll() = synchronized(servers) {
    servers.values.forEach { it.stop() }
    servers.clear()
  }
}
