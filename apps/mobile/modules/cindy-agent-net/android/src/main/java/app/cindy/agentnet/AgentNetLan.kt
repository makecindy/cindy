package app.cindy.agentnet

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.os.Build
import android.os.Handler
import android.os.Looper
import java.util.ArrayDeque

/** Android's DNS-SD service owns multicast IO. Only public, signed TXT records
 * cross the bridge; the application checks membership before admitting a peer. */
class AgentNetLan(context: Context, private val id: String, private val port: Int,
  txt: Map<String, String>, private val emit: (Map<String, Any>) -> Unit) {
  private val manager = context.getSystemService(Context.NSD_SERVICE) as NsdManager
  private val main = Handler(Looper.getMainLooper())
  private var closed = false
  private var desired = txt
  private var advertised = txt
  private var registration: NsdManager.RegistrationListener? = null
  private var registered = false
  private var unregistering = false
  private val peers = mutableMapOf<String, NsdServiceInfo>()
  private val pending = ArrayDeque<String>()
  private val queued = mutableSetOf<String>()
  private var resolving = false
  private val discovery = object : NsdManager.DiscoveryListener {
    override fun onDiscoveryStarted(type: String) {}
    override fun onDiscoveryStopped(type: String) {}
    override fun onStartDiscoveryFailed(type: String, code: Int) {}
    override fun onStopDiscoveryFailed(type: String, code: Int) {}
    override fun onServiceFound(info: NsdServiceInfo) { main.post {
      if (!closed && info.serviceName.startsWith("cindy-") && info.serviceName.length <= 128 && peers.size < 128) {
        peers[info.serviceName] = info; enqueue(info.serviceName)
      }
    } }
    override fun onServiceLost(info: NsdServiceInfo) { main.post { peers.remove(info.serviceName) } }
  }
  private val refresh = object : Runnable {
    override fun run() {
      if (closed) return
      peers.keys.toList().forEach { enqueue(it) }
      main.postDelayed(this, 5000)
    }
  }
  init {
    register()
    try { manager.discoverServices("_cindy-agentnet._udp.", NsdManager.PROTOCOL_DNS_SD, discovery); main.post(refresh) }
    catch (_: Exception) { close() }
  }
  fun update(txt: Map<String, String>) {
    if (closed) return
    desired = txt
    if (registered && advertised != desired) unregister()
  }
  private fun register() {
    if (closed || registration != null) return
    advertised = desired
    val info = NsdServiceInfo().apply {
      serviceName = "cindy-$id"; serviceType = "_cindy-agentnet._udp."; setPort(this@AgentNetLan.port)
      advertised.forEach { (key, value) -> setAttribute(key, value) }
    }
    val listener = object : NsdManager.RegistrationListener {
      override fun onServiceRegistered(info: NsdServiceInfo) { main.post {
        if (registration === this) { registered = true; if (closed || advertised != desired) unregister() }
      } }
      override fun onRegistrationFailed(info: NsdServiceInfo, code: Int) { main.post {
        if (registration === this) { registration = null; registered = false; if (!closed) main.postDelayed({ register() }, 1000) }
      } }
      override fun onServiceUnregistered(info: NsdServiceInfo) { main.post {
        if (registration === this) { registration = null; registered = false; unregistering = false; register() }
      } }
      override fun onUnregistrationFailed(info: NsdServiceInfo, code: Int) { main.post { unregistering = false } }
    }
    registration = listener
    try { manager.registerService(info, NsdManager.PROTOCOL_DNS_SD, listener) }
    catch (_: Exception) { registration = null; registered = false }
  }
  private fun unregister() {
    val listener = registration ?: return
    if (!registered || unregistering) return
    unregistering = true
    try { manager.unregisterService(listener) } catch (_: Exception) { unregistering = false }
  }
  private fun enqueue(name: String) {
    if (closed || queued.contains(name) || pending.size >= 128) return
    queued.add(name); pending.add(name); resolveNext()
  }
  @Suppress("DEPRECATION")
  private fun resolveNext() {
    if (closed || resolving || pending.isEmpty()) return
    val name = pending.removeFirst(); queued.remove(name)
    val info = peers[name]
    if (info == null) { resolveNext(); return }
    resolving = true
    val listener = object : NsdManager.ResolveListener {
      override fun onResolveFailed(service: NsdServiceInfo, code: Int) { main.post { resolving = false; resolveNext() } }
      override fun onServiceResolved(service: NsdServiceInfo) { main.post {
        if (!closed) deliver(service)
        resolving = false; resolveNext()
      } }
    }
    try { manager.resolveService(info, listener) } catch (_: Exception) { resolving = false; main.post { resolveNext() } }
  }
  @Suppress("DEPRECATION")
  private fun deliver(info: NsdServiceInfo) {
    val attributes = info.attributes
    if (attributes.size > 8 || info.port !in 1..65535 || attributes.any { it.key.length > 8 || it.value.size > 200
        || it.value.any { byte -> byte.toInt() !in 0..127 } }) return
    val txt = attributes.mapValues { String(it.value, Charsets.US_ASCII) }
    val addresses = if (Build.VERSION.SDK_INT >= 34) info.hostAddresses else listOfNotNull(info.host)
    emit(mapOf("id" to id, "port" to info.port, "addresses" to addresses.take(16).mapNotNull { it.hostAddress }, "txt" to txt))
  }
  fun close() {
    if (closed) return
    closed = true; main.removeCallbacksAndMessages(null); peers.clear(); pending.clear(); queued.clear()
    try { manager.stopServiceDiscovery(discovery) } catch (_: Exception) {}
    unregister()
  }
}
