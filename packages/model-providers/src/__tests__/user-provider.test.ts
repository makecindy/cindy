/**
 * buildUserProvider —— 用户自定义配置（per-runtime）→ 标准 Provider 的映射。
 *
 * 核心不变量：
 *   - source='user'、auth.method 与 access 元数据匹配；
 *   - 只为**已配置的 runtime** 生成 api-key-header 路由 + per-agent 模型清单（各自 baseUrl/models）；
 *   - **API key 绝不出现在产出的 Provider 里**（密钥在 host resolve 时按 (id,agent) 注入）；
 *   - 模型补保守默认（contextWindow / 无 effort / group=custom:<id> / defaultEnabled）。
 */

import { describe, it, expect } from "vitest";

import {
  buildUserProvider,
  DEFAULT_CUSTOM_CONTEXT_WINDOW,
  LEGACY_XAI_CUSTOM_PROVIDER_RUNTIME_ID,
  projectXaiApiImageModels,
  storedCustomProviderId,
  xaiApiOfficialRuntimeAgents,
  XAI_API_CUSTOM_PROVIDER_ID,
} from "../user-provider.js";
import type { CustomProviderConfig } from "../types.js";
import type { ModelRegistry } from "../modelAccessBean.js";
import { BUNDLED_CATALOG } from "../catalog.js";

const codexOnly: CustomProviderConfig = {
  id: "openrouter",
  name: "OpenRouter",
  runtimes: {
    codex: {
      baseUrl: "https://openrouter.ai/api/v1",
      models: [
        { id: "meta/llama-4-405b", name: "Llama 4 405B" },
        { id: "qwen/qwen3-max", name: "Qwen3 Max" },
      ],
    },
  },
};

