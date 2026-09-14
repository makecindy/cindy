package app.cindy.credentials

import org.json.JSONObject
import java.security.KeyPairGenerator
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec

/** Test-only JVM peer. Private keys never leave either process. */
object InteropPeer {
  @JvmStatic fun main(args: Array<String>) {
    val input = System.`in`.bufferedReader(Charsets.UTF_8)
    fun read(): String = requireNotNull(input.readLine()).also { require(it.length < 65_536) }
    fun write(value: String) { println(value); System.out.flush() }
    val fixture = JSONObject(read())
    val key = KeyPairGenerator.getInstance("EC").run {
      initialize(ECGenParameterSpec("secp256r1")); generateKeyPair()
    }
    val local = VerifiedIdentity(fixture.getString("peerId"), fixture.getString("membership"), "global", publicJwk(key.public as ECPublicKey))
    val remote = VerifiedIdentity(fixture.getString("id"), local.membership, "global", fixture.getJSONObject("publicKey"))
    val channel = CredentialChannel(local, remote, key) { System.nanoTime() / 1_000_000 }
    write(canonical(local.publicKey))
    channel.accept(read()); write(channel.offer()); write(channel.seal(ByteArray(0), "ready"))
    check(channel.open(read()).first == "ready")
    val packet = channel.open(read())
    check(packet.first == "request")
    write(channel.seal(packet.second, "response"))
    channel.close()
  }
}
