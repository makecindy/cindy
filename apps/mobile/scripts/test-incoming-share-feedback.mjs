// Executes the generated Swift launch/feedback methods with deterministic UIKit
// and clock doubles. Requires Swift; no simulator or signing is needed.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";

function runPhase(phase, command, args, timeout) {
  const started = performance.now();
  console.error(`[share-feedback] START ${phase} (timeout=${timeout}ms)`);
  try {
    execFileSync(command, args, {
      stdio: "inherit",
      timeout,
      killSignal: "SIGKILL",
    });
    console.error(
      `[share-feedback] PASS ${phase} (${Math.round(performance.now() - started)}ms)`,
    );
    return true;
  } catch (error) {
    // Compilation doubles as the capability check: a separate --version process
    // can time out before the real test starts. Only a missing compiler may skip.
    if (phase === "compile" && error.code === "ENOENT") {
      console.error("[share-feedback] SKIP compile (swiftc not found)");
      process.exitCode = 77;
      return false;
    }
    console.error(
      `[share-feedback] FAIL ${phase} (${Math.round(performance.now() - started)}ms, ${error.code ?? `exit ${error.status}`})`,
    );
    throw error;
  }
}

const require = createRequire(import.meta.url);
const { patchShareExtension } = require("../plugins/with-incoming-share-files");
const template = readFileSync(
  join(
    dirname(require.resolve("expo-sharing/package.json")),
    "plugin/template-files/ios/ShareIntoViewController.swift",
  ),
  "utf8",
);
const source = patchShareExtension(template);

function method(signature) {
  const start = source.indexOf(signature);
  if (start < 0) throw new Error(`Missing Swift method: ${signature}`);
  const body = source.indexOf("{", start);
  let depth = 1;
  let end = body + 1;
  for (; depth && end < source.length; end++) {
    if (source[end] === "{") depth++;
    if (source[end] === "}") depth--;
  }
  return source.slice(start, end).replace(/^private /, "").replace(/^override /, "");
}

