import { describe, expect, it } from "vitest";
import {
  ghostHarnessPermissionKeys,
  parseGhostHarnessNeeds,
} from "../harness.js";
import { validateGhostManifest } from "../manifest.js";

const base = {
  schemaVersion: 3,
  minCindyVersion: "0.1.0",
  id: "runtime-observer",
  name: "Runtime observer",
  version: "1.0.0",
  entry: "main.js",
};

describe("Harness declarations", () => {
  it("keeps engine-specific hooks and non-common detailed queries dormant", () => {
    const result = validateGhostManifest({
      ...base,
      harness: { read: ["context"], hooks: ["claude.tool.before"] },
    });
    expect(result.ok).toBe(true);
    if (result.ok)
      expect(ghostHarnessPermissionKeys(result.manifest.harness)).toEqual([]);
  });
  it("keeps unknown hooks dormant without imposing a resident requirement", () => {
    const result = validateGhostManifest({
      ...base,
      harness: { hooks: ["future.hook"] },
    });
    expect(result.ok).toBe(true);
    if (result.ok)
      expect(ghostHarnessPermissionKeys(result.manifest.harness)).toEqual([]);
  });
  it("preserves future names/fields across normalization without granting them", () => {
    const harness = {
      read: ["runtime", "future.state"],
      actions: ["native.future"],
      future: { mode: "x" },
    };
    const first = validateGhostManifest({ ...base, harness });
    expect(first).toMatchObject({ ok: true, manifest: { harness } });
    if (!first.ok) return;
    expect(validateGhostManifest(first.manifest)).toMatchObject({
      ok: true,
      manifest: { harness },
    });
    expect(ghostHarnessPermissionKeys(first.manifest.harness)).toEqual([
      "harness:read:runtime",
    ]);
  });

  it.each([{ hooks: ["permission.request"] }, { hooks: ["tool.before"] }, { hooks: ["compaction.before"] }])(
    "requires resident hooks",
    (harness) => {
      expect(validateGhostManifest({ ...base, harness }).ok).toBe(false);
      expect(
        validateGhostManifest({ ...base, harness, launch: "resident" }).ok,
      ).toBe(true);
    },
  );

  it.each([
    null,
    [],
    { read: [] },
    { events: ["tool", "tool"] },
    { read: [5] },
    { hooks: "permission.request" },
    { read: ["../../runtime"] },
    { read: Array(33).fill("runtime") },
  ])("rejects malformed known declarations", (harness) =>
    expect(parseGhostHarnessNeeds(harness)).toBeNull(),
  );
});
