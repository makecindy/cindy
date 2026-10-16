// Executes the generated extension's provider parsing against real
// NSItemProvider inputs, the same API a share host hands over on iOS. Requires
// Swift; no simulator, signing or device. The App Group slot is out of reach for
// a command line process, so the loader's copy/write helpers are doubled with
// the per-share directory contract the patched template implements.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";

function runPhase(phase, command, args, timeout) {
  const started = performance.now();
  console.error(`[share-parse] START ${phase} (timeout=${timeout}ms)`);
  try {
    execFileSync(command, args, {
      stdio: "inherit",
      timeout,
      killSignal: "SIGKILL",
    });
    console.error(
      `[share-parse] PASS ${phase} (${Math.round(performance.now() - started)}ms)`,
    );
    return true;
  } catch (error) {
    // Compilation doubles as the capability check: a separate --version process
    // can time out before the real test starts. Only a missing compiler may skip.
    if (phase === "compile" && error.code === "ENOENT") {
      console.error("[share-parse] SKIP compile (swiftc not found)");
      process.exitCode = 77;
      return false;
    }
    console.error(
      `[share-parse] FAIL ${phase} (${Math.round(performance.now() - started)}ms, ${error.code ?? `exit ${error.status}`})`,
    );
    throw error;
  }
}

const require = createRequire(import.meta.url);
const { patchShareExtension } = require("../plugins/with-incoming-share-files");
const sharingRoot = dirname(require.resolve("expo-sharing/package.json"));
const template = readFileSync(
  join(sharingRoot, "plugin/template-files/ios/ShareIntoViewController.swift"),
  "utf8",
);
const source = patchShareExtension(template);
const protocol = readFileSync(
  join(sharingRoot, "ios/shared/ShareProtocol.swift"),
  "utf8",
);
const constants = readFileSync(
  join(sharingRoot, "ios/shared/Constants.swift"),
  "utf8",
);

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
  return source
    .slice(start, end)
    .replace(/^private /, "")
    .replace(/^override /, "");
}