const harness = `
import Foundation
enum ShareType: String { case text, url, image, audio, video, file }
struct SharePayload { let type: ShareType; let value: String; let mimeType: String; let metadata: String? }
class NSItemProvider {
  let payload: SharePayload?
  init(_ payload: SharePayload?) { self.payload = payload }
}
class NSExtensionItem {
  var attachments: [NSItemProvider]?
  var attributedContentText: NSAttributedString?
  init(_ providers: [NSItemProvider], _ text: String? = nil) {
    attachments = providers
    attributedContentText = text.map { NSAttributedString(string: $0) }
  }
}
class UIResponder { var next: UIResponder? }
class UIApplication: UIResponder {
  var calls = 0
  var reply: ((Bool) -> Void)?
  func open(_ url: URL, options: [String: String], completionHandler: @escaping (Bool) -> Void) {
    precondition(url.absoluteString == "cindy://expo-sharing")
    calls += 1
    reply = completionHandler
  }
}
enum Style { case alert, \`default\` }
class UIAlertAction {
  let handler: (UIAlertAction) -> Void
  init(title: String, style: Style, handler: @escaping (UIAlertAction) -> Void) { self.handler = handler }
}
class UIAlertController {
  let title: String
  var actions: [UIAlertAction] = []
  init(title: String, message: String, preferredStyle: Style) { self.title = title }
  func addAction(_ action: UIAlertAction) { actions.append(action) }
}
extension Double { static func now() -> Double { 0 } }
class TestQueue {
  var callbacks: [() -> Void] = []
  var deadlines: [() -> Void] = []
  func async(execute: @escaping () -> Void) { callbacks.append(execute) }
  func asyncAfter(deadline: Double, execute: @escaping () -> Void) { deadlines.append(execute) }
  func flush() { let jobs = callbacks; callbacks = []; jobs.forEach { $0() } }
  func expire() { let jobs = deadlines; deadlines = []; jobs.forEach { $0() } }
}
enum DispatchQueue { static let main = TestQueue() }
class Context {
  var completions = 0
  func completeRequest(returningItems: [String]?, completionHandler: (() -> Void)?) { completions += 1 }
}
class ShareIntoViewController: UIResponder {
  let hostAppScheme = "cindy"
  var shareClosed = false
  var openResultHandled = false
  var extensionContext: Context? = Context()
  var alerts: [UIAlertController] = []
  func present(_ alert: UIAlertController, animated: Bool) { alerts.append(alert) }
  func shareString(_ key: String) -> String { key }
  func parseProvider(_ provider: NSItemProvider) async -> SharePayload? { provider.payload }
  ${method("nonisolated private func processInputItems").replace("private func", "func")}
  ${method("func openParentApp()")}
  ${method("private func openURL(")}
  ${method("private func close()")}
  ${method("func finishOpening(")}
  ${method("func showShareFeedback(")}
  ${method("func didSelectCancel(")}
}
func check(_ condition: @autoclosure () -> Bool) { precondition(condition()) }
func make() -> (ShareIntoViewController, UIApplication) {
  let controller = ShareIntoViewController()
  let app = UIApplication()
  controller.next = app
  controller.openParentApp()
  check(app.calls == 1)
  check(controller.extensionContext!.completions == 0)
  check(controller.alerts.isEmpty)
  return (controller, app)
}
// A successful open closes only on callback, with no message; timeout cannot undo it.
do {
  let (controller, app) = make()
  app.reply!(true); DispatchQueue.main.flush(); DispatchQueue.main.expire()
  check(controller.extensionContext!.completions == 1)
  check(controller.alerts.isEmpty)
}
// Failed open stays visible until Done; duplicate and late callbacks cannot dismiss it.
do {
  let (controller, app) = make()
  app.reply!(false); DispatchQueue.main.flush()
  app.reply!(true); DispatchQueue.main.flush(); DispatchQueue.main.expire()
  check(controller.extensionContext!.completions == 0)
  check(controller.alerts.count == 1 && controller.alerts[0].title == "receivedTitle")
  let action = controller.alerts[0].actions[0]; action.handler(action)
  check(controller.extensionContext!.completions == 1)
}
// Missing responder and a missing completion both produce the manual-open fallback.
do {
  let controller = ShareIntoViewController(); controller.openParentApp()
  check(controller.alerts.count == 1)
  DispatchQueue.main.expire(); check(controller.alerts.count == 1)
  let (waiting, _) = make(); DispatchQueue.main.expire()
  check(waiting.alerts.count == 1 && waiting.extensionContext!.completions == 0)
}
// Cancel is terminal, including timeout and late callback after cancellation.
do {
  let (controller, app) = make(); controller.didSelectCancel()
  app.reply!(false); DispatchQueue.main.flush(); DispatchQueue.main.expire()
  check(controller.alerts.isEmpty && controller.extensionContext!.completions == 1)
}
// Reception failure uses its own message, and does not close until Done.
do {
  let controller = ShareIntoViewController(); controller.showShareFeedback(received: false)
  check(controller.alerts[0].title == "failedTitle")
  check(controller.extensionContext!.completions == 0)
  let action = controller.alerts[0].actions[0]; action.handler(action)
  check(controller.extensionContext!.completions == 1)
}
do {
  let controller = ShareIntoViewController(); controller.showShareFeedback(received: false, tooMany: true)
  check(controller.alerts[0].title == "tooManyTitle")
  check(controller.extensionContext!.completions == 0)
}
// Execute the actual generated item assembly and partial-failure cleanup.
let finished = DispatchSemaphore(value: 0)
Task.detached {
  let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
  defer { try? FileManager.default.removeItem(at: root); finished.signal() }
  let owned = root.appendingPathComponent("cindy-share-" + UUID().uuidString).appendingPathComponent("owned.txt")
  let referenced = root.appendingPathComponent("cindy-share-" + UUID().uuidString).appendingPathComponent("keep.txt")
  for url in [owned, referenced] {
    try! FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    try! Data("fixture".utf8).write(to: url)
  }
  let controller = ShareIntoViewController()
  let file = SharePayload(type: .file, value: owned.absoluteString, mimeType: "text/plain", metadata: nil)
  let text = SharePayload(type: .text, value: referenced.absoluteString, mimeType: "text/plain", metadata: nil)
  let failed = await controller.processInputItems([NSExtensionItem([NSItemProvider(file), NSItemProvider(text), NSItemProvider(nil)])])
  check(failed.isEmpty)
  check(!FileManager.default.fileExists(atPath: owned.path))
  check(FileManager.default.fileExists(atPath: referenced.path))
  let captioned = await controller.processInputItems([NSExtensionItem([NSItemProvider(file)], "caption")])
  check(captioned.count == 2 && captioned.last?.value == "caption")
  let duplicate = await controller.processInputItems([NSExtensionItem([NSItemProvider(text)], text.value)])
  check(duplicate.count == 1)
  let standalone = await controller.processInputItems([NSExtensionItem([], "selection")])
  check(standalone.count == 1 && standalone[0].value == "selection")
}
check(finished.wait(timeout: .now() + 5) == .success)
print("PASS: generated Swift share feedback (success, failure, timeout, missing responder, duplicate/late reply, cancel, Done)")
`;
const dir = mkdtempSync(join(tmpdir(), "cindy-share-feedback-test-"));
try {
  const file = join(dir, "main.swift");
  writeFileSync(file, harness);
  // Allow cold Swift compilation extra headroom on shared CI runners. Keep the
  // behavior executable's budget short: its clock and callbacks are simulated.
  if (runPhase("compile", "swiftc", [file, "-o", join(dir, "test")], 120_000)) {
    runPhase("execute", join(dir, "test"), [], 10_000);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
