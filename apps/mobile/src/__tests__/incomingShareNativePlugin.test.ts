import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
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
