import { describe, expect, it } from "vitest";
import {
  resolveModelMetadata,
  expandedRegistryEntries,
} from "../modelMetadataLayers.js";
import { parseModelRegistry } from "../modelAccessValidator.js";
import type { ModelRegistry } from "../modelAccessBean.js";

const registry: ModelRegistry = {
  schemaVersion: 4,
  updatedAt: "2026-09-08T06:00:00.000Z",
  baseModels: [
    {
      id: "vendor/model",
      aliases: ["model"],
      defaults: {
        name: "Model",
        contextWindow: 100,
        maxOutputTokens: 10,
        efforts: ["low", "high"],
        defaultEffort: "low",
        supportsFastMode: true,
      },
    },
  ],
  models: [
    {
      id: "saved-model-id",
      name: "Model",
      modelRef: "vendor/model",
      routes: [
        {
          providerId: "supplier",
          modelId: "model",
          agents: ["codex"],
          defaults: { contextWindow: 200 },
          forceOverrides: { maxOutputTokens: 20 },
          overrideReason: "Supplier output limit is incorrectly reported",
        },
      ],
    },
  ],
};

it("honors entry names below route, live, force and user names", () => {
  const r = structuredClone(registry);
  r.models[0].name = "Entry";
  const route = r.models[0].routes[0];
  expect(expandedRegistryEntries(r)[0].name).toBe("Entry");
  expect(
    resolveModelMetadata(
      r,
      "supplier",
      "model",
      undefined,
      undefined,
      undefined,
      { name: "Provider default" },
    ).name,
  ).toBe("Entry");
  expect(resolveModelMetadata(r, "unknown", "model").name).toBe("Model");
  route.defaults = { name: "Route" };
  expect(expandedRegistryEntries(r)[0].name).toBe("Route");
  expect(
    resolveModelMetadata(r, "supplier", "model", { name: "Live" }).name,
  ).toBe("Live");
  route.forceOverrides = { name: "Force" };
  expect(
    resolveModelMetadata(r, "supplier", "model", { name: "Live" }).name,
  ).toBe("Force");
  expect(
    resolveModelMetadata(
      r,
      "supplier",
      "model",
      { name: "Live" },
      { name: "User" },
    ).name,
  ).toBe("User");
});

it("requires public effort defaults to stand alone even without registry routes", () => {
  const r = structuredClone(registry);
  r.models = [];
  const defaults = r.baseModels![0].defaults;
  defaults.efforts = ["low"];
  defaults.defaultEffort = "high";
  expect(parseModelRegistry(r).ok).toBe(false);
  defaults.defaultEffort = "low";
  expect(parseModelRegistry(r).ok).toBe(true);
  defaults.efforts = [];
  expect(parseModelRegistry(r).ok).toBe(false);
  defaults.defaultEffort = null;
  expect(parseModelRegistry(r).ok).toBe(true);
  delete defaults.defaultEffort;
  expect(parseModelRegistry(r).ok).toBe(true);
});
describe("model metadata precedence", () => {
  it("inherits per field and lets supplier data beat defaults, explicit force beat supplier and user beat force", () => {
    expect(parseModelRegistry(registry).ok).toBe(true);
    expect(resolveModelMetadata(registry, "supplier", "model")).toMatchObject({
      name: "Model",
      contextWindow: 200,
      maxOutputTokens: 20,
    });
    expect(
      resolveModelMetadata(registry, "supplier", "model", {
        contextWindow: 300,
        maxOutputTokens: 30,
        supportsFastMode: false,
      }),
    ).toMatchObject({
      contextWindow: 300,
      maxOutputTokens: 20,
      supportsFastMode: false,
    });
    expect(
      resolveModelMetadata(
        registry,
        "supplier",
        "model",
        { contextWindow: 300 },
        { maxOutputTokens: 40 },
      ),
    ).toMatchObject({ contextWindow: 300, maxOutputTokens: 40 });
  });
  it("uses only public defaults for an unknown supplier, never another supplier force", () => {
    expect(
      resolveModelMetadata(registry, "new-supplier", "model"),
    ).toMatchObject({
      contextWindow: 100,
      maxOutputTokens: 10,
    });
    expect(
      resolveModelMetadata(registry, "new-supplier", "similar-model"),
    ).toEqual({});
  });
  it("preserves explicit empty effort lists, null defaults and false flags", () => {
    expect(
      resolveModelMetadata(registry, "supplier", "model", {
        efforts: [],
        supportsFastMode: false,
      }),
    ).toMatchObject({
      efforts: [],
      defaultEffort: null,
      supportsFastMode: false,
    });
    expect(
      resolveModelMetadata(registry, "supplier", "model", {
        defaultEffort: null,
      }).defaultEffort,
    ).toBeNull();
  });
  it("keeps the saved entry and upstream identifiers when expanding public defaults", () => {
    expect(expandedRegistryEntries(registry)[0]).toMatchObject({
      id: "saved-model-id",
      contextWindow: 200,
      routes: [{ modelId: "model", providerId: "supplier" }],
    });
  });
  it.each([
    (r: ModelRegistry) => {
      r.baseModels!.push({ ...r.baseModels![0], id: "other" });
    },
    (r: ModelRegistry) => {
      r.models[0].modelRef = "missing";
    },
    (r: ModelRegistry) => {
      delete r.models[0].routes[0].overrideReason;
    },
    (r: ModelRegistry) => {
      r.models[0].routes[0].forceOverrides = { contextWindow: -1 };
    },
    (r: ModelRegistry) => {
      r.schemaVersion = 3;
    },
  ])(
    "rejects ambiguous identities, invalid overrides and unsupported versions",
    (mutate) => {
      const bad = structuredClone(registry);
      mutate(bad);
      expect(parseModelRegistry(bad).ok).toBe(false);
    },
  );
});

