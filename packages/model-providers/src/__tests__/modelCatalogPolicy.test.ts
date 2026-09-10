import { describe, expect, it } from "vitest";
import {
  applyModelProductDefaults,
  resolveModelProductDefaults,
  validModelProductDefaults,
} from "../modelCatalogPolicy.js";
import { buildUserProvider } from "../user-provider.js";
import type {
  CatalogModel,
  CustomProviderConfig,
  ProviderPreset,
} from "../types.js";
import type { ModelRegistry } from "../modelAccessBean.js";

describe("published model defaults", () => {
  it("distinguishes product identity, channel and engine despite duplicate legacy upstream IDs", () => {
    const registry: ModelRegistry = {
      schemaVersion: 5,
      updatedAt: "2026-09-10T00:00:00Z",
      models: [
        {
          id: "openai/gpt-test",
          name: "Test",
          routes: [
            { providerId: "openai", modelId: "gpt-test", agents: ["codex"] },
          ],
          productDefaults: {
            contextWindow: 272000,
            fast: false,
            perAgent: { pi: { effort: "low" } },
          },
        },
        {
          id: "openai/gpt-test[1m]",
          name: "Test",
          routes: [
            { providerId: "openai", modelId: "gpt-test", agents: ["codex"] },
          ],
          productDefaults: { contextWindow: 1000000 },
        },
        {
          id: "xd/gpt-test",
          name: "Test",
          routes: [
            { providerId: "xd", modelId: "gpt-test", agents: ["codex"] },
          ],
          productDefaults: { contextWindow: 200000 },
        },
      ],
    };
    expect(
      resolveModelProductDefaults(
        registry,
        "openai",
        "chatgpt/gpt-test",
        "codex",
      )?.contextWindow,
    ).toBe(272000);
    expect(
      resolveModelProductDefaults(registry, "openai", "gpt-test[1m]", "codex")
        ?.contextWindow,
    ).toBe(1000000);
    expect(
      resolveModelProductDefaults(registry, "openai", "gpt-test", "pi")?.effort,
    ).toBe("low");
    expect(
      resolveModelProductDefaults(registry, "xd", "gpt-test", "codex")
        ?.contextWindow,
    ).toBe(200000);
    expect(
      resolveModelProductDefaults(registry, "my-api", "gpt-test", "codex"),
    ).toBeUndefined();
  });
  it("preserves maximum capacity, explicit false/null and never invents Fast support", () => {
    const model: CatalogModel = {
      id: "test",
      name: "Test",
      contextWindow: 1000000,
      efforts: ["low", "high"],
      defaultEffort: "high",
    };
    const result = applyModelProductDefaults(
      model,
      { contextWindow: 272000, visible: false, effort: null, fast: true },
      "catalog-7",
    );
    expect(result).toMatchObject({
      contextWindow: 272000,
      contextWindowMax: 1000000,
      defaultEnabled: false,
      defaultEffort: null,
      defaultFast: false,
      catalogDefaults: { revision: "catalog-7" },
    });
    expect(model.contextWindow).toBe(1000000);
    expect(validModelProductDefaults({ fast: false, effort: null })).toBe(true);
    expect(validModelProductDefaults({ fast: "false" })).toBe(false);
    expect(
      validModelProductDefaults({
        perAgent: { codex: { preferredAgent: "pi" } },
      }),
    ).toBe(false);
  });
  it("updates a matching API template without replacing form edits or following a changed endpoint", () => {
    const config: CustomProviderConfig = {
      id: "personal",
      name: "Personal",
      runtimes: {
        pi: {
          catalogPresetId: "official-api",
          baseUrl: "https://api.example/v1",
          wireProtocol: "openai-chat",
          models: [{ id: "m", name: "M" }],
        },
      },
    };
    const presets: ProviderPreset[] = [
      {
        id: "official-api",
        name: "API",
        runtimes: {
          pi: {
            baseUrl: "https://api.example/v1",
            wireProtocol: "openai-chat",
            models: [
              {
                id: "m",
                name: "M",
                contextWindow: 1000000,
                reasoning: true,
                reasoningEfforts: ["low", "high"],
                productDefaults: {
                  contextWindow: 272000,
                  effort: "low",
                  visible: false,
                },
              },
            ],
          },
        },
      },
    ];
    const current = () =>
      buildUserProvider(config, {
        presets,
        catalogRevision: "catalog-9",
        modelRegistry: {
          schemaVersion: 5,
          updatedAt: "2026-09-10T00:00:00Z",
          models: [],
        },
      }).models.pi![0];
    expect(current()).toMatchObject({
      contextWindow: 272000,
      contextWindowMax: 1000000,
      defaultEffort: "low",
      defaultEnabled: false,
      catalogDefaults: { revision: "catalog-9" },
    });
    config.runtimes.pi!.models[0].contextWindow = 500000;
    config.runtimes.pi!.models[0].defaultEnabled = true;
    expect(current()).toMatchObject({
      contextWindow: 500000,
      defaultEnabled: true,
    });
    config.runtimes.pi!.baseUrl = "https://different.example/v1";
    expect(current().catalogDefaults).toBeUndefined();
  });
});

