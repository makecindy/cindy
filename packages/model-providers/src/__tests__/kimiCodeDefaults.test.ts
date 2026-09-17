import { describe, expect, it } from "vitest";
import { BUNDLED_CATALOG } from "../catalog.js";
import { buildUserProvider } from "../user-provider.js";
import { providerCatalogForPi } from "../providerModelCatalog.js";
import { resolveBaseModelReferencePrice } from "../modelRegistry.js";
import { piNativeCatalogModels } from "../piNativeCatalog.js";
import type { CustomProviderConfig } from "../types.js";

const agents = ["claude-code", "codex", "pi"] as const;
const options = {
  presets: BUNDLED_CATALOG.presets,
  modelRegistry: BUNDLED_CATALOG.modelRegistry,
};
function connection(): CustomProviderConfig {
  const preset = options.presets!.find((p) => p.id === "moonshot-kimi-code")!;
  return {
    id: "kimi-test",
    name: preset.name,
    runtimes: Object.fromEntries(
      agents.map((agent) => {
        const runtime = preset.runtimes[agent]!;
        const selected = runtime.models.find(
          (m) => m.id === "kimi-for-coding",
        )!;
        return [
          agent,
          { ...runtime, catalogPresetId: preset.id, models: [{ ...selected }] },
        ];
      }),
    ),
  };
}

describe("Kimi K2.8 connection defaults", () => {
  it.each(["current", "id-only"] as const)(
    "Kimi K2.8 %s connections retain official efforts and unknown prices in every engine",
    (version) => {
      const config = connection();
      if (version === "id-only")
        for (const agent of agents) {
          config.runtimes[agent]!.models = [
            { id: "kimi-for-coding", name: "Kimi K2.8 Preview" },
          ];
        }
      for (const id of ["kimi-for-coding", "moonshotai/kimi-k2.8-preview"]) {
        expect(
          resolveBaseModelReferencePrice(options.modelRegistry!, id),
        ).toBeUndefined();
      }
      const provider = buildUserProvider(config, options);
      for (const agent of agents) {
        const model = provider.models[agent]![0];
        expect(model, agent).toMatchObject({
          id: "kimi-for-coding",
          name: "Kimi K2.8 Preview",
          contextWindow: 1_048_576,
          supportsImageInput: true,
          efforts: ["low", "high", "max"],
          defaultEffort: "max",
        });
        expect(model.cost, agent).toBeUndefined();
        expect(model.referencePrices, agent).toBeUndefined();
      }
      const native = providerCatalogForPi().providers["kimi-coding"].find(
        (m) => m.id === "kimi-for-coding",
      )!;
      expect(native.cost).toBeUndefined();
      expect(native.thinkingLevelMap).toMatchObject({
        low: "low",
        high: "high",
        max: "max",
      });
      expect(
        piNativeCatalogModels("kimi-coding").find(
          (m) => m.id === "kimi-for-coding",
        ),
      ).toMatchObject({
        efforts: ["low", "high", "max"],
        defaultEffort: "max",
      });
    },
  );
});
