// Native state-machine fixture: compile the PRODUCTION journal alongside these
// narrow Expo boundary doubles. All filesystem writes stay in the supplied temp
// directory. No simulator, account, real UserDefaults or application data is used.
import Foundation

enum UpdateStatus { case StatusReady, StatusEmbedded }
struct UpdatesConfig {
  let runtimeVersion: String
  let updateUrl = URL(string: "https://updates.example.invalid/manifest")!
  let scopeKey = "https://updates.example.invalid"
  let disableAntiBrickingMeasures = false
  let originalEmbeddedRequestHeaders = ["EAS-Client-ID": "00000000-0000-4000-8000-000000000000",
    "x-cindy-update-channel": ""]
  var requestHeaders: [String: String]
  init(runtime: String = "r1", channel: String = "release") {
    runtimeVersion = runtime
    requestHeaders = try! CindyOtaJournal.headers(channel)
  }
  static var fixture = UpdatesConfig()
  static func cindyEmbeddedConfiguration() throws -> UpdatesConfig { fixture }
  static func config(fromConfig config: UpdatesConfig, configOverride: UpdatesConfigOverride?) throws -> UpdatesConfig {
    var result = config
    result.requestHeaders = configOverride?.requestHeaders ?? config.originalEmbeddedRequestHeaders
    return result
  }
}
struct UpdatesConfigOverride {
  let updateUrl: URL?
  let requestHeaders: [String: String]?
  static var saved: UpdatesConfigOverride?
  static func save(configOverride: UpdatesConfigOverride?) { saved = configOverride }
}
final class Update {
  let updateId: UUID
  let runtimeVersion: String
  let scopeKey: String
  let commitTime: Date
  let status: UpdateStatus
  let url: URL?
  let requestHeaders: [String: String]?
  var failedLaunchCount = 0
  var successfulLaunchCount = 0
  init(_ sequence: Int, channel: String = "release", embedded: Bool = false, runtime: String = "r1", time: Int? = nil) {
    updateId = UUID(uuidString: String(format: "00000000-0000-4000-8000-%012d", sequence))!
    runtimeVersion = runtime
    scopeKey = UpdatesConfig.fixture.scopeKey
    commitTime = Date(timeIntervalSince1970: Double(time ?? sequence))
    status = embedded ? .StatusEmbedded : .StatusReady
    url = UpdatesConfig.fixture.updateUrl
    requestHeaders = try! CindyOtaJournal.headers(embedded ? "release" : channel)
  }
}
final class FixtureController {
  var lastHeaders: [String: String]?
  func setUpdateRequestHeadersOverride(_ headers: [String: String]?) throws {
    lastHeaders = headers
    UpdatesConfigOverride.save(configOverride: UpdatesConfigOverride(updateUrl: nil, requestHeaders: headers))
  }
}
enum AppController { static let sharedInstance = FixtureController() }

