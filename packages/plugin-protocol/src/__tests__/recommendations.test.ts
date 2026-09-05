import { describe, expect, it } from "vitest";
import {
  localizeGhostRecommendation,
  validateGhostRecommendations,
} from "../recommendations.js";
import { validateGhostManifest } from "../manifest.js";

const item = {
  id: "mail",
  label: "Review email",
  prompt: "List the emails needing my attention.",
};
const manifest = {
  schemaVersion: 3,
  minCindyVersion: "0.1.61",
  id: "example",
  name: "Example",
  version: "1",
  entry: "main.js",
};
describe("optional recommendation contract", () => {
  it("keeps legacy manifests valid and accepts complete replacement including empty", () => {
    expect(validateGhostManifest(manifest).ok).toBe(true);
    const result = validateGhostManifest({
      ...manifest,
      recommendations: [item],
    });
    expect(result.ok && result.manifest.recommendations).toEqual([item]);
    expect(validateGhostRecommendations([])).toEqual({ ok: true, items: [] });
  });
  it.each(
    [
      [item, item],
      [{ ...item, id: "../other" }],
      [{ ...item, priority: 99 }],
      [{ ...item, label: "" }],
      [{ ...item, prompt: "a".repeat(8001) }],
      Array.from({ length: 25 }, (_, i) => ({ ...item, id: `item-${i}` })),
    ].map((value) => ({ value })),
  )("rejects invalid or quota-controlling author content", ({ value }) => {
    expect(validateGhostRecommendations(value).ok).toBe(false);
    // This was historically an opaque extension. Invalid recommendations must not reject
    // an otherwise valid installed plugin or change its approved manifest contents.
    const parsed = validateGhostManifest({
      ...manifest,
      recommendations: value,
    });
    expect(parsed.ok && parsed.manifest.recommendations).toEqual(value);
  });
  it.each(["legacy metadata", { custom: true }, [item]])(
    "ignores v2 extension metadata: %j",
    (recommendations) => {
      const parsed = validateGhostManifest({
        ...manifest,
        schemaVersion: 2,
        slots: [],
        recommendations,
      });
      expect(parsed.ok).toBe(true);
      expect(parsed.ok && parsed.manifest).not.toHaveProperty(
        "recommendations",
      );
    },
  );
  it("bounds total bytes and rejects cyclic data without throwing", () => {
    expect(
      validateGhostRecommendations(
        Array.from({ length: 24 }, (_, i) => ({
          ...item,
          id: `item-${i}`,
          prompt: "界".repeat(2000),
        })),
      ).ok,
    ).toBe(false);
    const cyclic: unknown[] = [];
    cyclic.push(cyclic);
    expect(validateGhostRecommendations(cyclic).ok).toBe(false);
  });
  it("localizes text with an English fallback", () => {
    const translated = {
      ...item,
      locales: {
        en: { label: "English", prompt: "English prompt" },
        "zh-TW": { label: "郵件", prompt: "檢查郵件" },
      },
    };
    expect(localizeGhostRecommendation(translated, "zh-TW").label).toBe("郵件");
    expect(localizeGhostRecommendation(translated, "ko").label).toBe("English");
  });
});
