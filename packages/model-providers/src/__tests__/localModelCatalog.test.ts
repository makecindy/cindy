import { describe, expect, it } from "vitest";
import { parseLocalModelCatalog } from "../localModelCatalog.js";
import { parseModelRegistry } from "../modelAccessValidator.js";
const catalog = {
  version: 1,
  featuredIds: ["example"],
  models: [
    {
      id: "example",
      name: "Example",
      aliases: ["example"],
      variants: [
        {
          libraryName: "example:4b-mlx",
          sizeBytes: 4 * 1024 ** 3,
          minUnifiedMemoryGb: 8,
          appleSiliconOnly: true,
        },
      ],
      descriptions: { "zh-CN": "本地候选", en: "Local candidate" },
      runtimeProfile: "plain",
      evidence: [
        {
          url: "https://example.com/bench",
          verifiedAt: "2026-09-05",
          status: "pending",
        },
      ],
    },
  ],
};
describe("Registry V4 local model contract", () => {
  it.each([200, 201, 256, 257])(
    "matches public ID and local reference limits at %i characters",
    (length) => {
      const modelRef = "m".repeat(length);
      const localModels = {
        ...catalog,
        models: [{ ...catalog.models[0], modelRef }],
      };
      const registry = {
        schemaVersion: 4,
        updatedAt: "2026-09-08T00:00:00.000Z",
        baseModels: [{ id: modelRef, aliases: [], defaults: {} }],
        models: [],
        localModels,
      };
      expect(parseLocalModelCatalog(localModels) !== null).toBe(length <= 256);
      expect(parseModelRegistry(registry).ok).toBe(length <= 256);
      expect(parseModelRegistry({ ...registry, baseModels: [] }).ok).toBe(
        false,
      );
    },
  );
  it("accepts curated metadata only in V4 and permits explicit empty withdrawal", () => {
    expect(parseLocalModelCatalog(catalog)).toEqual(catalog);
    for (const localModels of [
      catalog,
      { version: 1, models: [], featuredIds: [] },
    ]) {
      expect(
        parseModelRegistry({
          schemaVersion: 4,
          updatedAt: "2026-09-08T00:00:00.000Z",
          models: [],
          localModels,
        }).ok,
      ).toBe(true);
      for (const schemaVersion of [1, 2, 3]) {
        expect(
          parseModelRegistry({
            schemaVersion,
            updatedAt: "2026-09-08T00:00:00.000Z",
            models: [],
            localModels,
          }).ok,
        ).toBe(false);
      }
    }
  });
  it.each([
    (c: any) => {
      c.models[0].variants[0].libraryName = "https://example.com/model";
    },
    (c: any) => {
      c.models[0].variants[0].libraryName = "../model:latest";
    },
    (c: any) => {
      c.models[0].variants[0].sizeBytes = -1;
    },
    (c: any) => {
      c.models[0].variants[0].minUnifiedMemoryGb = 0;
    },
    (c: any) => {
      delete c.models[0].variants[0].appleSiliconOnly;
    },
    (c: any) => {
      c.models[0].runtimeProfile = "shell";
    },
    (c: any) => {
      c.models[0].runtimeProfile = "qwen-xhigh";
    },
    (c: any) => {
      c.models[0].evidence[0].verifiedAt = "2026-02-30";
    },
    (c: any) => {
      c.models[0].command = "run";
    },
    (c: any) => {
      c.models[0].descriptions.en = "";
    },
    (c: any) => {
      c.featuredIds = ["missing"];
    },
    (c: any) => {
      c.models.push(c.models[0]);
    },
    (c: any) => {
      c.models[0].evidence[0].url = "file:///etc/passwd";
    },
  ])(
    "rejects invalid data before it can replace a cached snapshot",
    (mutate) => {
      const bad = structuredClone(catalog);
      mutate(bad);
      expect(parseLocalModelCatalog(bad)).toBeNull();
      expect(
        parseModelRegistry({
          schemaVersion: 4,
          updatedAt: "2026-09-08T00:00:00.000Z",
          models: [],
          localModels: bad,
        }).ok,
      ).toBe(false);
    },
  );
});