@main
struct JournalTests {
  static func expect(_ condition: Bool, _ label: String) {
    guard condition else { fatalError("FAILED: " + label) }
  }
  static func main() throws {
    let root = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
    let directory = root.appendingPathComponent("journal-cases", isDirectory: true)
    let embedded = Update(1, embedded: true)
    let release = Update(2)
    let beta = Update(3, channel: "beta")
    let canary = Update(4, channel: "canary")
    let unrelated = Update(5)
    let defaults = UpdatesConfig.fixture
    try CindyOtaJournal.validateHeaders(nil)
    do {
      try CindyOtaJournal.validateHeaders(["x-cindy-update-channel": "beta"])
      fatalError("FAILED: missing shared ID was accepted")
    } catch {}
    var binary = embedded
    func reboot() throws {
      try CindyOtaJournal.prepare(storageDirectoryForTesting: directory)
      CindyOtaJournal.observeEmbedded(binary)
    }
    func selected(_ list: [Update]) -> Update? { CindyOtaJournal.select(list, config: defaults)?.update }
    func fetch(_ update: Update, channel: String) throws -> String {
      let token = try CindyOtaJournal.begin(channel)
      try CindyOtaJournal.downloaded(update, config: UpdatesConfig(channel: channel))
      return token
    }

    // Fresh binary migration removes the entire old override, not only its URL.
    UpdatesConfigOverride.saved = UpdatesConfigOverride(updateUrl: URL(string: "https://legacy.example.invalid"), requestHeaders: [:])
    try reboot()
    expect(UpdatesConfigOverride.saved == nil, "old complete override removed")
    expect(selected([embedded, unrelated]) === embedded, "unrecorded cached OTA is not adopted")
    CindyOtaJournal.confirmed(embedded)
    let releaseToken = try fetch(release, channel: "release")
    try CindyOtaJournal.finish(releaseToken)
    try CindyOtaJournal.selected(release)
    CindyOtaJournal.confirmed(release)
    expect(CindyOtaJournal.pinned(release.updateId), "successful release resources are pinned")
    expect(!CindyOtaJournal.pinned(unrelated.updateId), "pin is an explicit allowlist")

    // Process death after changing headers but before a completed download.
    _ = try CindyOtaJournal.begin("beta")
    try reboot()
    expect(selected([embedded, release, beta]) === release, "interrupted request restores release")
    expect(try CindyOtaJournal.currentHeaders() == CindyOtaJournal.headers("release"), "restored canonical release headers")

    // Native download commit survives destruction before the JS callback/finally.
    _ = try fetch(beta, channel: "beta")
    try reboot()
    expect(selected([embedded, release, beta]) === beta, "downloaded candidate survives killed JS")
    expect(CindyOtaJournal.pinned(release.updateId) && CindyOtaJournal.pinned(beta.updateId), "old and pending assets survive reaping")
    try CindyOtaJournal.selected(beta)
    // Refetching a cached ID must not reset its launch attempts.
    let betaToken = try fetch(beta, channel: "beta")
    try CindyOtaJournal.finish(betaToken)
    try reboot()
    expect(selected([embedded, release, beta]) === beta, "one bounded retry remains")
    try CindyOtaJournal.selected(beta)
    try reboot()
    expect(selected([embedded, release, beta]) === release, "two unconfirmed launches restore known-good")
    expect(!CindyOtaJournal.pinned(beta.updateId), "rejected candidate is unpinned")

    // An in-process pre-content error must repair state/config before relaunch.
    let canaryToken = try fetch(canary, channel: "canary")
    try CindyOtaJournal.finish(canaryToken)
    try CindyOtaJournal.selected(canary)
    expect(CindyOtaJournal.failed(canary), "pending native failure is handled")
    expect(selected([embedded, release, canary]) === release, "same-process rollback chooses release")
    expect(AppController.sharedInstance.lastHeaders == (try CindyOtaJournal.headers("release")), "same-process config repaired")

    let nextBeta = Update(6, channel: "beta")
    let nextToken = try fetch(nextBeta, channel: "beta")
    try CindyOtaJournal.finish(nextToken)
    try CindyOtaJournal.selected(nextBeta)
    CindyOtaJournal.confirmed(nextBeta)
    expect(!CindyOtaJournal.failed(nextBeta), "never auto-rollback after content appeared")
    try reboot()
    expect(selected([embedded, release, nextBeta]) === nextBeta, "successful candidate is the next baseline")
    expect(!CindyOtaJournal.pinned(release.updateId), "superseded good is not pinned forever")
    try CindyOtaJournal.rolledBackToEmbedded()
    expect(selected([embedded, nextBeta]) === embedded, "accepted Expo rollback directive wins over journal")

    let promoted = Update(8, channel: "beta")
    let promoteToken = try CindyOtaJournal.begin("release")
    try CindyOtaJournal.downloaded(promoted, config: UpdatesConfig(channel: "release"))
    try CindyOtaJournal.finish(promoteToken)
    expect(selected([embedded, promoted]) === promoted, "cached ID uses the DB identity, not the new response headers")
    CindyOtaJournal.confirmed(promoted)
    let olderBinary = Update(7, embedded: true)
    binary = olderBinary
    try reboot()
    expect(selected([embedded, olderBinary, promoted]) === promoted, "newer OTA survives older same-runtime binary")
    let equalBinary = Update(9, embedded: true, time: 8)
    binary = equalBinary
    try reboot()
    expect(selected([equalBinary, promoted]) === promoted, "equal timestamp OTA survives binary replacement")
    let newerBinary = Update(10, embedded: true)
    binary = newerBinary
    try reboot()
    expect(selected([embedded, newerBinary, promoted]) === newerBinary, "newer binary is not hidden by old good OTA")
    expect(!CindyOtaJournal.pinned(promoted.updateId), "older OTA no longer pins after binary replacement")
    CindyOtaJournal.confirmed(newerBinary)
    let explicitOlder = Update(6)
    try CindyOtaJournal.finish(fetch(explicitOlder, channel: "release"))
    try reboot()
    expect(selected([newerBinary, explicitOlder]) === explicitOlder, "normal boot does not impose a new embedded floor")
    CindyOtaJournal.confirmed(explicitOlder)
    let newerPending = Update(12, channel: "beta")
    try CindyOtaJournal.finish(fetch(newerPending, channel: "beta"))
    let nextBinary = Update(11, embedded: true)
    binary = nextBinary
    try reboot()
    expect(selected([nextBinary, newerPending]) === newerPending, "newer pending is retained across binary replacement")
    expect(CindyOtaJournal.failed(newerPending), "retained candidate can fail")
    expect(selected([newerBinary, nextBinary, newerPending]) === nextBinary, "failed retained OTA falls back to this binary only")

    // Native runtime change invalidates receipts; it does not try to run an old OTA.
    UpdatesConfig.fixture = UpdatesConfig(runtime: "r2")
    let embedded2 = Update(7, embedded: true, runtime: "r2")
    binary = embedded2
    try reboot()
    expect(CindyOtaJournal.select([embedded2, release], config: UpdatesConfig.fixture)?.update === embedded2,
      "new runtime starts its new embedded bundle")
    expect(!CindyOtaJournal.pinned(nextBeta.updateId), "old runtime pin removed")

    // An unavailable auxiliary store disables OTA, not the app or user data.
    let notDirectory = root.appendingPathComponent("not-a-directory")
    try Data("fixture".utf8).write(to: notDirectory)
    try CindyOtaJournal.prepare(storageDirectoryForTesting: notDirectory)
    CindyOtaJournal.observeEmbedded(embedded2)
    expect(CindyOtaJournal.capabilities()["available"] as? Bool == false, "I/O failure disables the adapter")
    expect(CindyOtaJournal.select([embedded2, Update(15, runtime: "r2")], config: UpdatesConfig.fixture)?.update === embedded2,
      "unavailable journal cannot adopt unrecorded release cache")
    do {
      _ = try CindyOtaJournal.begin("release")
      fatalError("FAILED: unavailable journal admitted a request")
    } catch {}
    print("PASS: native journal migration, kill windows, pending retry, same-process rollback, pinning, runtime and I/O cases")
  }
}
