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

it("runs the generated Swift launch and feedback behavior", ({ skip }) => {
  const script = join(
    dirname(fileURLToPath(import.meta.url)),
    "../../scripts/test-incoming-share-feedback.mjs",
  );
  const started = performance.now();
  console.info("[share-feedback] START harness (timeout=150000ms)");
  const result = spawnSync(process.execPath, [script], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    // The script bounds compilation at 120s and execution at 10s. Leave room
    // for Node startup and cleanup. Compilation also checks Swift availability.
    timeout: 150_000,
    killSignal: "SIGKILL",
  });
  console.info(
    `[share-feedback] END harness (${Math.round(performance.now() - started)}ms, status=${result.status}, error=${(result.error as NodeJS.ErrnoException | undefined)?.code ?? "none"})`,
  );
  if (result.error) throw result.error;
  // The harness reserves 77 for compile ENOENT, never for a timeout or failure.
  if (result.status === 77) return skip();
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("PASS: generated Swift share feedback");
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
    // Invalid input, an empty parsed payload and a failed persistent write all
    // report reception failure, not "received" or silent completeRequest.
    expect(patched.match(/showShareFeedback\(received: false\)/g)).toHaveLength(
      3,
    );
    expect(patched.match(/completeRequest\(returningItems:/g)).toHaveLength(1);
    expect(patched).toContain(
      "guard saveToUserDefaults(payload) else {\n          showShareFeedback(received: false)",
    );
  });

  it("embeds complete localized feedback in the extension, without relying on the JS app", () => {
    const strings = require("../../plugins/incoming-share-strings.json");
    expect(Object.keys(strings).sort()).toEqual([
      "de",
      "en",
      "es",
      "fr",
      "ja",
      "ko",
      "pt-BR",
      "pt-PT",
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
        "tooManyMessage",
        "tooManyTitle",
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

it("preserves original exports ahead of previews and copies temporary URLs within callbacks", ({ skip }) => {
  const script = join(dirname(fileURLToPath(import.meta.url)), "../../scripts/test-incoming-share-formats.mjs");
  const result = spawnSync(process.execPath, [script], {
    encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], timeout: 150_000, killSignal: "SIGKILL",
  });
  if (result.error) throw result.error;
  if (result.status === 77) return skip();
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("PASS: concrete Markdown/source files and plain text previews");
  expect(result.stdout).toContain("PASS: original documents/videos beat thumbnails; real images remain images");
  expect(result.stdout).toContain("PASS: web URL survives its image thumbnail");
  expect(result.stdout).toContain("PASS: concrete property lists beat previews; Safari preprocessing remains text");
  expect(result.stdout).toContain("PASS: concrete images beat source URLs; abstract thumbnails remain previews");
  expect(result.stdout).toContain("PASS: unreadable account-boundary fence survives process restart and recovery");
  expect(result.stdout).toContain("PASS: failed rejection removal retains retry state until durable recovery");
  expect(result.stdout).toContain("PASS: Data-encoded file URLs preserve originals within provider callbacks");
  expect(result.stdout).toContain("PASS: unnamed abstract image bytes preserve concrete extensions and MIME");
  expect(result.stdout).toContain("PASS: temporary file URL copied inside provider callback");
  expect(result.stdout).toContain("PASS: durable exact-snapshot rejection, retry and replacement");
}, 180_000);