it("inherits reviewed locale fields, keeps names separate from personal labels, and traces capability limits", async () => {
  const { localizedModelPresentation } =
    await import("../modelPresentation.js");
  const registry: ModelRegistry = {
    schemaVersion: 5,
    updatedAt: "2026-09-10T00:00:00Z",
    baseModels: [
      {
        id: "base",
        aliases: [],
        defaults: {},
        presentation: {
          en: { name: "Base name", description: "Base description" },
          "zh-CN": { description: "共用简介" },
        },
      },
    ],
    models: [
      {
        id: "openai/test",
        name: "Test",
        modelRef: "base",
        routes: [{ providerId: "openai", modelId: "test", agents: ["codex"] }],
        productDefaults: { presentation: { en: { name: "Channel name" } } },
      },
    ],
  };
  const policy = resolveModelProductDefaults(
    registry,
    "openai",
    "test",
    "codex",
  );
  expect(localizedModelPresentation(policy?.presentation, "en-US")).toEqual({
    name: "Channel name",
    description: "Base description",
  });
  expect(localizedModelPresentation(policy?.presentation, "zh-Hans")).toEqual({
    name: "Channel name",
    description: "共用简介",
  });
  const model: CatalogModel = {
    id: "test",
    name: "Personal",
    nameExplicit: true,
    contextWindow: 100,
    efforts: [],
    defaultEffort: null,
  };
  const effective = applyModelProductDefaults(
    model,
    { ...policy, fast: true, contextWindow: 200 },
    "catalog-1",
  );
  expect(effective.presentation?.en?.name).toBeUndefined();
  expect(effective.presentation?.en?.description).toBe("Base description");
  expect(effective.fieldSources?.contextWindow.at(-1)).toMatchObject({
    source: "constraint",
    value: 100,
  });
  expect(effective.fieldSources?.defaultFast.at(-1)).toMatchObject({
    source: "constraint",
    value: false,
  });
});

it("follows a referenced common model through a matching template without inheriting Pi reasoning", () => {
  const registry: ModelRegistry = {
    schemaVersion: 5,
    updatedAt: "2026-09-10T00:00:00Z",
    models: [],
    baseModels: [
      {
        id: "common",
        aliases: [],
        defaults: {
          contextWindow: 900000,
          efforts: ["high"],
          defaultEffort: "high",
        },
        presentation: { en: { description: "Shared editorial text" } },
      },
    ],
  };
  const presets: ProviderPreset[] = [
    {
      id: "api",
      name: "API",
      runtimes: {
        pi: {
          baseUrl: "https://api.example/v1",
          wireProtocol: "openai-chat",
          models: [{ id: "upstream", name: "Upstream", modelRef: "common" }],
        },
      },
    },
  ];
  const config: CustomProviderConfig = {
    id: "mine",
    name: "Mine",
    runtimes: {
      pi: {
        catalogPresetId: "api",
        baseUrl: "https://api.example/v1",
        wireProtocol: "openai-chat",
        models: [{ id: "upstream", name: "Upstream", discoveredMetadata: {} }],
      },
    },
  };
  const current = () =>
    buildUserProvider(config, {
      modelRegistry: registry,
      presets,
      catalogRevision: "catalog-9",
    }).models.pi![0];
  expect(current().contextWindow).toBe(900000);
  expect(current().efforts).toEqual([]);
  expect(current().presentation?.en?.description).toBe("Shared editorial text");
  registry.baseModels![0].defaults.contextWindow = 1000000;
  expect(current().contextWindow).toBe(1000000);
  config.runtimes.pi!.models[0].contextWindow = 12345;
  expect(current().contextWindow).toBe(12345);
  config.runtimes.pi!.baseUrl = "https://another.example/v1";
  expect(current().presentation).toBeUndefined();
});