describe("routing-only V4 layers", () => {
  it("honors route layers without public models and clears legacy per-agent defaults", () => {
    const r: ModelRegistry = {
      schemaVersion: 4,
      updatedAt: registry.updatedAt,
      models: [
        {
          id: "existing",
          name: "Existing",
          contextWindow: 100,
          efforts: ["low", "high"],
          defaultEffort: "low",
          perAgent: { codex: { defaultEffort: "high" } },
          routes: [
            {
              providerId: "one",
              modelId: "existing",
              agents: ["codex"],
              defaults: { contextWindow: 200 },
              forceOverrides: { defaultEffort: null },
              overrideReason: "Clear incorrect default",
            },
          ],
        },
      ],
    };
    expect(parseModelRegistry(r).ok).toBe(true);
    expect(resolveModelMetadata(r, "one", "existing")).toMatchObject({
      contextWindow: 200,
      defaultEffort: null,
    });
    expect(
      expandedRegistryEntries(r)[0].perAgent?.codex?.defaultEffort,
    ).toBeUndefined();
    expect(expandedRegistryEntries(r)[0].contextWindow).toBe(200);
  });
});

it("validates force corrections after per-agent defaults", () => {
  const r = structuredClone(registry);
  r.models[0].efforts = ["high"];
  r.models[0].defaultEffort = "high";
  r.models[0].perAgent = { codex: { defaultEffort: "high" } };
  r.models[0].routes[0].forceOverrides = {
    efforts: ["low"],
    defaultEffort: "low",
  };
  expect(parseModelRegistry(r).ok).toBe(true);
  expect(expandedRegistryEntries(r)[0].perAgent?.codex).toMatchObject({
    efforts: ["low"],
    defaultEffort: "low",
  });
});

it("groups equal effective route metadata regardless of layer key insertion order", () => {
  const r: ModelRegistry = {
    schemaVersion: 4,
    updatedAt: registry.updatedAt,
    models: [
      {
        id: "stable",
        name: "Stable",
        routes: [
          {
            providerId: "one",
            modelId: "model",
            agents: ["codex"],
            defaults: { contextWindow: 200, supportsFastMode: false },
            forceOverrides: { maxOutputTokens: 20 },
            overrideReason: "Verified limit",
          },
          {
            providerId: "two",
            modelId: "model",
            agents: ["codex"],
            defaults: { maxOutputTokens: 20, supportsFastMode: false },
            forceOverrides: { contextWindow: 200 },
            overrideReason: "Verified window",
          },
        ],
      },
    ],
  };
  const before = structuredClone(r);
  expect(parseModelRegistry(r).ok).toBe(true);
  const projected = expandedRegistryEntries(r);
  expect(projected).toHaveLength(1);
  expect(projected[0].id).toBe("stable");
  expect(projected[0].routes.map((route) => route.providerId)).toEqual([
    "one",
    "two",
  ]);
  expect(r).toEqual(before);
  r.models[0].routes[1].forceOverrides!.contextWindow = 300;
  expect(expandedRegistryEntries(r)).toHaveLength(2);
});

