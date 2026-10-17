import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const {
  patchShareExtension,
} = require("../../plugins/with-incoming-share-files.js");
const template = readFileSync(
  join(
    dirname(require.resolve("expo-sharing/package.json")),
    "plugin/template-files/ios/ShareIntoViewController.swift",
  ),
  "utf8",
);

function runSwiftHarness(
  label: string,
  scriptName: string,
  passMarker: string,
  skip: () => void,
) {
  const script = join(
    dirname(fileURLToPath(import.meta.url)),
    `../../scripts/${scriptName}`,
  );
  const started = performance.now();
  console.info(`[${label}] START harness (timeout=150000ms)`);
  const result = spawnSync(process.execPath, [script], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    // Each script bounds compilation at 120s and execution at 10s. Leave room
    // for Node startup and cleanup. Compilation also checks Swift availability.
    timeout: 150_000,
    killSignal: "SIGKILL",
  });
  console.info(
    `[${label}] END harness (${Math.round(performance.now() - started)}ms, status=${result.status}, error=${(result.error as NodeJS.ErrnoException | undefined)?.code ?? "none"})`,
  );
  if (result.error) throw result.error;
  // The harnesses reserve 77 for compile ENOENT, never for a timeout or failure.
  if (result.status === 77) return skip();
  expect(result.status).toBe(0);
  expect(result.stdout).toContain(passMarker);
}

it("runs the generated Swift launch and feedback behavior", ({ skip }) => {
  runSwiftHarness(
    "share-feedback",
    "test-incoming-share-feedback.mjs",
    "PASS: generated Swift share feedback",
    skip,
  );
}, 180_000);

it("parses the providers a share host can hand over", ({ skip }) => {
  runSwiftHarness(
    "share-parse",
    "test-incoming-share-parse.mjs",
    "PASS: generated Swift share parsing",
    skip,
  );
}, 180_000);

