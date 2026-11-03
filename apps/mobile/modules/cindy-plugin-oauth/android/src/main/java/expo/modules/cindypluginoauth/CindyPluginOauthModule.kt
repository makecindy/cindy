package expo.modules.cindypluginoauth

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.Promise
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.URI
import java.net.URLDecoder
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

class CindyPluginOauthModule : Module() {
  private val listeners = mutableMapOf<String, CallbackListener>()
  override fun definition() = ModuleDefinition {
    Name("CindyPluginOauth")
    AsyncFunction("start") { options: Map<String, Any> -> synchronized(listeners) {
      require(listeners.isEmpty()) { "PLUGIN_OAUTH_LISTEN_FAILED" }
      val id = options["id"] as? String ?: error("PLUGIN_OAUTH_LISTEN_FAILED")
      val receiver = CallbackListener(options)
      listeners[id] = receiver
      receiver.start()
    } }
    AsyncFunction("wait") { id: String, promise: Promise -> synchronized(listeners) {
      val listener = listeners[id]
      if (listener == null) promise.reject("PLUGIN_OAUTH_CLOSED", "Authorization listener is closed", null)
      else listener.waitForCallback(promise)
    } }
    AsyncFunction("status") { id: String -> synchronized(listeners) { listeners[id]?.status() ?: "closed" } }
    AsyncFunction("close") { id: String -> synchronized(listeners) { listeners.remove(id)?.close(); Unit } }
    OnDestroy { synchronized(listeners) { listeners.values.forEach { it.close() }; listeners.clear() } }
  }
}