const harness = `
import Foundation
import UniformTypeIdentifiers
${protocol}
${constants}

// UIKit is not available for a command line tool; the loader only asks an image
// for PNG data, and no test provider vends a UIImage.
class UIImage { func pngData() -> Data? { nil } }

${method("struct IncomingShareFailure")}
${method("enum ShareFeedback: String {")}
${method("private extension UUID")}

final class ShareIntoViewController {
  var shareFailure: IncomingShareFailure?
  var copied: [String] = []
  var failWrites = false
  ${method("func parseProvider(")}
  ${method("private func handleFile(")}
  ${method("private func handleText(")}
  ${method("private func handleWebURL(")}
  ${method("func loadFilePayload(")}
  ${method("private func loadFileRepresentation(")}
  ${method("private func loadItem(")}
  ${method("func incomingShareFileName(")}
  ${method("var shareFailureFeedback: ShareFeedback")}
  ${method("func recordShareFailure(")}
  // Doubles for the App Group helpers: the real ones need the group container,
  // which a command line process does not have. They keep the same contract
  // (per-share directory, preferredName) that incomingShareNativePlugin.test.ts
  // asserts on the generated template.
  func copyAndProcessFile(url: URL, type: ShareType, preferredName: String? = nil) -> SharePayload? {
    guard let data = try? Data(contentsOf: url) else { return nil }
    return saveDataToAppGroup(
      data: data,
      fileName: preferredName ?? url.lastPathComponent,
      type: type,
      mimeType: "application/octet-stream"
    )
  }
  func saveDataToAppGroup(data: Data, fileName: String, type: ShareType, mimeType: String?) -> SharePayload? {
    if failWrites { return nil }
    let directory = "cindy-share-" + UUID().uuidString
    copied.append(fileName)
    return SharePayload(type: type, value: "file:///" + directory + "/" + fileName, mimeType: mimeType ?? "application/octet-stream", metadata: nil)
  }
}

func check(_ condition: @autoclosure () -> Bool, _ message: String) {
  if !condition() { fatalError("FAIL: \\(message)") }
}

func dataOnlyProvider() -> NSItemProvider {
  let provider = NSItemProvider()
  provider.suggestedName = "wechat-file.zip"
  provider.registerItem(forTypeIdentifier: UTType.data.identifier) { completion, _, _ in
    completion?(Data(repeating: 0x42, count: 64) as NSData, nil)
  }
  return provider
}

func sourceFile() -> URL {
  let url = FileManager.default.temporaryDirectory.appendingPathComponent("incoming-share-parse-source.zip")
  try? Data(repeating: 0x41, count: 32).write(to: url)
  return url
}

func fileRepresentationOnlyProvider() -> NSItemProvider {
  let provider = NSItemProvider()
  provider.suggestedName = "wechat-file.zip"
  let source = sourceFile()
  provider.registerFileRepresentation(forTypeIdentifier: UTType.zip.identifier, visibility: .all) { completion in
    completion(source, false, nil)
    return nil
  }
  return provider
}

func unsupportedProvider() -> NSItemProvider {
  let provider = NSItemProvider()
  provider.registerItem(forTypeIdentifier: "com.example.unknown-share-type") { completion, _, _ in
    completion?(Data(repeating: 0x43, count: 8) as NSData, nil)
  }
  return provider
}

func textProvider() -> NSItemProvider {
  let provider = NSItemProvider()
  provider.registerItem(forTypeIdentifier: UTType.text.identifier) { completion, _, _ in
    completion?("hello" as NSString, nil)
  }
  return provider
}

Task.detached {
  let controller = ShareIntoViewController()

  // A host that only vends plain data used to be dropped before it was read.
  let dataOnly = await controller.parseProvider(dataOnlyProvider())
  check(dataOnly != nil, "a public.data provider must reach the file branch")
  check(dataOnly?.type == .file, "a public.data provider stays a file")
  check(dataOnly?.mimeType == "application/octet-stream", "mime falls back to octet-stream")
  check(controller.shareFailure == nil, "a served provider leaves no diagnostic")

  check(dataOnly?.value.hasSuffix("wechat-file.zip") == true, "the provider's own name survives the data fallback")

  // No file URL at all: loadFileRepresentation is what makes this work.
  let representation = await controller.parseProvider(fileRepresentationOnlyProvider())
  check(representation != nil, "a file-representation provider must be copied")
  check(representation?.value.hasSuffix("wechat-file.zip") == true, "the system copy keeps the provider's name")

  let text = await controller.parseProvider(textProvider())
  check(text?.type == .text, "the text branch is unchanged")

  // Nothing matched: the extension reports a failure *and* records what the
  // provider advertised, which is what a field report needs.
  let unsupported = await controller.parseProvider(unsupportedProvider())
  check(unsupported == nil, "an unsupported provider still fails")
  check(controller.shareFailure?.step == "no-matching-type", "the failing step is recorded")
  check(controller.shareFailure?.types == ["com.example.unknown-share-type"], "the providers types are recorded")
  check(controller.shareFailure?.json != nil, "the diagnostic serializes without file names")
  let diagnostic = String(data: controller.shareFailure!.json!, encoding: .utf8) ?? ""
  check(!diagnostic.contains("wechat-file.zip"), "the diagnostic carries no file name")

  // Content that was read but could not be stored is a storage failure, not
  // "nothing arrived": the feedback must say so.
  let failingController = ShareIntoViewController()
  failingController.failWrites = true
  let unwritable = await failingController.parseProvider(dataOnlyProvider())
  check(unwritable == nil, "an unwritable copy produces no payload")
  check(failingController.shareFailureFeedback == .saveFailed, "a storage failure keeps the storage wording")
  check(failingController.shareFailure?.step == "write-data", "the failing step names the write")

  let unreadableController = ShareIntoViewController()
  let unreadable = await unreadableController.parseProvider(unsupportedProvider())
  check(unreadable == nil, "an unsupported provider still fails")
  check(unreadableController.shareFailureFeedback == .failed, "a read failure keeps the reception wording")

  print("PASS: generated Swift share parsing (data-only + original name, file representation, text, unsupported, storage failure, diagnostic)")
  exit(0)
}
RunLoop.main.run()
`;

const dir = mkdtempSync(join(tmpdir(), "cindy-share-parse-test-"));
try {
  const file = join(dir, "main.swift");
  writeFileSync(file, harness);
  // Allow cold Swift compilation extra headroom on shared CI runners. Keep the
  // behavior executable's budget short: its providers resolve in-process.
  if (runPhase("compile", "swiftc", [file, "-o", join(dir, "test")], 120_000)) {
    runPhase("execute", join(dir, "test"), [], 10_000);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
