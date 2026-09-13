import { describe, expect, it } from "vitest";
import {
  providerCatalogForPi,
  providerModelRecord,
} from "../providerModelCatalog.js";
import { buildUserProvider } from "../user-provider.js";
import { BUNDLED_CATALOG } from '../builtin.js';
import { modelProtocolComparison } from '../modelProtocol.js';

describe("standard provider catalog", () => {
  it('carries Cindy canonical model declarations into imported connection details', () => {
    const provider = buildUserProvider({ id: 'my-router', name: 'Router', runtimes: {
      pi: { baseUrl: 'https://openrouter.ai/api/v1', wireProtocol: 'openai-chat',
        models: [{ id: 'deepseek/deepseek-v4-pro', name: 'DeepSeek' }] },
    } }, { modelRegistry: BUNDLED_CATALOG.modelRegistry });
    const model = provider.models.pi![0];
    expect(model.nativeApi).toBe('openai-completions');
    expect(modelProtocolComparison(provider, { pi: model }).forAgent('pi')?.mode).toBe('matching');
  });
  it("shares a concrete OpenRouter model across all three harnesses without a Registry entry", () => {
    const runtime = {
      baseUrl: "https://openrouter.ai/api/v1",
      wireProtocol: "openai-chat" as const,
      models: [{ id: "aion-labs/aion-3.0-mini", name: "Aion" }],
    };
    const provider = buildUserProvider({
      id: "my-router",
      name: "Router",
      runtimes: {
        pi: runtime,
        codex: runtime,
        "claude-code": runtime,
      },
    });
    for (const agent of ["pi", "codex", "claude-code"] as const) {
      expect(provider.models[agent]?.[0]).toMatchObject({
        contextWindow: 131072,
        maxOutput: 32768,
        supportsImageInput: false,
        cost: { input: 0.7, output: 1.4 },
      });
      expect(provider.models[agent]?.[0]?.efforts.length).toBeGreaterThan(0);
    }
  });

  it("preserves discoveries and user settings above imported defaults", () => {
    const provider = buildUserProvider({
      id: "router",
      name: "Router",
      runtimes: {
        pi: {
          baseUrl: "https://openrouter.ai/api/v1",
          wireProtocol: "openai-chat",
          models: [
            {
              id: "aion-labs/aion-3.0-mini",
              name: "Aion",
              contextWindow: 64000,
              discoveredMetadata: {
                contextWindow: 128000,
                maxOutputTokens: 16000,
              },
              discoveredCost: { input: 0.5 },
              defaultEnabled: false,
            },
          ],
        },
      },
    });
    expect(provider.models.pi?.[0]).toMatchObject({
      contextWindow: 64000,
      maxOutput: 16000,
      cost: { input: 0.5 },
      defaultEnabled: false,
    });
  });

  it("does not lend pricing or protocol across an altered endpoint or protocol", () => {
    expect(
      providerModelRecord(
        "aion-labs/aion-3.0-mini",
        "https://proxy.example/v1",
        "openai-chat",
      ),
    ).toBeUndefined();
    expect(
      providerModelRecord(
        "aion-labs/aion-3.0-mini",
        "https://openrouter.ai/api/v1",
        "openai-responses",
      ),
    ).toBeUndefined();
  });

  it("preserves native Pi compatibility when adapting the standard record back to Pi", () => {
    expect(
      providerCatalogForPi().providers.openrouter?.find(
        (m) => m.id === "aion-labs/aion-3.0-mini",
      ),
    ).toMatchObject({
      api: "openai-completions",
      input: ["text"],
      maxTokens: 32768,
      thinkingLevelMap: { off: null },
      compat: { thinkingFormat: "openrouter" },
    });
  });
});

// Unknown vendor price units must not be interpreted as OpenRouter's USD/token.
it("does not assume pricing units on another compatible endpoint", async () => {
  const { parseModelsListResponse } = await import("../modelDiscovery.js");
  const payload = { data: [{ id: "unknown", pricing: { prompt: "2" } }] };
  expect(
    parseModelsListResponse(payload, "https://proxy.example/v1/models")?.[0]
      ?.discoveredCost,
  ).toBeUndefined();
  expect(
    parseModelsListResponse(payload, "invalid")?.[0]?.discoveredCost,
  ).toBeUndefined();
});

it('does not borrow Chat defaults for an explicitly different Pi model API', () => {
  const provider = buildUserProvider({ id: 'router', name: 'Router', runtimes: { pi: {
    baseUrl: 'https://openrouter.ai/api/v1', wireProtocol: 'openai-chat',
    models: [{ id: 'aion-labs/aion-3.0-mini', name: 'Aion', piApi: 'google-generative-ai' }],
  } } });
  expect(provider.models.pi?.[0]?.cost).toBeUndefined();
});

it('keeps generated defaults consistent with Cindy model preferences', async () => {
  const { PROVIDER_MODEL_CATALOG } = await import('../providerModelCatalog.js');
  const { defaultEffortForCapabilities } = await import('../effortResolution.js');
  for (const model of Object.values(PROVIDER_MODEL_CATALOG.providers).flat()) {
    expect(model.defaultEffort, model.id).toBe(defaultEffortForCapabilities(model.efforts));
  }
});

// Regression: a mixed OpenCode connection defaults to Chat, while Astra uses Responses.
it.each([
  ['https://opencode.ai/zen/v1', 'gpt-6-astra', 'openai-responses', true],
  ['https://opencode.ai/zen/v1', 'gemini-3.8-flash', 'google-generative-ai', true],
  ['https://opencode.ai/zen/go/v1', 'gpt-5.6-luna', 'openai-responses', true],
  ['https://opencode.ai/zen/go/v1', 'deepseek-v4-flash', 'openai-completions', false],
  ['https://opencode.ai/zen/go/v1', 'deepseek-v4-flash-vision-exp', 'openai-completions', true],
] as const)('imports %s %s with its own protocol and image capability', (baseUrl, id, api, image) => {
  for (const piApi of [undefined, api]) {
    const provider = buildUserProvider({ id: 'custom-code', name: 'OpenCode', runtimes: {
      pi: { baseUrl, wireProtocol: 'openai-chat', models: [{ id, name: id, ...(piApi ? { piApi } : {}) }] },
    } });
    expect(provider.models.pi?.[0]).toMatchObject({ piApi: api, supportsImageInput: image });
    expect(provider.models.pi?.[0]?.userModelConfig?.piApi).toBe(piApi);
    expect(provider.models.pi?.[0]?.maxOutput).toBeGreaterThan(0);
    expect(provider.models.pi?.[0]?.cost).toBeDefined();
  }
});
