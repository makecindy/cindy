package expo.modules.cindyhtmlpreview

import java.io.ByteArrayOutputStream
import java.io.File
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.URLDecoder
import java.net.URLEncoder
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.Executors
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit

/** One bounded HTTP/1 GET/HEAD request per socket. No uploads, proxying, or directory listing. */
internal class HtmlSnapshotServer(root: String, private val entry: String, private val token: String,
  private val csp: String, files: List<List<String>>) {
  private val assets = mutableMapOf<String, Pair<File, String>>()
  private val clients = mutableSetOf<Socket>()
  private val workers = ThreadPoolExecutor(4, 4, 0, TimeUnit.SECONDS, ArrayBlockingQueue<Runnable>(12))
  private val deadlines = Executors.newSingleThreadScheduledExecutor()
  private val listener: ServerSocket
  @Volatile private var stopped = false
  private val origin get() = "http://127.0.0.1:${listener.localPort}"

  init {
    require(Regex("^[a-f0-9]{48}$").matches(token) && !csp.contains('\r') && !csp.contains('\n') && files.size <= 2000)
    val directory = File(root).canonicalFile
    files.forEach { row ->
      require(row.size == 3 && Regex("^[0-9]+$").matches(row[1]) && Regex("^[a-z]+/[a-z0-9.+-]+$").matches(row[2]))
      require(row[0].split('/').none { it.isEmpty() || it.startsWith('.') } && !row[0].contains('\\') && !row[0].contains('\u0000'))
      val key = "/" + row[0]
      val file = File(directory, row[1])
      require(!assets.containsKey(key) && file.isFile && file.canonicalPath == file.absolutePath)
      assets[key] = file to row[2]
    }
    require(assets["/$entry"]?.second == "text/html")
    listener = ServerSocket(0, 16, InetAddress.getByName("127.0.0.1"))
  }

  fun start(): String {
    Thread({
      while (!stopped) {
        val socket = try { listener.accept() } catch (_: Exception) { break }
        synchronized(clients) {
          if (stopped || clients.size >= 16) { socket.close(); return@synchronized }
          clients.add(socket)
          try {
            socket.soTimeout = 5000
            val deadline = deadlines.schedule({ try { socket.close() } catch (_: Exception) {} }, 15, TimeUnit.SECONDS)
            workers.execute {
              try { socket.use { respond(it) } } catch (_: Exception) { try { socket.close() } catch (_: Exception) {} }
              finally { deadline.cancel(false); synchronized(clients) { clients.remove(socket) } }
            }
          } catch (_: Exception) { clients.remove(socket); socket.close() }
        }
      }
    }, "cindy-html-preview").apply { isDaemon = true }.start()
    return "$origin/__cindy/$token"
  }

  fun stop() {
    stopped = true
    try { listener.close() } catch (_: Exception) {}
    synchronized(clients) { clients.forEach { try { it.close() } catch (_: Exception) {} }; clients.clear() }
    workers.shutdownNow()
    deadlines.shutdownNow()
  }

  private fun respond(socket: Socket) {
    val input = socket.getInputStream()
    val bytes = ByteArrayOutputStream()
    var tail = 0
    while (bytes.size() < 16384) {
      val byte = input.read()
      if (byte < 0) return
      bytes.write(byte)
      tail = (tail shl 8) or byte
      if (tail == 0x0d0a0d0a) break
    }
    if (tail != 0x0d0a0d0a) return
    val lines = bytes.toString("UTF-8").removeSuffix("\r\n\r\n").split("\r\n")
    val first = lines.first().split(' ')
    if (first.size != 3 || first[0] !in listOf("GET", "HEAD") || first[2] !in listOf("HTTP/1.0", "HTTP/1.1")
      || !first[1].startsWith('/') || first[1].startsWith("//")) { send(socket, 400); return }
    val headers = mutableMapOf<String, String>()
    for (line in lines.drop(1)) {
      val colon = line.indexOf(':')
      if (colon <= 0) { send(socket, 400); return }
      val key = line.substring(0, colon).lowercase(java.util.Locale.ROOT)
      if (key.trim() != key || headers.containsKey(key)) { send(socket, 400); return }
      headers[key] = line.substring(colon + 1).trim()
    }
    if (headers["host"] != origin.removePrefix("http://") || (headers["origin"] != null && headers["origin"] != origin)
      || headers["sec-fetch-site"] == "cross-site" || (headers["referer"] != null && !headers["referer"]!!.startsWith("$origin/"))
      || headers["transfer-encoding"] != null || (headers["content-length"] != null && headers["content-length"] != "0")) {
      send(socket, 403); return
    }
    val rawPath = first[1].substringBefore('?')
    if (rawPath == "/__cindy/$token") {
      val escaped = entry.split('/').joinToString("/") { URLEncoder.encode(it, "UTF-8").replace("+", "%20") }
      send(socket, 302, "Set-Cookie: cindy_$token=$token; HttpOnly; SameSite=Strict; Path=/\r\nLocation: /$escaped\r\n")
      return
    }
    if (headers["cookie"]?.split(';')?.map { it.trim() }?.contains("cindy_$token=$token") != true) { send(socket, 403); return }
    var path = try { URLDecoder.decode(rawPath.replace("+", "%2B"), "UTF-8") } catch (_: Exception) { send(socket, 400); return }
    if (path.contains('\\') || path.contains('\u0000') || path.split('/').any { it == "." || it == ".." }) { send(socket, 403); return }
    if (path.endsWith('/')) path += "index.html"
    val asset = assets[path]
    if (asset == null || !asset.first.isFile || asset.first.canonicalPath != asset.first.absolutePath) { send(socket, 404); return }
    val (file, mime) = asset
    val type = if (mime == "text/html") "$mime; charset=utf-8" else mime
    val output = socket.getOutputStream()
    file.inputStream().use { data ->
      output.write(head(200, file.length(), "Content-Type: $type\r\n").toByteArray(Charsets.UTF_8))
      if (first[0] != "HEAD") data.copyTo(output, 65536)
    }
    output.flush()
  }

  private fun head(status: Int, length: Long = 0, extra: String = ""): String =
    "HTTP/1.1 $status ${if (status == 200) "OK" else if (status == 302) "Found" else "Error"}\r\n" +
      "Connection: close\r\nContent-Length: $length\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\n" +
      "Content-Security-Policy: $csp\r\nPermissions-Policy: camera=(), microphone=(), geolocation=()\r\nReferrer-Policy: no-referrer\r\n$extra\r\n"

  private fun send(socket: Socket, status: Int, extra: String = "") {
    socket.getOutputStream().write(head(status, extra = extra).toByteArray(Charsets.UTF_8))
  }
}
