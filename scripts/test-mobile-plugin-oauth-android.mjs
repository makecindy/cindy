/** Real loopback lifecycle regression using the production Kotlin listener.
 * Only Expo's Promise bridge is stubbed. Requires kotlinc (or KOTLINC) and java.
 * An embedded compiler can supply KOTLIN_STDLIB instead of bundling its runtime.
 * Synthetic callbacks and compiler output live in a disposable directory.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const source = fs.readFileSync(new URL('../apps/mobile/modules/cindy-plugin-oauth/android/src/main/java/expo/modules/cindypluginoauth/CindyPluginOauthModule.kt', import.meta.url), 'utf8');
const marker = 'private class CallbackListener';
if (!source.includes(marker)) throw new Error('Production listener not found');
const imports = source.match(/^import java\..+$/gm).join('\n');
const listener = source.slice(source.indexOf(marker));
const driver = String.raw`
class Promise {
  @Volatile var value: Any? = null
  @Volatile var error: String? = null
  fun resolve(value: Any?) { this.value = value }
  fun reject(code: String, message: String, cause: Throwable?) { error = code }
}
private val state = "synthetic-provider-state-123"
private fun fixture(ttl: Long = 10000): Pair<CallbackListener, Int> {
  val port = ServerSocket(0, 1, InetAddress.getByName("127.0.0.1")).use { it.localPort }
  val listener = CallbackListener(mapOf("id" to "synthetic-listener-id", "state" to state,
    "callbackUrl" to "http://127.0.0.1:$port/callback", "expiresAt" to System.currentTimeMillis() + ttl))
  listener.start()
  return Pair(listener, port)
}
private fun expectDisconnected(client: java.net.Socket) {
  client.soTimeout = 1200
  val closed = try { client.getInputStream().read() == -1 }
    catch (error: java.net.SocketTimeoutException) { false }
    catch (error: java.net.SocketException) { true }
  check(closed) { "Accepted callback socket survived cancellation/expiry" }
}
fun main() {
  val (listener, port) = fixture()
  val pending = Promise()
  try {
    listener.waitForCallback(pending)
    java.net.Socket("127.0.0.1", port).use { client ->
      client.getOutputStream().write("G".toByteArray())
      Thread.sleep(100) // Let the production worker enter its partial-header read.
      listener.close()
      expectDisconnected(client)
    }
    check(pending.error == "PLUGIN_OAUTH_CLOSED")
  } finally { listener.close() }

  val (expiring, expiringPort) = fixture(300)
  try {
    java.net.Socket("127.0.0.1", expiringPort).use { client ->
      val writer = Thread {
        try { repeat(100) { client.getOutputStream().write(71); Thread.sleep(20) } }
        catch (_: Exception) { }
      }
      writer.start()
      try { expectDisconnected(client); check(expiring.status() == "closed") }
      finally { writer.interrupt(); writer.join(1000) }
    }
  } finally { expiring.close() }

  val (valid, validPort) = fixture()
  try {
    val result = Promise(); valid.waitForCallback(result)
    java.net.Socket("127.0.0.1", validPort).use { client ->
      client.soTimeout = 2000
      client.getOutputStream().write(("GET /callback?state=$state&code=fake-code HTTP/1.1\r\n" +
        "Host: 127.0.0.1:$validPort\r\n\r\n").toByteArray())
      check(client.getInputStream().bufferedReader().readText().startsWith("HTTP/1.1 200"))
    }
    check((result.value as Map<*, *>)["code"] == "fake-code")
    val replay = Promise(); valid.waitForCallback(replay)
    check(replay.error == "PLUGIN_OAUTH_CLOSED")
  } finally { valid.close() }
  println("Kotlin production listener: cancellation, slow-header expiry and single-use callback passed")
}
`;
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-plugin-oauth-android-'));
try {
  const file = path.join(directory, 'Main.kt'), jar = path.join(directory, 'test.jar');
  fs.writeFileSync(file, imports + '\n' + driver + '\n' + listener);
  const stdlib = process.env.KOTLIN_STDLIB;
  execFileSync(process.env.KOTLINC || 'kotlinc', [file, ...(stdlib ? ['-classpath', stdlib] : ['-include-runtime']), '-d', jar], { stdio: 'inherit', timeout: 60000 });
  execFileSync('java', stdlib ? ['-cp', [jar, stdlib].join(path.delimiter), 'MainKt'] : ['-jar', jar], { stdio: 'inherit', timeout: 15000 });
} finally { fs.rmSync(directory, { recursive: true, force: true }); }