private class CallbackListener(options: Map<String, Any>) {
  private val state = options["state"] as? String ?: ""
  private val expiresAt = (options["expiresAt"] as? Number)?.toLong() ?: 0
  private val callback = URI(options["callbackUrl"] as? String ?: "")
  private val host = "127.0.0.1:${callback.port}"
  private val socket = ServerSocket()
  // Expiry must run even while the socket worker is reading a partial request.
  private val worker = Executors.newScheduledThreadPool(2)
  private var activeClient: Socket? = null
  private var pending: Promise? = null
  private var result: Map<String, String>? = null
  private var closed = false
  private var consumed = false
  init {
    val id = options["id"] as? String ?: ""
    val now = System.currentTimeMillis()
    require(id.matches(Regex("^[A-Za-z0-9_-]{16,128}$")) && state.matches(Regex("^[A-Za-z0-9._~-]{16,512}$")))
    require(expiresAt > now && expiresAt <= now + 600000)
    require(callback.scheme == "http" && callback.host == "127.0.0.1" && callback.port in 1024..65535)
    require(callback.rawUserInfo == null && callback.rawQuery == null && callback.rawFragment == null)
    require(callback.rawPath.length <= 256 && callback.rawPath.matches(Regex("^/[A-Za-z0-9._~/-]*$")))
    require(callback.toString() == "http://$host${callback.rawPath}")
    try {
      socket.reuseAddress = false
      socket.bind(InetSocketAddress(InetAddress.getByName("127.0.0.1"), callback.port), 8)
      socket.soTimeout = 1000
    } catch (error: Exception) { socket.close(); worker.shutdownNow(); throw error }
  }
  fun start() {
    worker.schedule({ close() }, (expiresAt - System.currentTimeMillis()).coerceAtLeast(1), TimeUnit.MILLISECONDS)
    worker.execute {
      while (status() == "waiting") {
        if (System.currentTimeMillis() >= expiresAt) { close(); break }
        try {
          socket.accept().use { client ->
            synchronized(this) {
              if (closed) return@use
              activeClient = client
            }
            try {
              val readDeadline = minOf(expiresAt, System.currentTimeMillis() + 5000)
              val input = client.getInputStream()
              val bytes = java.io.ByteArrayOutputStream()
              var complete = false
              while (bytes.size() < 16384) {
                val remaining = readDeadline - System.currentTimeMillis()
                if (remaining <= 0) break
                client.soTimeout = remaining.coerceAtMost(5000).toInt()
                val b = input.read(); if (b < 0) break
                bytes.write(b)
                val data = bytes.toByteArray()
                if (data.size >= 4 && data.takeLast(4) == listOf<Byte>(13, 10, 13, 10)) { complete = true; break }
              }
              val value = if (complete) parse(bytes.toString("UTF-8")) else null
              val accepted = synchronized(this) {
                if (value != null && !closed && result == null && System.currentTimeMillis() < expiresAt) {
                  result = value; socket.close(); true
                } else false
              }
              val body = if (accepted) "Authorization received. Return to Cindy." else "Invalid callback."
              val response = "HTTP/1.1 ${if (accepted) "200 OK" else "400 Bad Request"}\r\nContent-Type: text/plain; charset=utf-8\r\nCache-Control: no-store\r\nContent-Security-Policy: default-src 'none'\r\nConnection: close\r\nContent-Length: ${body.toByteArray().size}\r\n\r\n$body"
              // Deliver the HTTP response before JS can close the accepted connection.
              try { client.getOutputStream().write(response.toByteArray()) }
              finally {
                synchronized(this) {
                  if (accepted && !closed) { pending?.let { consumed = true; it.resolve(result) }; pending = null }
                }
              }
            } finally {
              synchronized(this) { if (activeClient === client) activeClient = null }
            }
          }
        } catch (_: Exception) { /* Invalid/closed sockets never disclose request bytes. */ }
      }
      worker.shutdown()
    }
  }
  @Synchronized fun status() = if (result != null) "received" else if (closed) "closed" else "waiting"
  @Synchronized fun waitForCallback(promise: Promise) {
    if (consumed || pending != null || (closed && result == null)) promise.reject("PLUGIN_OAUTH_CLOSED", "Authorization listener is closed", null)
    else if (result != null) { consumed = true; promise.resolve(result) }
    else pending = promise
  }
  @Synchronized fun close() {
    closed = true; socket.close(); activeClient?.close(); activeClient = null; worker.shutdownNow()
    pending?.reject("PLUGIN_OAUTH_CLOSED", "Authorization listener is closed", null); pending = null; result = null
  }
  private fun parse(text: String): Map<String, String>? = try {
    val lines = text.split("\r\n")
    val request = lines[0].split(' ')
    require(request.size == 3 && request[0] == "GET" && request[2] in listOf("HTTP/1.0", "HTTP/1.1"))
    require(request[1].length <= 8192 && request[1].startsWith(callback.rawPath + "?"))
    val url = URI("http://$host${request[1]}")
    require(url.rawPath == callback.rawPath && url.rawFragment == null)
    val headers = mutableMapOf<String, String>()
    lines.drop(1).filter { it.isNotEmpty() }.forEach {
      val colon = it.indexOf(':'); require(colon > 0)
      val key = it.substring(0, colon).lowercase(); require(!headers.containsKey(key))
      headers[key] = it.substring(colon + 1).trim()
    }
    require(headers["host"] == host && !headers.containsKey("origin") && !headers.containsKey("transfer-encoding"))
    require(headers["content-length"] == null || headers["content-length"] == "0")
    val params = mutableMapOf<String, String>()
    (url.rawQuery ?: "").split('&').forEach {
      val pieces = it.split('=', limit = 2); require(pieces.size == 2)
      val key = URLDecoder.decode(pieces[0], "UTF-8"); val value = URLDecoder.decode(pieces[1], "UTF-8")
      require(!params.containsKey(key) && value.toByteArray().size <= 4096); params[key] = value
    }
    require(params["state"] == state && (params.containsKey("code") != params.containsKey("error")))
    val key = if (params.containsKey("code")) "code" else "error"
    val value = requireNotNull(params[key]); require(value.isNotEmpty() && value.none { it.code < 32 })
    require(key != "error" || value.matches(Regex("^[A-Za-z0-9_.-]{1,128}$")))
    mapOf("state" to state, key to value)
  } catch (_: Exception) { null }
}