it.each(["entry", "runtime"] as const)(
  "accepts V4 null clears at the %s layer and keeps legacy wire valid",
  (layer) => {
    const r = structuredClone(registry);
    r.models[0].routes[0].agents = ["codex", "claude-code"];
    if (layer === "entry") r.models[0].defaultEffort = null;
    else
      r.models[0].perAgent = {
        codex: { efforts: ["high"], defaultEffort: null },
      };
    expect(parseModelRegistry(r).ok).toBe(true);
    expect(
      resolveModelMetadata(
        r,
        "supplier",
        "model",
        undefined,
        undefined,
        "codex",
      ).defaultEffort,
    ).toBeNull();
    const projected = expandedRegistryEntries(r);
    expect(projected[0].defaultEffort).toBeUndefined();
    expect(projected[0].perAgent?.codex?.defaultEffort).toBeUndefined();
    if (layer === "runtime")
      expect(projected[0].perAgent?.["claude-code"]?.defaultEffort).toBe("low");
    for (const schemaVersion of [1, 2, 3] as const) {
      const legacy = structuredClone(r);
      legacy.schemaVersion = schemaVersion;
      delete legacy.baseModels;
      delete legacy.models[0].modelRef;
      delete legacy.models[0].routes[0].defaults;
      delete legacy.models[0].routes[0].forceOverrides;
      delete legacy.models[0].routes[0].overrideReason;
      expect(parseModelRegistry(legacy).ok).toBe(false);
      legacy.models = structuredClone(projected);
      for (const entry of legacy.models) {
        delete entry.modelRef;
        for (const route of entry.routes) {
          delete route.defaults;
          delete route.forceOverrides;
          delete route.overrideReason;
        }
      }
      expect(parseModelRegistry(legacy).ok).toBe(true);
    }
  },
);

it("keeps local packaging names outside supplier public identity fallback", () => {
  const r = structuredClone(registry);
  r.localModels = {
    version: 1,
    featuredIds: [],
    models: [
      {
        id: "local-model",
        name: "Local",
        modelRef: "vendor/model",
        aliases: [],
        variants: [
          {
            libraryName: "model:local",
            sizeBytes: 1024 ** 3,
            minUnifiedMemoryGb: 4,
          },
        ],
      },
    ],
  };
  expect(parseModelRegistry(r).ok).toBe(true);
  expect(resolveModelMetadata(r, "unknown", "model:local")).toEqual({});
  expect(resolveModelMetadata(r, "unknown", "vendor/model").name).toBe("Model");
  expect(resolveModelMetadata(r, "unknown", "model").name).toBe("Model");
  // Local modelRef continues resolving explicitly; only public aliases opt cloud IDs in.
  expect(
    resolveModelMetadata(r, "unknown", r.localModels.models[0].modelRef!).name,
  ).toBe("Model");
  r.baseModels![0].aliases.push("model:local");
  expect(resolveModelMetadata(r, "unknown", "model:local").name).toBe("Model");
});

it.each([true, false])(
  "accepts V4 entry image capability %s and strips it from legacy entries",
  (image) => {
    const r = structuredClone(registry);
    r.models[0].supportsImageInput = image;
    expect(parseModelRegistry(r).ok).toBe(true);
    expect(
      resolveModelMetadata(r, "supplier", "model").supportsImageInput,
    ).toBe(image);
    expect(
      resolveModelMetadata(r, "supplier", "model", {
        supportsImageInput: !image,
      }).supportsImageInput,
    ).toBe(!image);
    r.models[0].routes[0].forceOverrides!.supportsImageInput = image;
    expect(
      resolveModelMetadata(r, "supplier", "model", {
        supportsImageInput: !image,
      }).supportsImageInput,
    ).toBe(image);
    const expanded = expandedRegistryEntries(r);
    expect(expanded[0]).not.toHaveProperty("supportsImageInput");
    const invalid = structuredClone(r) as unknown as {
      models: Record<string, unknown>[];
    };
    invalid.models[0].supportsImageInput = "true";
    expect(parseModelRegistry(invalid).ok).toBe(false);
    for (const schemaVersion of [1, 2, 3] as const) {
      const legacy = {
        schemaVersion,
        updatedAt: r.updatedAt,
        models: expanded.map((entry) => {
          const { modelRef, ...rest } = entry;
          return {
            ...rest,
            routes: entry.routes.map((route) => ({
              providerId: route.providerId,
              modelId: route.modelId,
              agents: route.agents,
            })),
          };
        }),
      };
      expect(parseModelRegistry(legacy).ok).toBe(true);
      expect(
        parseModelRegistry({
          ...legacy,
          models: legacy.models.map((entry) => ({
            ...entry,
            supportsImageInput: image,
          })),
        }).ok,
      ).toBe(false);
    }
  },
);
