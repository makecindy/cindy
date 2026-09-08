import { describe, expect, it } from "vitest";
import { parseModelRegistry } from "../modelAccessValidator.js";
import { expandedRegistryEntries } from "../modelMetadataLayers.js";
import type { ModelRegistry } from "../modelAccessBean.js";

function fixture(): ModelRegistry {
  return {
    schemaVersion: 4,
    updatedAt: "2026-09-08T06:00:00.000Z",
    baseModels: [{ id: "public", aliases: ["alias"], defaults: {} }],
    models: [
      {
        id: "route",
        name: "Route",
        efforts: ["low"],
        routes: [
          { providerId: "supplier", modelId: "route", agents: ["codex"] },
        ],
      },
    ],
  };
}

describe("V4 metadata validation boundaries", () => {
  it.each([
    ["name", 256],
    ["group", 128],
    ["description", 2000],
  ] as const)(
    "enforces %s wire limits even on unreferenced public models and all route layers",
    (field, max) => {
      for (const layer of ["public", "defaults", "forceOverrides"] as const) {
        const r = fixture();
        const route = r.models[0].routes[0];
        const metadata = { [field]: "a".repeat(max) };
        if (layer === "public") r.baseModels![0].defaults = metadata;
        else {
          route[layer] = metadata;
          route.overrideReason = "Correct supplier metadata";
        }
        expect(parseModelRegistry(r).ok).toBe(true);
        metadata[field] += "a";
        expect(parseModelRegistry(r).ok).toBe(false);
      }
    },
  );

  it.each(["entry", "agent", "inherited-agent"] as const)(
    "checks %s effort dependencies after route defaults",
    (scope) => {
      const r = fixture();
      const entry = r.models[0];
      if (scope === "entry") entry.defaultEffort = "high";
      else if (scope === "agent")
        entry.perAgent = { codex: { defaultEffort: "high" } };
      else {
        entry.defaultEffort = "low";
        entry.perAgent = { codex: { efforts: ["high"] } };
      }
      entry.routes[0].defaults = { efforts: ["high"], defaultEffort: "high" };
      expect(parseModelRegistry(r).ok).toBe(true);
      expect(expandedRegistryEntries(r)[0]).toMatchObject({
        efforts: ["high"],
        defaultEffort: "high",
      });
      delete entry.routes[0].defaults;
      expect(parseModelRegistry(r).ok).toBe(false);
    },
  );

  it("applies force after inconsistent entry and agent defaults but still validates final dependencies", () => {
    const r = fixture();
    const entry = r.models[0];
    entry.defaultEffort = "high";
    entry.perAgent = { codex: { efforts: ["low"], defaultEffort: "high" } };
    const route = entry.routes[0];
    route.forceOverrides = { efforts: ["high"] };
    route.overrideReason = "Correct supported efforts";
    expect(parseModelRegistry(r).ok).toBe(true);
    expect(expandedRegistryEntries(r)[0].perAgent?.codex).toMatchObject({
      efforts: ["high"],
      defaultEffort: "high",
    });
    route.forceOverrides = { efforts: ["low"] };
    expect(parseModelRegistry(r).ok).toBe(false);
  });

  it("does not hide invalid raw field types behind valid force corrections", () => {
    const r = fixture();
    const entry = r.models[0];
    entry.routes[0].forceOverrides = {
      efforts: ["high"],
      defaultEffort: "high",
    };
    entry.routes[0].overrideReason = "Correct supplier metadata";
    for (const target of [entry, (entry.perAgent = { codex: {} }).codex]) {
      Object.assign(target, { defaultEffort: "unknown" });
      expect(parseModelRegistry(r).ok).toBe(false);
      Reflect.deleteProperty(target, "defaultEffort");
    }
  });

  it.each([1, 2, 3] as const)(
    "preserves V%s dependency validation",
    (schemaVersion) => {
      const r = fixture();
      r.schemaVersion = schemaVersion;
      delete r.baseModels;
      r.models[0].defaultEffort = "high";
      expect(parseModelRegistry(r).ok).toBe(false);
    },
  );
});