describe("incoming share native file ownership", () => {
  it("isolates both file-copy and raw-image paths without changing display names", () => {
    const patched = patchShareExtension(template);
    expect(
      patched.match(/"cindy-share-" \+ UUID\(\).uuidString/g),
    ).toHaveLength(2);
    expect(patched.match(/createDirectory\(at: directory/g)).toHaveLength(2);
    expect(
      patched.match(/directory.appendingPathComponent\(fileName\)/g),
    ).toHaveLength(2);
    expect(patched).not.toContain("removeItem(at: destinationURL)");
    expect(patched).toContain("guard !shareStarted else { return }");
    expect(patched).toContain(
      "try IncomingShareSlot.write(encoded, group: appGroupId)",
    );
    expect(patched).toContain("guard saveToUserDefaults(payload) else");
    expect(patched).toContain("enum IncomingShareSlot");
    expect(patched).not.toContain("userDefaults.set(encoded");
  });

  it("fails prebuild when upstream changes the copy contract", () => {
    expect(() =>
      patchShareExtension(
        template.replaceAll(
          "containerURL.appendingPathComponent(fileName)",
          "newCopyStrategy()",
        ),
      ),
    ).toThrow("expo-sharing template changed");
  });

  it("accepts data-only providers and asks the system for a file copy", () => {
    const patched = patchShareExtension(template);
    // Upstream ended the chain at file URLs and PDFs, so a host that vends
    // `public.data` (or a document UTI) was dropped without a trace.
    expect(patched).toContain(
      "provider.hasItemConformingToTypeIdentifier(UTType.data.identifier)",
    );
    expect(patched).toContain(
      "return await loadFilePayload(provider, identifier: identifier, type: type)",
    );
    expect(patched).toContain(
      "provider.loadFileRepresentation(forTypeIdentifier: identifier)",
    );
    expect(patched).toContain("url.startAccessingSecurityScopedResource()");
    // The name the sharing app asked for survives both the system copy and the
    // data fallback; only the last path component is ever used.
    expect(patched).toContain(
      "private func copyAndProcessFile(url: URL, type: ShareType, preferredName: String? = nil) -> SharePayload?",
    );
    expect(patched).toContain("let fileName = preferredName ?? (url.lastPathComponent.isEmpty");
    expect(patched).toContain(
      "let fileName = self.incomingShareFileName(\n            provider,",
    );
    expect(patched).toContain("let name = (suggested as NSString).lastPathComponent");
    expect(patched).toContain("guard (name as NSString).pathExtension.isEmpty else { return name }");
    // `public.text` also conforms to `public.data`, so the fallback must stay
    // behind the text branch.
    expect(
      patched.indexOf("return await handleText(provider)"),
    ).toBeLessThan(
      patched.indexOf("UTType.data.identifier) {\n      return await handleFile"),
    );
    // The upstream body that copied the vending app's URL is replaced entirely;
    // only the loader's own fallback still calls loadItem.
    expect(patched).not.toContain(
      "if let url = item as? URL {\n          let result = self.copyAndProcessFile(url: url, type: type)",
    );
  });

  it("records why a share failed without file names or paths", () => {
    const patched = patchShareExtension(template);
    expect(patched).toContain('recordShareFailure(step: "no-matching-type"');
    expect(patched).toContain('recordShareFailure(step: "save-slot", error: error)');
    // Storage failures are marked so the empty-payload branch can keep the
    // storage wording instead of "nothing was received".
    expect(patched).toContain('recordShareFailure(step: "write-data", types: [identifier], storage: true)');
    expect(patched).toContain("var shareFailureFeedback: ShareFeedback");
    expect(patched).toContain("shareFailure?.storage == true ? .saveFailed : .failed");
    expect(patched).toContain("func writeShareDiagnostic()");
    expect(patched).toContain(
      "try? IncomingShareSlot.writeDiagnostic(data, group: appGroupId)",
    );
    expect(patched).toContain('recordShareFailure(step: "load-item"');
    // The record keeps identifiers and step names only.
    const diagnosticStart = patched.indexOf("struct IncomingShareFailure");
    const diagnostic = patched.slice(
      diagnosticStart,
      patched.indexOf("private extension ShareIntoViewController {", diagnosticStart),
    );
    expect(diagnostic).not.toContain("absoluteString");
    expect(diagnostic).not.toContain("lastPathComponent");
    expect(diagnostic).not.toContain("suggestedName");
  });

  it("keeps the extension alive until launch succeeds or the user dismisses feedback", () => {
    const patched = patchShareExtension(template);
    expect(patched).not.toContain("openURL(url)\n    self.close()");
    expect(patched).toContain(
      "application.open(url, options: [:]) { [weak self] opened in",
    );
    expect(patched).toContain("self?.finishOpening(opened: opened)");
    expect(patched).toContain(
      "DispatchQueue.main.asyncAfter(deadline: .now() + 3)",
    );
    expect(patched).toContain(
      "guard !shareClosed, !openResultHandled else { return }",
    );
    expect(patched).toContain(
      "super.viewDidAppear(animated)\n    handleShare()",
    );
    expect(patched).toContain(
      "guard !shareClosed else { return }\n      if !payload.isEmpty",
    );
    expect(patched).toContain("override func didSelectCancel()");
    // Nothing received, a failed App Group write and a failed open each keep
    // their own feedback; only Cancel and Done complete the request.
    expect(patched.match(/showShareFeedback\(\.failed\)/g)).toHaveLength(1);
    expect(patched.match(/showShareFeedback\(shareFailureFeedback\)/g)).toHaveLength(1);
    expect(patched.match(/showShareFeedback\(\.saveFailed\)/g)).toHaveLength(1);
    expect(patched.match(/showShareFeedback\(\.received\)/g)).toHaveLength(1);
    expect(patched.match(/completeRequest\(returningItems:/g)).toHaveLength(1);
    expect(patched).toContain(
      "guard saveToUserDefaults(payload) else {\n          showShareFeedback(.saveFailed)",
    );
  });

  it("embeds complete localized feedback in the extension, without relying on the JS app", () => {
    const strings = require("../../plugins/incoming-share-strings.json");
    expect(Object.keys(strings).sort()).toEqual([
      "en",
      "ja",
      "ko",
      "zh-Hans",
      "zh-Hant",
    ]);
    for (const values of Object.values(strings) as Array<
      Record<string, string>
    >) {
      expect(Object.keys(values).sort()).toEqual([
        "done",
        "failedMessage",
        "failedTitle",
        "receivedMessage",
        "receivedTitle",
        "saveFailedMessage",
        "saveFailedTitle",
      ]);
      expect(
        Object.values(values).every((value) => value.trim().length > 0),
      ).toBe(true);
    }
    const patched = patchShareExtension(template);
    expect(patched).not.toContain("/* LOCALIZED_STRINGS */");
    expect(patched).toContain("UIAlertController(");
    expect(patched).toContain("preferredStyle: .alert");
  });

  it("fails prebuild if upstream changes its launch lifecycle", () => {
    expect(() =>
      patchShareExtension(
        template.replace("    self.close()\n  }", "    finishEarly()\n  }"),
      ),
    ).toThrow("expo-sharing template changed");
  });
});