describe("buildUserProvider (per-runtime)", () => {
  it("projects a legacy custom xai row under a collision-free runtime id", () => {
    const provider = buildUserProvider({
      ...codexOnly,
      id: "xai",
      name: "My xAI-compatible endpoint",
    });
    expect(provider.id).toBe(LEGACY_XAI_CUSTOM_PROVIDER_RUNTIME_ID);
    expect(provider.routing.codex?.upstream).toBe(
      "https://openrouter.ai/api/v1",
    );
    expect(storedCustomProviderId(provider.id)).toBe("xai");
  });

  it("maps a single-runtime config to a standard user Provider", () => {
    const p = buildUserProvider(codexOnly);
    expect(p.id).toBe("openrouter");
    expect(p.name).toBe("OpenRouter");
    expect(p.source).toBe("user");
    expect(p.auth).toEqual({ method: "apiKey" });
    expect(p.access).toEqual({ kind: "api" });
    expect(p.agents).toEqual(["codex"]);
    expect(p.routing["claude-code"]).toBeUndefined();
    expect(p.models["claude-code"]).toBeUndefined();
  });

  it("projects official Imagine models onto the xAI API-key source", () => {
    const source = BUNDLED_CATALOG.providers.find((provider) => provider.id === "xai")!;
    const xaiApi = buildUserProvider({
      id: XAI_API_CUSTOM_PROVIDER_ID,
      name: "xAI API",
      runtimes: {
        codex: {
          baseUrl: "https://api.x.ai/v1",
          wireProtocol: "openai-chat",
          models: [{ id: "grok-4.6", name: "Grok 4.6" }],
        },
      },
    });

    const projected = projectXaiApiImageModels([source, xaiApi]);
    expect(projected.find((provider) => provider.id === XAI_API_CUSTOM_PROVIDER_ID)?.imageModels)
      .toEqual(source.imageModels);
  });

  it("does not project Imagine models onto a non-official API-key endpoint", () => {
    const source = BUNDLED_CATALOG.providers.find((provider) => provider.id === "xai")!;
    const proxy = buildUserProvider({
      id: XAI_API_CUSTOM_PROVIDER_ID,
      name: "xAI-compatible proxy",
      runtimes: {
        codex: {
          baseUrl: "https://proxy.example/v1",
          models: [{ id: "grok-4.6", name: "Grok 4.6" }],
        },
      },
    });

    expect(projectXaiApiImageModels([source, proxy])).toEqual([source, proxy]);
  });

  it("binds image credentials to runtimes routed at the official endpoint", () => {
    // 官方 codex 路由 + 代理 pi 路由:只有 codex 可作为凭证来源,防止把
    // 代理密钥发往官方图片端点(PR #3875 review P1)。
    const mixed = buildUserProvider({
      id: XAI_API_CUSTOM_PROVIDER_ID,
      name: "xAI API",
      runtimes: {
        codex: {
          baseUrl: "https://api.x.ai/v1",
          wireProtocol: "openai-chat",
          models: [{ id: "grok-4.6", name: "Grok 4.6" }],
        },
        pi: {
          baseUrl: "https://proxy.example/v1",
          models: [{ id: "grok-4.6", name: "Grok 4.6" }],
        },
      },
    });
    expect(xaiApiOfficialRuntimeAgents(mixed)).toEqual(["codex"]);

    // 只有 pi 命中官方端点:凭证来源是 pi,而不是固定顺序里的 codex 代理。
    const piOfficial = buildUserProvider({
      id: XAI_API_CUSTOM_PROVIDER_ID,
      name: "xAI API",
      runtimes: {
        codex: {
          baseUrl: "https://proxy.example/v1",
          models: [{ id: "grok-4.6", name: "Grok 4.6" }],
        },
        pi: {
          baseUrl: "https://api.x.ai/v1",
          models: [{ id: "grok-4.6", name: "Grok 4.6" }],
        },
      },
    });
    expect(xaiApiOfficialRuntimeAgents(piOfficial)).toEqual(["pi"]);

    // 无任何官方路由:没有可用凭证来源。
    const proxyOnly = buildUserProvider({
      id: XAI_API_CUSTOM_PROVIDER_ID,
      name: "xAI-compatible proxy",
      runtimes: {
        codex: {
          baseUrl: "https://proxy.example/v1",
          models: [{ id: "grok-4.6", name: "Grok 4.6" }],
        },
      },
    });
    expect(xaiApiOfficialRuntimeAgents(proxyOnly)).toEqual([]);
    expect(xaiApiOfficialRuntimeAgents(undefined)).toEqual([]);
  });

  it("generates api-key-header routing with that runtime baseUrl, no key", () => {
    const p = buildUserProvider(codexOnly);
    expect(p.routing.codex).toEqual({
      upstream: "https://openrouter.ai/api/v1",
      authStrategy: "api-key-header",
      supportsResponsesCustomTools: false,
    });
    expect(p.routing.codex?.headerOverride).toBeUndefined();
  });

  it("marks only a custom Codex Responses runtime as lacking native custom tools", () => {
    const responses = buildUserProvider(codexOnly);
    const chat = buildUserProvider({
      ...codexOnly,
      runtimes: {
        codex: { ...codexOnly.runtimes.codex!, wireProtocol: "openai-chat" },
      },
    });

    expect(responses.routing.codex?.supportsResponsesCustomTools).toBe(false);
    expect(chat.routing.codex?.supportsResponsesCustomTools).toBeUndefined();
  });

  it("preserves an explicit Chat Completions protocol for Codex routing", () => {
    const p = buildUserProvider({
      ...codexOnly,
      runtimes: {
        codex: { ...codexOnly.runtimes.codex!, wireProtocol: "openai-chat" },
      },
    });
    expect(p.routing.codex).toMatchObject({
      upstream: "https://openrouter.ai/api/v1",
      authStrategy: "api-key-header",
      wireProtocol: "openai-chat",
    });
  });

  it("preserves an explicit Anthropic Messages protocol for Codex routing", () => {
    const p = buildUserProvider({
      ...codexOnly,
      runtimes: {
        codex: {
          ...codexOnly.runtimes.codex!,
          wireProtocol: "anthropic-messages",
        },
      },
    });
    expect(p.routing.codex).toMatchObject({
      upstream: "https://openrouter.ai/api/v1",
      authStrategy: "api-key-header",
      wireProtocol: "anthropic-messages",
    });
  });

  it("preserves a non-standard inference request path in routing", () => {
    const p = buildUserProvider({
      ...codexOnly,
      runtimes: {
        codex: {
          ...codexOnly.runtimes.codex!,
          requestPath: "/tenant/acme/v2/infer?stream=1",
        },
      },
    });
    expect(p.routing.codex?.requestPath).toBe("/tenant/acme/v2/infer?stream=1");
  });

  it("maps models per runtime with conservative default metadata", () => {
    const p = buildUserProvider(codexOnly);
    const models = p.models.codex ?? [];
    expect(models.map((m) => m.id)).toEqual([
      "meta/llama-4-405b",
      "qwen/qwen3-max",
    ]);
    expect(models[0]).toMatchObject({
      id: "meta/llama-4-405b",
      name: "Llama 4 405B",
      contextWindow: DEFAULT_CUSTOM_CONTEXT_WINDOW,
      // codex runtime：参考内置默认 effort 档位（low/medium/high/xhigh/max，默认 high）。
      efforts: ["low", "medium", "high", "xhigh", "max"],
      defaultEffort: "high",
      group: "custom:openrouter",
      defaultEnabled: true,
    });
  });

  it("projects a model-specific protocol route into the provider catalog", () => {
    const provider = buildUserProvider({
      ...codexOnly,
      runtimes: {
        codex: {
          ...codexOnly.runtimes.codex!,
          models: [
            {
              id: "glm-5.3",
              name: "GLM-5.3",
              route: {
                baseUrl: "https://openrouter.ai/api/v1",
                wireProtocol: "openai-responses",
              },
            },
          ],
        },
      },
    });

    expect(provider.models.codex?.[0]?.route).toEqual({
      baseUrl: "https://openrouter.ai/api/v1",
      wireProtocol: "openai-responses",
    });
  });

  it("inherits Registry efforts only for a unique route of the target agent", () => {
    const provider = buildUserProvider(
      {
        id: "relay",
        name: "Relay",
        runtimes: {
          codex: {
            baseUrl: "https://relay.example/v1",
            models: [
              { id: "gpt-5.6-sol", name: "GPT-5.6-Sol" },
              { id: "chatgpt/gpt-5.6-sol", name: "GPT-5.6-Sol ChatGPT" },
              { id: "unregistered-model", name: "Unregistered" },
            ],
          },
          "claude-code": {
            baseUrl: "https://relay.example/anthropic",
            models: [{ id: "gpt-5.6-sol", name: "GPT-5.6-Sol" }],
          },
        },
      },
      { modelRegistry: BUNDLED_CATALOG.modelRegistry },
    );

    expect(provider.routing).toMatchObject({
      codex: { upstream: "https://relay.example/v1" },
      "claude-code": { upstream: "https://relay.example/anthropic" },
    });
    expect(provider.models.codex).toEqual([
      expect.objectContaining({
        id: "gpt-5.6-sol",
        efforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
        defaultEffort: "high",
      }),
      expect.objectContaining({
        id: "chatgpt/gpt-5.6-sol",
        efforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
        defaultEffort: "high",
      }),
      expect.objectContaining({
        id: "unregistered-model",
        efforts: ["low", "medium", "high", "xhigh", "max"],
        defaultEffort: "high",
      }),
    ]);
    expect(provider.models["claude-code"]?.[0]).toMatchObject({
      id: "gpt-5.6-sol",
      efforts: ["low", "medium", "high", "xhigh", "max"],
      defaultEffort: "high",
    });
  });

  it("inherits Registry Fast support only for an exact Codex route model id", () => {
    const provider = buildUserProvider(
      {
        id: "fast-relay",
        name: "Fast Relay",
        runtimes: {
          codex: {
            baseUrl: "https://relay.example/v1",
            models: [
              { id: "gpt-5.6-sol", name: "GPT-5.6-Sol" },
              { id: "openai/gpt-5.6-sol", name: "Prefixed GPT-5.6-Sol" },
              { id: "unregistered-model", name: "Unregistered" },
            ],
          },
          "claude-code": {
            baseUrl: "https://relay.example/anthropic",
            models: [{ id: "gpt-5.6-sol", name: "GPT-5.6-Sol" }],
          },
        },
      },
      { modelRegistry: BUNDLED_CATALOG.modelRegistry },
    );

    expect(provider.models.codex?.[0]).toMatchObject({
      id: "gpt-5.6-sol",
      supportsFastMode: true,
    });
    expect(provider.models.codex?.[1]?.supportsFastMode).toBeUndefined();
    expect(provider.models.codex?.[2]?.supportsFastMode).toBeUndefined();
    expect(
      provider.models["claude-code"]?.[0]?.supportsFastMode,
    ).toBeUndefined();
  });

it('strips xd/ prefix to match registry effort metadata (entry.id ≠ custom id)', () => {
    const p = buildUserProvider(
      {
        id: 'my-provider',
        name: 'My Provider',
        runtimes: {
          codex: {
            baseUrl: 'https://my-provider.example/v1',
            models: [{ id: 'xd/codex/gpt-5.6-sol', name: 'GPT-5.6-Sol' }],
          },
        },
      },
      { modelRegistry: BUNDLED_CATALOG.modelRegistry },
    );
    // xd/codex/gpt-5.6-sol → strips to codex/gpt-5.6-sol → no exact match
    // → further strips? no, only openai/xd/chatgpt/ are stripped.
    // Actually xd/codex/gpt-5.6-sol starts with xd/ → stripped to codex/gpt-5.6-sol
    // which matches route.modelId for codex agent.
    expect(p.models.codex?.[0]).toMatchObject({
      id: 'xd/codex/gpt-5.6-sol',
      efforts: expect.arrayContaining(['ultra']),
      defaultEffort: 'high',
    });
  });

  it('strips xd/ prefix to match registry effort metadata', () => {
    const p = buildUserProvider(
      {
        id: 'xd-relay',
        name: 'XD Relay',
        runtimes: {
          codex: {
            baseUrl: 'https://xd-relay.example/v1',
            models: [{ id: 'xd/gpt-5.6-sol', name: 'GPT-5.6-Sol' }],
          },
        },
      },
      { modelRegistry: BUNDLED_CATALOG.modelRegistry },
    );
    // xd/gpt-5.6-sol → strips to gpt-5.6-sol → matches registry entry
    expect(p.models.codex?.[0]).toMatchObject({
      id: 'xd/gpt-5.6-sol',
      efforts: expect.arrayContaining(['ultra']),
      defaultEffort: 'high',
    });
  });

  it('strips openai/ prefix to match registry effort metadata (entry.id ≠ custom id)', () => {
    const p = buildUserProvider(
      {
        id: 'openai-relay',
        name: 'OpenAI Relay',
        runtimes: {
          codex: {
            baseUrl: 'https://openai-relay.example/v1',
            models: [{ id: 'openai/gpt-5.6-sol', name: 'GPT-5.6-Sol' }],
          },
        },
      },
      { modelRegistry: BUNDLED_CATALOG.modelRegistry },
    );
    // openai/gpt-5.6-sol → strips to gpt-5.6-sol → matches registry entry
    // entry.id = 'gpt-5.6-sol' ≠ custom id 'openai/gpt-5.6-sol'
    expect(p.models.codex?.[0]).toMatchObject({
      id: 'openai/gpt-5.6-sol',
      efforts: expect.arrayContaining(['ultra']),
      defaultEffort: 'high',
    });
  });

  it('unregistered prefix falls back to CUSTOM_EFFORTS', () => {
    const p = buildUserProvider(
      {
        id: 'unknown-relay',
        name: 'Unknown Relay',
        runtimes: {
          codex: {
            baseUrl: 'https://unknown.example/v1',
            models: [{ id: 'custom/my-model', name: 'My Model' }],
          },
        },
      },
      { modelRegistry: BUNDLED_CATALOG.modelRegistry },
    );
    // custom/my-model → no registry match → CUSTOM_EFFORTS for codex
    expect(p.models.codex?.[0]).toMatchObject({
      id: 'custom/my-model',
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      defaultEffort: 'high',
    });
  });

  it.each(["gpt-5.6-sol", "gpt-5.6-terra"])(
    "inherits equivalent Registry effort metadata across matching entries for %s",
    (modelId) => {
      const registry = structuredClone(BUNDLED_CATALOG.modelRegistry);
      if (!registry) throw new Error("missing bundled model registry");
      const baseEntry = registry.models.find(
        (entry) => entry.id === `openai/${modelId}`,
      );
      if (!baseEntry) throw new Error(`missing ${modelId} registry entry`);
      registry.models.push({
        ...structuredClone(baseEntry),
        id: `alternate/${modelId}`,
      });

      const provider = buildUserProvider(
        {
          id: "relay",
          name: "Relay",
          runtimes: {
            codex: {
              baseUrl: "https://relay.example/v1",
              models: [{ id: modelId, name: modelId }],
            },
          },
        },
        { modelRegistry: registry },
      );

      expect(provider.models.codex?.[0]).toMatchObject({
        efforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
        defaultEffort: "high",
      });
    },
  );

  it.each(["xd/gpt-5.6-sol", "chatgpt/gpt-5.6-sol"])(
    "inherits equivalent Registry effort metadata after stripping the prefix from %s",
    (modelId) => {
      const registry = structuredClone(BUNDLED_CATALOG.modelRegistry);
      if (!registry) throw new Error("missing bundled model registry");
      const baseEntry = registry.models.find(
        (entry) => entry.id === "openai/gpt-5.6-sol",
      );
      if (!baseEntry) throw new Error("missing gpt-5.6-sol registry entry");
      const first = structuredClone(baseEntry);
      first.id = "first/gpt-5.6-sol";
      first.routes = first.routes
        .filter((route) => route.agents.includes("codex"))
        .map((route) => ({ ...route, modelId: "gpt-5.6-sol" }));
      const second = structuredClone(first);
      second.id = "second/gpt-5.6-sol";
      registry.models = [first, second];

      const provider = buildUserProvider(
        {
          id: "prefixed-relay",
          name: "Prefixed Relay",
          runtimes: {
            codex: {
              baseUrl: "https://relay.example/v1",
              models: [{ id: modelId, name: modelId }],
            },
          },
        },
        { modelRegistry: registry },
      );

      expect(provider.models.codex?.[0]).toMatchObject({
        efforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
        defaultEffort: "high",
      });
    },
  );

  it("rejects conflicting Registry effort metadata after prefix stripping", () => {
    const registry = structuredClone(BUNDLED_CATALOG.modelRegistry);
    if (!registry) throw new Error("missing bundled model registry");
    const baseEntry = registry.models.find(
      (entry) => entry.id === "openai/gpt-5.6-sol",
    );
    if (!baseEntry) throw new Error("missing gpt-5.6-sol registry entry");
    const first = structuredClone(baseEntry);
    first.id = "first/gpt-5.6-sol";
    first.routes = first.routes
      .filter((route) => route.agents.includes("codex"))
      .map((route) => ({ ...route, modelId: "gpt-5.6-sol" }));
    const second = structuredClone(first);
    second.id = "second/gpt-5.6-sol";
    second.perAgent = {
      ...second.perAgent,
      codex: { efforts: ["low", "medium", "high"], defaultEffort: "high" },
    };
    registry.models = [first, second];

    const provider = buildUserProvider(
      {
        id: "conflicting-prefixed-relay",
        name: "Conflicting Prefixed Relay",
        runtimes: {
          codex: {
            baseUrl: "https://relay.example/v1",
            models: [{ id: "xd/gpt-5.6-sol", name: "GPT-5.6-Sol" }],
          },
        },
      },
      { modelRegistry: registry },
    );

    expect(provider.models.codex?.[0]).toMatchObject({
      efforts: ["low", "medium", "high", "xhigh", "max"],
      defaultEffort: "high",
    });
  });

    it('falls back safely for conflicting matches, missing target routes and invalid defaults', () => {
    const registry = structuredClone(BUNDLED_CATALOG.modelRegistry);
    if (!registry) throw new Error("missing bundled model registry");
    const baseEntry = registry.models.find(
      (entry) => entry.id === "openai/gpt-5.6-sol",
    );
    if (!baseEntry) throw new Error("missing gpt-5.6-sol registry entry");
    baseEntry.perAgent = {
      ...baseEntry.perAgent,
      codex: { efforts: ["minimal", "max"], defaultEffort: "high" },
    };
    registry.models.push({
      ...structuredClone(baseEntry),
      id: "alternate/gpt-5.6-sol",
      perAgent: {
        ...baseEntry.perAgent,
        codex: { efforts: ["low", "medium", "high"], defaultEffort: "high" },
      },
    });

    const ambiguous = buildUserProvider(
      {
        id: "ambiguous",
        name: "Ambiguous",
        runtimes: {
          codex: {
            baseUrl: "https://relay.example/v1",
            models: [{ id: "gpt-5.6-sol", name: "GPT-5.6-Sol" }],
          },
        },
      },
      { modelRegistry: registry },
    );
    expect(ambiguous.models.codex?.[0]).toMatchObject({
      efforts: ["low", "medium", "high", "xhigh", "max"],
      defaultEffort: "high",
    });

    registry.models.pop();
    const invalidDefault = buildUserProvider(
      {
        id: "unique",
        name: "Unique",
        runtimes: {
          codex: {
            baseUrl: "https://relay.example/v1",
            models: [{ id: "gpt-5.6-sol", name: "GPT-5.6-Sol" }],
          },
        },
      },
      { modelRegistry: registry },
    );
    expect(invalidDefault.models.codex?.[0]).toMatchObject({
      efforts: ["minimal", "max"],
      defaultEffort: "max",
    });

    const noTargetRoute = buildUserProvider(
      {
        id: "wrong-agent",
        name: "Wrong agent",
        runtimes: {
          codex: {
            baseUrl: "https://relay.example/v1",
            models: [
              { id: "google/gemini-3.5-flash", name: "Gemini 3.5 Flash" },
            ],
          },
        },
      },
      { modelRegistry: BUNDLED_CATALOG.modelRegistry },
    );
    expect(noTargetRoute.models.codex?.[0]).toMatchObject({
      efforts: ["low", "medium", "high", "xhigh", "max"],
      defaultEffort: "high",
    });
  });

  it("respects an explicit hidden default for discovered models", () => {
    const p = buildUserProvider({
      ...codexOnly,
      runtimes: {
        codex: {
          ...codexOnly.runtimes.codex!,
          models: [
            { id: "discovered", name: "Discovered", defaultEnabled: false },
          ],
        },
      },
    });
    expect(p.models.codex?.[0].defaultEnabled).toBe(false);
  });

  it("uses explicit runtime model contextWindow and defaults only when absent", () => {
    const p = buildUserProvider({
      ...codexOnly,
      runtimes: {
        codex: {
          ...codexOnly.runtimes.codex!,
          models: [
            {
              id: "long-context",
              name: "Long Context",
              contextWindow: 1_000_000,
            },
            { id: "default-context", name: "Default Context" },
          ],
        },
      },
    });
    expect(p.models.codex?.map((m) => [m.id, m.contextWindow])).toEqual([
      ["long-context", 1_000_000],
      ["default-context", DEFAULT_CUSTOM_CONTEXT_WINDOW],
    ]);
    // 只有用户自己填的窗口算「已核实」,可以拿去收敛运行期上报值;走 200K 兜底的那条
    // 不标记 —— 否则真实 1M 的端点会被这个展示用默认值压到 200K。
    expect(p.models.codex?.map((m) => [m.id, m.contextWindowVerified])).toEqual(
      [
        ["long-context", true],
        ["default-context", undefined],
      ],
    );
    // 显式配置打标、缺省物化不打标:编辑表单靠它区分「显式 200K」与「默认 200K」,
    // 不能靠与默认等值推断(显式覆盖必须在默认升级后原样保留)。
    expect(
      p.models.codex?.map((m) => [m.id, m.contextWindowExplicit ?? null]),
    ).toEqual([
      ["long-context", true],
      ["default-context", null],
    ]);
  });

  it("marks an explicit contextWindow equal to the current default as explicit", () => {
    const p = buildUserProvider({
      ...codexOnly,
      runtimes: {
        codex: {
          ...codexOnly.runtimes.codex!,
          models: [
            {
              id: "pinned-default",
              name: "Pinned",
              contextWindow: DEFAULT_CUSTOM_CONTEXT_WINDOW,
            },
          ],
        },
      },
    });
    expect(p.models.codex?.[0]).toMatchObject({
      contextWindow: DEFAULT_CUSTOM_CONTEXT_WINDOW,
      contextWindowVerified: true,
      contextWindowExplicit: true,
    });
  });

  it("attaches per-runtime custom headers (still no api key)", () => {
    const p = buildUserProvider({
      ...codexOnly,
      runtimes: {
        codex: { ...codexOnly.runtimes.codex!, headers: { "X-Org": "acme" } },
      },
    });
    expect(p.routing.codex?.headerOverride).toEqual({ "X-Org": "acme" });
    expect(p.routing.codex?.headerOverrideState).toBe("configured");
  });

  it("carries modelsUrl into routing (edit-form round-trip), absent when unset", () => {
    const p = buildUserProvider({
      ...codexOnly,
      runtimes: {
        codex: {
          ...codexOnly.runtimes.codex!,
          modelsUrl: "https://openrouter.ai/api/v1/models",
        },
      },
    });
    expect(p.routing.codex?.modelsUrl).toBe(
      "https://openrouter.ai/api/v1/models",
    );
    expect(
      buildUserProvider(codexOnly).routing.codex?.modelsUrl,
    ).toBeUndefined();
  });

  it("does not infer subscription access from a generic OAuth login method", () => {
    const p = buildUserProvider({
      ...codexOnly,
      auth: {
        method: "oauth",
        oauth: {
          authorizeUrl: "https://openrouter.ai/oauth/authorize",
          tokenUrl: "https://openrouter.ai/oauth/token",
          clientId: "xdt-maker",
          scopes: "models",
        },
      },
    });
    expect(p.auth).toMatchObject({ method: "oauth" });
    expect(p.access).toBeUndefined();
    expect(p.routing.codex?.authStrategy).toBe("oauth-token");
  });

  it("maps an explicit no-auth proxy without falling back to API-key routing", () => {
    const p = buildUserProvider({
      ...codexOnly,
      id: "litellm-proxy",
      auth: { method: "none" },
      runtimes: {
        codex: {
          baseUrl: "http://127.0.0.1:4000/v1",
          models: [{ id: "local-model", name: "Local model" }],
        },
      },
    });
    expect(p.auth).toEqual({ method: "none" });
    expect(p.access).toEqual({ kind: "api" });
    expect(p.routing.codex?.authStrategy).toBe("none");
    expect(p.routing.codex?.disabled).toBeUndefined();
  });

  it("keeps a legacy remote no-auth runtime editable but disables its route", () => {
    const p = buildUserProvider({
      ...codexOnly,
      id: "legacy-remote-no-auth",
      auth: { method: "none" },
      runtimes: {
        codex: {
          baseUrl: "https://remote.example/v1",
          models: [{ id: "legacy-model", name: "Legacy model" }],
        },
      },
    });

    expect(p.agents).toEqual(["codex"]);
    expect(p.routing.codex).toMatchObject({
      upstream: "https://remote.example/v1",
      authStrategy: "none",
      disabled: true,
    });
    expect(p.models.codex?.map((model) => model.id)).toEqual(["legacy-model"]);
  });

  it("supports two runtimes with independent baseUrl + models, stable agent order", () => {
    const p = buildUserProvider({
      id: "vendor",
      name: "Vendor",
      runtimes: {
        codex: {
          baseUrl: "https://vendor.ai/openai/v1",
          models: [{ id: "gpt-x", name: "GPT X" }],
        },
        "claude-code": {
          baseUrl: "https://vendor.ai/anthropic",
          models: [{ id: "claude-x", name: "Claude X" }],
        },
      },
    });
    // 固定顺序 claude-code 先于 codex（与 AGENT_ORDER 一致）。
    expect(p.agents).toEqual(["claude-code", "codex"]);
    expect(p.routing["claude-code"]?.upstream).toBe(
      "https://vendor.ai/anthropic",
    );
    expect(p.routing.codex?.upstream).toBe("https://vendor.ai/openai/v1");
    expect((p.models["claude-code"] ?? []).map((m) => m.id)).toEqual([
      "claude-x",
    ]);
    expect((p.models.codex ?? []).map((m) => m.id)).toEqual(["gpt-x"]);
  });

  it("produces an inert Provider when runtimes is empty", () => {
    const p = buildUserProvider({ id: "x", name: "X", runtimes: {} });
    expect(p.agents).toEqual([]);
    expect(p.routing).toEqual({});
    expect(p.models).toEqual({});
  });

  it("keeps legacy Pi custom models non-reasoning until the capability is explicitly enabled", () => {
    const p = buildUserProvider({
      id: "localollama",
      name: "Local Ollama",
      auth: { method: "none" },
      runtimes: {
        pi: {
          baseUrl: "http://127.0.0.1:11434/v1",
          wireProtocol: "openai-chat",
          models: [
            { id: "qwen3:8b", name: "Qwen3 8B", supportsImageInput: true },
          ],
        },
      },
    });
    expect(p.agents).toEqual(["pi"]);
    expect(p.auth).toEqual({ method: "none" });
    expect((p.models.pi ?? []).map((m) => m.id)).toEqual(["qwen3:8b"]);
    expect((p.models.pi ?? [])[0]?.efforts).toEqual([]);
    expect((p.models.pi ?? [])[0]?.defaultEffort).toBeNull();
    expect((p.models.pi ?? [])[0]?.group).toBe("custom:localollama");
    expect((p.models.pi ?? [])[0]?.supportsImageInput).toBe(true);
    expect(p.routing.pi?.wireProtocol).toBe('openai-chat');
  });

  it('projects image generation independently from image input', () => {
    const p = buildUserProvider({
      id: 'images',
      name: 'Images',
      runtimes: {
        codex: {
          baseUrl: 'https://images.example/v1',
          wireProtocol: 'openai-responses',
          supportsImageGeneration: true,
          models: [
            { id: 'generate', name: 'Generate' },
            { id: 'input', name: 'Input', supportsImageInput: true },
          ],
        },
      },
    });
    expect(p.routing.codex?.supportsImageGeneration).toBe(true);
    expect(p.models.codex?.[0]?.supportsImageInput).toBeUndefined();
    expect(p.models.codex?.[1]?.supportsImageInput).toBe(true);
  });

  it("does not export unverified CC/Codex efforts for managed Ollama", () => {
    const p = buildUserProvider({
      id: "cindy-local-ollama",
      name: "Ollama",
      auth: { method: "none" },
      runtimes: {
        pi: {
          baseUrl: "http://127.0.0.1:11434/v1",
          wireProtocol: "openai-chat",
          models: [
            {
              id: "qwen3.8:27b-mlx",
              name: "Qwen3.8",
              reasoning: true,
              reasoningEfforts: ["xhigh"],
              reasoningDefaultEffort: "xhigh",
            },
          ],
        },
        "claude-code": {
          baseUrl: "http://127.0.0.1:11434",
          wireProtocol: "anthropic-messages",
          models: [{ id: "qwen3.8:27b-mlx", name: "Qwen3.8", reasoning: false }],
        },
        codex: {
          baseUrl: "http://127.0.0.1:11434/v1",
          wireProtocol: "openai-responses",
          models: [{ id: "qwen3.8:27b-mlx", name: "Qwen3.8", reasoning: false }],
        },
      },
    });
    expect(p.models.pi?.[0]?.efforts).toEqual(["xhigh"]);
    expect(p.models["claude-code"]?.[0]?.efforts).toEqual([]);
    expect(p.models.codex?.[0]?.efforts).toEqual([]);
  });

  it("exports confirmed Ollama reasoning efforts on Claude Code", () => {
    const p = buildUserProvider({
      id: "cindy-local-ollama",
      name: "Ollama",
      auth: { method: "none" },
      runtimes: {
        "claude-code": {
          baseUrl: "http://127.0.0.1:11434",
          wireProtocol: "anthropic-messages",
          models: [
            {
              id: "qwen3.8:27b-mxfp8",
              name: "Qwen3.8 27B",
              reasoning: true,
              reasoningEfforts: ["xhigh"],
              reasoningDefaultEffort: "xhigh",
              thinkingToggle: true,
            },
          ],
        },
      },
    });
    expect(p.models["claude-code"]?.[0]).toMatchObject({
      name: "Qwen3.8 27B",
      efforts: ["xhigh"],
      thinkingToggle: true,
    });
  });

  it("never infers Pi efforts from a same-named Registry model", () => {
    const p = buildUserProvider(
      {
        id: "pi-relay",
        name: "Pi Relay",
        runtimes: {
          pi: {
            baseUrl: "https://relay.example/v1",
            models: [{ id: "gpt-5.6-sol", name: "GPT-5.6-Sol" }],
          },
        },
      },
      { modelRegistry: BUNDLED_CATALOG.modelRegistry },
    );
    expect(p.models.pi?.[0]).toMatchObject({
      efforts: [],
      defaultEffort: null,
    });
  });

  it('strips xd/ prefix to match registry effort metadata for claude-code', () => {
    const p = buildUserProvider(
      {
        id: 'my-provider',
        name: 'My Provider',
        runtimes: {
          'claude-code': {
            baseUrl: 'https://my-provider.example/v1',
            models: [{ id: 'xd/codex/gpt-5.6-sol', name: 'GPT-5.6-Sol' }],
          },
        },
      },
      { modelRegistry: BUNDLED_CATALOG.modelRegistry },
    );
    // xd/codex/gpt-5.6-sol → strips xd/ → codex/gpt-5.6-sol → matches route for claude-code
    // without prefix-stripping, the model ID wouldn't match any registry entry
    // and efforts would fall back to CUSTOM_EFFORTS (no 'xhigh' from registry).
    const model = p.models['claude-code']?.[0];
    expect(model?.efforts?.length).toBeGreaterThan(0);
    expect(model?.efforts).toContain('xhigh');
  });

  it('strips xd/ prefix to match registry effort metadata for codex', () => {
    const p = buildUserProvider(
      {
        id: 'xd-relay',
        name: 'XD Relay',
        runtimes: {
          codex: {
            baseUrl: 'https://xd-relay.example/v1',
            models: [{ id: 'xd/gpt-5.6-sol', name: 'GPT-5.6-Sol' }],
          },
        },
      },
      { modelRegistry: BUNDLED_CATALOG.modelRegistry },
    );
    const model = p.models.codex?.[0];
    expect(model?.efforts?.length).toBeGreaterThan(0);
    expect(model?.efforts).toContain('xhigh');
  });

  it('synthetic registry: prefix stripping is required for openai/xd/chatgpt/ prefixes', () => {
    // Synthetic registry where entry id = 'synthetic-gpt' with 'ultra' effort.
    // Custom model id = 'openai/synthetic-gpt' can only match via prefix stripping.
    // If strip-prefix code is removed, efforts would remain empty.
    const syntheticRegistry: ModelRegistry = {
      updatedAt: '2026-01-01T00:00:00Z',
      schemaVersion: 2,
      models: [
        {
          id: 'synthetic-gpt',
          name: 'Synthetic GPT',
          efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
          defaultEffort: 'high',
          routes: [
            { providerId: 'test-provider', modelId: 'synthetic-gpt', agents: ['claude-code', 'codex'] },
          ],
        },
      ],
    };

    // openai/ prefix: should strip and match synthetic-gpt
    const pOpenai = buildUserProvider(
      { id: 'relay', name: 'R', runtimes: { 'claude-code': { baseUrl: 'https://x/v1', models: [{ id: 'openai/synthetic-gpt', name: 'G' }] } } },
      { modelRegistry: syntheticRegistry },
    );
    expect(pOpenai.models['claude-code']?.[0]?.efforts).toContain('ultra');

    // xd/ prefix: should strip and match
    const pXd = buildUserProvider(
      { id: 'relay', name: 'R', runtimes: { codex: { baseUrl: 'https://x/v1', models: [{ id: 'xd/synthetic-gpt', name: 'G' }] } } },
      { modelRegistry: syntheticRegistry },
    );
    expect(pXd.models.codex?.[0]?.efforts).toContain('ultra');

    // chatgpt/ prefix: should strip and match
    const pChatgpt = buildUserProvider(
      { id: 'relay', name: 'R', runtimes: { 'claude-code': { baseUrl: 'https://x/v1', models: [{ id: 'chatgpt/synthetic-gpt', name: 'G' }] } } },
      { modelRegistry: syntheticRegistry },
    );
    expect(pChatgpt.models['claude-code']?.[0]?.efforts).toContain('ultra');

    // unknown prefix: should NOT match registry, gets default CUSTOM_EFFORTS (no 'ultra')
    const pUnknown = buildUserProvider(
      { id: 'relay', name: 'R', runtimes: { 'claude-code': { baseUrl: 'https://x/v1', models: [{ id: 'unknown/synthetic-gpt', name: 'G' }] } } },
      { modelRegistry: syntheticRegistry },
    );
    expect(pUnknown.models['claude-code']?.[0]?.efforts).not.toContain('ultra');

    // no prefix: should match directly
    const pDirect = buildUserProvider(
      { id: 'relay', name: 'R', runtimes: { 'claude-code': { baseUrl: 'https://x/v1', models: [{ id: 'synthetic-gpt', name: 'G' }] } } },
      { modelRegistry: syntheticRegistry },
    );
    expect(pDirect.models['claude-code']?.[0]?.efforts).toContain('ultra');
  });

  it('Case A: exact match takes priority over prefix-stripped match (no ambiguity)', () => {
    // Registry has two entries:
    //   A: id='openai/foo', route.modelId='openai/foo', efforts=['ultra']
    //   B: id='other', route.modelId='foo', efforts=['low']
    // Custom model: openai/foo
    // Stage 1 exact: matches A (entry.id='openai/foo') → unique → use A's efforts
    // Without two-stage: both A and B match → ambiguous → fallback
    const reg: ModelRegistry = {
      updatedAt: '2026-01-01T00:00:00Z',
      schemaVersion: 2,
      models: [
        {
          id: 'openai/foo', name: 'OpenAI Foo',
          efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
          defaultEffort: 'high',
          routes: [{ providerId: 'openai', modelId: 'openai/foo', agents: ['codex'] }],
        },
        {
          id: 'other', name: 'Other Foo',
          efforts: ['low', 'medium', 'high'],
          defaultEffort: 'low',
          routes: [{ providerId: 'other', modelId: 'foo', agents: ['codex'] }],
        },
      ],
    };
    const p = buildUserProvider(
      { id: 'relay', name: 'R', runtimes: { codex: { baseUrl: 'https://x/v1', models: [{ id: 'openai/foo', name: 'F' }] } } },
      { modelRegistry: reg },
    );
    // Must select entry A (exact match), not ambiguous fallback
    expect(p.models.codex?.[0]?.efforts).toContain('ultra');
    expect(p.models.codex?.[0]?.defaultEffort).toBe('high');
  });

  it('Case B: no exact match → prefix fallback finds unique entry', () => {
    // No entry with id='openai/bar' or route.modelId='openai/bar'
    // But route.modelId='bar' exists → strip openai/ to find it
    const reg: ModelRegistry = {
      updatedAt: '2026-01-01T00:00:00Z',
      schemaVersion: 2,
      models: [
        {
          id: 'registry-bar', name: 'Registry Bar',
          efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
          defaultEffort: 'max',
          routes: [{ providerId: 'test', modelId: 'bar', agents: ['claude-code'] }],
        },
      ],
    };
    const p = buildUserProvider(
      { id: 'relay', name: 'R', runtimes: { 'claude-code': { baseUrl: 'https://x/v1', models: [{ id: 'openai/bar', name: 'B' }] } } },
      { modelRegistry: reg },
    );
    // Stage 1: no exact match for 'openai/bar'
    // Stage 2: strip openai/ → 'bar' → matches route.modelId → unique
    expect(p.models['claude-code']?.[0]?.efforts).toContain('ultra');
    expect(p.models['claude-code']?.[0]?.defaultEffort).toBe('max');
  });

  it('Case C: no exact match → prefix fallback yields ambiguity → CUSTOM_EFFORTS', () => {
    // Two entries both have route.modelId='baz' after stripping openai/
    const reg: ModelRegistry = {
      updatedAt: '2026-01-01T00:00:00Z',
      schemaVersion: 2,
      models: [
        {
          id: 'entry-1', name: 'E1',
          efforts: ['low', 'ultra'],
          routes: [{ providerId: 'p1', modelId: 'baz', agents: ['codex'] }],
        },
        {
          id: 'entry-2', name: 'E2',
          efforts: ['low', 'high'],
          routes: [{ providerId: 'p2', modelId: 'baz', agents: ['codex'] }],
        },
      ],
    };
    const p = buildUserProvider(
      { id: 'relay', name: 'R', runtimes: { codex: { baseUrl: 'https://x/v1', models: [{ id: 'openai/baz', name: 'B' }] } } },
      { modelRegistry: reg },
    );
    // Ambiguous → falls back to CUSTOM_EFFORTS (no 'ultra')
    expect(p.models.codex?.[0]?.efforts).not.toContain('ultra');
  });

  it('exports only the explicitly supported effort levels for a Pi reasoning model', () => {
    const p = buildUserProvider({
      id: "reasoning-pi",
      name: "Reasoning Pi",
      runtimes: {
        pi: {
          baseUrl: "https://example.test/v1",
          wireProtocol: "openai-responses",
          models: [
            {
              id: "reasoner",
              name: "Reasoner",
              reasoning: true,
              reasoningEfforts: ["low", "high", "xhigh"],
            },
          ],
        },
      },
    });

    expect(p.models.pi?.[0]).toMatchObject({
      efforts: ["low", "high", "xhigh"],
      defaultEffort: "high",
    });
  });

  it.each([
    ["kimi", "max"],
    ["deepseek", "high"],
  ] as const)(
    "uses the explicit %s Pi default reasoning effort",
    (id, expected) => {
      const p = buildUserProvider({
        id,
        name: id,
        runtimes: {
          pi: {
            baseUrl: `https://${id}.example/v1`,
            models: [
              {
                id: `${id}-model`,
                name: `${id} model`,
                reasoning: true,
                reasoningEfforts: ["low", "high", "max"],
                reasoningDefaultEffort: expected,
              },
            ],
          },
        },
      });
      expect(p.models.pi?.[0]).toMatchObject({
        efforts: ["low", "high", "max"],
        defaultEffort: expected,
      });
    },
  );

  it("orders pi after claude-code and codex (AGENT_ORDER)", () => {
    const p = buildUserProvider({
      id: "multi",
      name: "Multi",
      runtimes: {
        pi: {
          baseUrl: "http://127.0.0.1:8000/v1",
          models: [{ id: "pi-m", name: "Pi M" }],
        },
        codex: {
          baseUrl: "https://v.ai/openai/v1",
          models: [{ id: "cx-m", name: "Cx M" }],
        },
        "claude-code": {
          baseUrl: "https://v.ai/anthropic",
          models: [{ id: "cc-m", name: "Cc M" }],
        },
      },
    });
    expect(p.agents).toEqual(["claude-code", "codex", "pi"]);
  });
});
