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
