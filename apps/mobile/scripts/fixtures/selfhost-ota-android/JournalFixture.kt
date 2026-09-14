package expo.modules.updates

import android.content.Context
import expo.modules.updates.db.entity.UpdateEntity
import expo.modules.updates.db.enums.UpdateStatus
import java.io.File
import java.util.Date
import java.util.UUID

fun main(args: Array<String>) {
  val root = File(args[0])
  val context = Context(File(root, "journal-cases"))
  UpdatesController.instance.context = context
  fun config(channel: String = "release") = UpdatesConfiguration(context, null, false,
    UpdatesConfigurationOverride(null, CindyOtaJournal.headers(channel)))
  fun update(sequence: Int, channel: String = "release", embedded: Boolean = false): UpdateEntity = UpdateEntity(
    UUID.fromString("00000000-0000-4000-8000-" + sequence.toString().padStart(12, '0')),
    UpdatesConfiguration.fixtureRuntime, config().scopeKey,
    if (embedded) UpdateStatus.EMBEDDED else UpdateStatus.READY,
    config().updateUrl, CindyOtaJournal.headers(if (embedded) "release" else channel), Date(sequence.toLong())
  )
  fun selected(vararg updates: UpdateEntity) = CindyOtaJournal.select(updates.toList(), config())?.update
  fun fetch(update: UpdateEntity, channel: String): String {
    val token = CindyOtaJournal.begin(channel)
    CindyOtaJournal.downloaded(update, config(channel))
    return token
  }
  val embedded = update(1, embedded = true)
  val release = update(2)
  val beta = update(3, "beta")
  val canary = update(4, "canary")
  val unrelated = update(5)
  var binary = embedded
  fun reboot() {
    CindyOtaJournal.prepare(context)
    CindyOtaJournal.observeEmbedded(binary)
  }
  CindyOtaJournal.validateHeaders(null)
  check(runCatching { CindyOtaJournal.validateHeaders(mapOf("x-cindy-update-channel" to "beta")) }.isFailure)

  context.preferences.strings["updatesConfigOverride"] = "legacy malformed override"
  reboot()
  check(!context.preferences.strings.containsKey("updatesConfigOverride"))
  check(selected(embedded, unrelated) === embedded)
  CindyOtaJournal.confirmed(embedded)
  CindyOtaJournal.finish(fetch(release, "release"))
  CindyOtaJournal.selected(release)
  CindyOtaJournal.confirmed(release)
  check(CindyOtaJournal.pinned(release.id) && !CindyOtaJournal.pinned(unrelated.id))

  CindyOtaJournal.begin("beta")
  reboot()
  check(selected(embedded, release, beta) === release)
  check(CindyOtaJournal.currentHeaders() == CindyOtaJournal.headers("release"))
  fetch(beta, "beta")
  reboot()
  check(selected(embedded, release, beta) === beta)
  check(CindyOtaJournal.pinned(release.id) && CindyOtaJournal.pinned(beta.id))
  CindyOtaJournal.selected(beta)
  CindyOtaJournal.finish(fetch(beta, "beta"))
  reboot()
  check(selected(embedded, release, beta) === beta)
  CindyOtaJournal.selected(beta)
  reboot()
  check(selected(embedded, release, beta) === release)
  check(!CindyOtaJournal.pinned(beta.id))

  CindyOtaJournal.finish(fetch(canary, "canary"))
  CindyOtaJournal.selected(canary)
  check(CindyOtaJournal.failed(canary))
  check(selected(embedded, release, canary) === release)
  check(UpdatesController.instance.lastHeaders == CindyOtaJournal.headers("release"))
  val nextBeta = update(6, "beta")
  CindyOtaJournal.finish(fetch(nextBeta, "beta"))
  CindyOtaJournal.selected(nextBeta)
  CindyOtaJournal.confirmed(nextBeta)
  check(!CindyOtaJournal.failed(nextBeta))
  reboot()
  check(selected(embedded, release, nextBeta) === nextBeta)
  check(!CindyOtaJournal.pinned(release.id))
  CindyOtaJournal.rolledBackToEmbedded()
  check(selected(embedded, nextBeta) === embedded)

  // Expo reuses the DB download identity when an identical ID moves channels.
  val promoted = update(8, "beta")
  val promoteToken = CindyOtaJournal.begin("release")
  CindyOtaJournal.downloaded(promoted, config("release"))
  CindyOtaJournal.finish(promoteToken)
  check(selected(embedded, promoted) === promoted)
  CindyOtaJournal.confirmed(promoted)
  val olderBinary = update(7, embedded = true)
  binary = olderBinary
  reboot()
  check(selected(embedded, olderBinary, promoted) === promoted)
  val equalBinary = update(9, embedded = true).copy(commitTime = promoted.commitTime)
  binary = equalBinary
  reboot()
  check(selected(equalBinary, promoted) === promoted)
  val newerBinary = update(10, embedded = true)
  binary = newerBinary
  reboot()
  check(selected(embedded, newerBinary, promoted) === newerBinary)
  check(!CindyOtaJournal.pinned(promoted.id))
  CindyOtaJournal.confirmed(newerBinary)
  // A deliberately requested older channel after installation is not pruned on
  // every boot; only an actual change to the binary identity triggers pruning.
  val explicitOlder = update(6, "release")
  CindyOtaJournal.finish(fetch(explicitOlder, "release"))
  reboot()
  check(selected(newerBinary, explicitOlder) === explicitOlder)
  CindyOtaJournal.confirmed(explicitOlder)
  val newerPending = update(12, "beta")
  CindyOtaJournal.finish(fetch(newerPending, "beta"))
  val nextBinary = update(11, embedded = true)
  binary = nextBinary
  reboot()
  check(selected(nextBinary, newerPending) === newerPending)
  check(CindyOtaJournal.failed(newerPending))
  check(selected(newerBinary, nextBinary, newerPending) === nextBinary)

  UpdatesConfiguration.fixtureRuntime = "r2"
  val embedded2 = update(7, embedded = true)
  binary = embedded2
  reboot()
  check(selected(embedded2, release) === embedded2)
  check(!CindyOtaJournal.pinned(nextBeta.id))
  val notDirectory = File(root, "not-a-directory").apply { writeText("fixture") }
  val unavailable = Context(notDirectory)
  unavailable.preferences.writable = false
  CindyOtaJournal.prepare(unavailable)
  CindyOtaJournal.observeEmbedded(embedded2)
  check(CindyOtaJournal.capabilities()["available"] == false)
  check(selected(embedded2, update(15)) === embedded2)
  check(runCatching { CindyOtaJournal.begin("release") }.isFailure)
  println("PASS: Android journal migration, kill windows, pending retry, same-process rollback, pinning, runtime and I/O cases")
}
