import { describe, expect, it } from "vitest";
import { providerCatalogForPi } from "../providerModelCatalog.js";
import { toCindyProviderModel } from "../../../../tools/pi/catalog-format.mjs";
const piCatalog = providerCatalogForPi();

describe("Gemini 3.8 Flash catalog correction", () => {
  it.each([
    "google",
    "google-vertex",
    "opencode",
    "github-copilot",
    "vercel-ai-gateway",
  ])(
    "keeps %s imports and the bundled Pi projection free of minimal",
    (provider) => {
      const id =
        provider === "vercel-ai-gateway"
          ? "google/gemini-3.8-flash"
          : "gemini-3.8-flash";
      const source = piCatalog.providers[provider].find(
        (row) => row.id === id,
      )!;
      const bundled = { ...source, cost: { ...source.cost } };
      expect(bundled.thinkingLevelMap).toMatchObject({ minimal: null });
      const stale = {
        ...bundled,
        defaultEffort: "minimal",
        thinkingLevelMap: { off: null, minimal: "minimal" },
      };
      const converted = toCindyProviderModel(stale);
      expect(converted.efforts).toEqual(["low", "medium", "high"]);
      expect(converted.defaultEffort).toBe("medium");
      expect(converted.execution.pi.thinkingLevelMap).toEqual({
        off: null,
        minimal: null,
      });
      expect(
        toCindyProviderModel({ ...stale, thinkingLevelMap: undefined }).efforts,
      ).toEqual(["low", "medium", "high"]);
      expect(toCindyProviderModel(bundled).efforts).toEqual([
        "low",
        "medium",
        "high",
      ]);
      expect(stale.thinkingLevelMap.minimal).toBe("minimal");
      for (const unrelated of [
        { ...stale, id: "gemini-3-flash-preview" },
        { ...stale, provider: "custom-proxy" },
      ])
        expect(toCindyProviderModel(unrelated).efforts).toContain("minimal");
    },
  );
  it("preserves the existing OpenRouter standard and batch mappings", () => {
    for (const id of [
      "google/gemini-3.8-flash",
      "google/gemini-3.8-flash:batch",
    ]) {
      const source = piCatalog.providers.openrouter.find(
        (row) => row.id === id,
      )!;
      const model = { ...source, cost: { ...source.cost } };
      expect(toCindyProviderModel(model).efforts).toEqual([
        "low",
        "medium",
        "high",
      ]);
      expect(toCindyProviderModel(model).execution.pi.thinkingLevelMap).toEqual(
        model.thinkingLevelMap,
      );
    }
  });
});
