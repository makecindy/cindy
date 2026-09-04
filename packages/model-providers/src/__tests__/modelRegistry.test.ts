import { describe, expect, it } from "vitest";

import { BUNDLED_CATALOG } from "../builtin.js";
import {
  compareModelRegistryRevisions,
  findModelRegistryRoute,
  resolveModelReferencePrice,
} from "../modelRegistry.js";

const registry = BUNDLED_CATALOG.modelRegistry;

describe("model registry", () => {
  it.each([
    { variant: "standard" as const, inputPerMtok: 10, cacheWritePerMtok: 12.5 },
    { variant: "fast" as const, inputPerMtok: 20, cacheWritePerMtok: 25 },
  ])("Astra $variant prices are available on the verified UTC day", ({ variant, inputPerMtok, cacheWritePerMtok }) => {
    // September 5 in Auckland is still September 4 UTC: pricing uses the UTC day.
    const options = { at: new Date("2026-09-04T21:00:00Z"), variant, inputTokens: 272_000 };
    expect(resolveModelReferencePrice(registry, "openai", "gpt-6-astra", options)?.price)
      .toMatchObject({ inputPerMtok, cacheWritePerMtok });
    expect(resolveModelReferencePrice(registry, "openai", "gpt-6-astra", {
      ...options, inputTokens: 272_001,
    })).toBeUndefined();
  });

  it("compares revision instants with normalized timestamps before checking content", () => {
    if (!registry) throw new Error("missing bundled registry");
    const current = { ...registry, updatedAt: "2026-08-02T02:00:00.000Z" };
    const equivalent = { ...registry, updatedAt: "2026-08-02T10:00:00.000+08:00" };

    expect(compareModelRegistryRevisions(equivalent, current)).toBe("same");
    expect(
      compareModelRegistryRevisions(
        { ...equivalent, models: equivalent.models.slice(1) },
        current,
      ),
    ).toBe("conflict");
    expect(
      compareModelRegistryRevisions(
        { ...registry, updatedAt: "2026-08-02T01:59:59.999Z" },
        current,
      ),
    ).toBe("older");
    expect(
      compareModelRegistryRevisions(
        { ...registry, updatedAt: "2026-08-02T02:00:00.001Z" },
        current,
      ),
    ).toBe("newer");
    expect(compareModelRegistryRevisions({ ...registry, updatedAt: "invalid" }, current)).toBe(
      "invalid-incoming",
    );
  });

  it("resolves exact provider/runtime routes without claiming availability", () => {
    expect(
      findModelRegistryRoute(
        registry,
        "anthropic",
        "claude-opus-5",
        "claude-code",
      ),
    ).toMatchObject({
      entry: { id: "anthropic/claude-opus-5", contextWindow: 1_000_000 },
      route: { providerId: "anthropic", modelId: "claude-opus-5" },
    });
    expect(
      findModelRegistryRoute(
        registry,
        "  anthropic  ",
        "  claude-opus-5  ",
        "claude-code",
      ),
    ).toMatchObject({
      route: { providerId: "anthropic", modelId: "claude-opus-5" },
    });
    expect(
      findModelRegistryRoute(
        registry,
        "other-provider",
        "claude-opus-5",
        "claude-code",
      ),
    ).toBeUndefined();
  });

  it("normalizes the ChatGPT bridge id and selects OpenAI long-context bands", () => {
    // 2026-08-16 随上游目录收敛:XD 网关不再拆独立条目,而是作为 `openai/*` 条目的
    // 额外 route;窗口等元数据**以服务端目录快照为准**(本地不再维护拆分值,快照
    // 08-14 起两条路由同为 372K)。这里只锁「同一条目、双路由可解析」的结构。
    expect(
      findModelRegistryRoute(registry, "openai", "gpt-5.6-sol", "codex"),
    ).toMatchObject({
      entry: {
        contextWindow: 1_050_000,
        maxOutputTokens: 128_000,
        perAgent: { codex: { contextWindow: 372_000 } },
      },
    });
    expect(
      findModelRegistryRoute(registry, "xd", "gpt-5.6-sol", "codex"),
    ).toMatchObject({
      entry: { id: "openai/gpt-5.6-sol", perAgent: { codex: { contextWindow: 372_000 } } },
    });
    expect(
      resolveModelReferencePrice(registry, "openai", "chatgpt/gpt-5.6-sol", {
        agent: "claude-code",
        inputTokens: 272_000,
      })?.price,
    ).toMatchObject({ inputPerMtok: 5, outputPerMtok: 30 });
    expect(
      resolveModelReferencePrice(registry, "openai", "chatgpt/gpt-5.6-sol[1m]", {
        agent: "claude-code",
        inputTokens: 272_001,
      })?.price,
    ).toMatchObject({ inputPerMtok: 10, outputPerMtok: 45 });
    expect(
      resolveModelReferencePrice(registry, "openai", "gpt-5.6-sol", {
        agent: "codex",
        inputTokens: 272_001,
      })?.price,
    ).toMatchObject({ inputPerMtok: 10, outputPerMtok: 45 });
    expect(
      resolveModelReferencePrice(registry, "openai", "gpt-5.4-nano", {
        agent: "codex",
      })?.price,
    ).toMatchObject({ inputPerMtok: 0.2, outputPerMtok: 1.25 });
  });

  it("selects xAI token bands and time-effective Anthropic prices", () => {
    expect(
      resolveModelReferencePrice(registry, "xai", "xai/grok-4.6", {
        inputTokens: 199_999,
      })?.price,
    ).toMatchObject({ inputPerMtok: 2, outputPerMtok: 6, cacheReadPerMtok: 0.5 });
    expect(
      resolveModelReferencePrice(registry, "xai", "xai/grok-4.6", {
        inputTokens: 200_000,
      })?.price,
    ).toMatchObject({ inputPerMtok: 2, outputPerMtok: 6, cacheReadPerMtok: 0.5 });
    expect(
      resolveModelReferencePrice(registry, "xai", "xai/grok-4.5", {
        inputTokens: 199_999,
      })?.price,
    ).toMatchObject({ inputPerMtok: 2, outputPerMtok: 6 });
    expect(
      resolveModelReferencePrice(registry, "xai", "xai/grok-4.5", {
        inputTokens: 200_000,
      })?.price,
    ).toMatchObject({ inputPerMtok: 4, outputPerMtok: 12 });
    expect(
      resolveModelReferencePrice(registry, "xai", "xai/grok-build-0.1", {
        inputTokens: 200_000,
      })?.price,
    ).toMatchObject({ inputPerMtok: 2, outputPerMtok: 4 });
    expect(
      [
        "xai/grok-4.20-multi-agent-0309",
        "xai/grok-4.20-0309-reasoning",
        "xai/grok-4.20-0309-non-reasoning",
      ].every((modelId) =>
        Boolean(findModelRegistryRoute(registry, "xai", modelId, "codex")),
      ),
    ).toBe(true);
    expect(
      resolveModelReferencePrice(registry, "anthropic", "claude-sonnet-5", {
        at: "2026-08-31",
      })?.price,
    ).toMatchObject({ inputPerMtok: 2, outputPerMtok: 10 });
    expect(
      resolveModelReferencePrice(registry, "anthropic", "claude-sonnet-5", {
        at: "2026-09-01",
      })?.price,
    ).toMatchObject({ inputPerMtok: 3, outputPerMtok: 15 });
  });

  it("resolves DeepSeek BYOK cache-hit pricing for both runtimes", () => {
    for (const [modelId, expected] of [
      [
        "deepseek-v4-pro",
        { inputPerMtok: 0.435, outputPerMtok: 0.87, cacheReadPerMtok: 0.003625 },
      ],
      [
        "deepseek-v4-flash",
        { inputPerMtok: 0.14, outputPerMtok: 0.28, cacheReadPerMtok: 0.0028 },
      ],
    ] as const) {
      expect(
        resolveModelReferencePrice(registry, "deepseek", modelId, {
          agent: "claude-code",
          at: "2026-08-05",
        })?.price,
      ).toMatchObject(expected);
      expect(
        resolveModelReferencePrice(registry, "deepseek", modelId, {
          agent: "codex",
          at: "2026-08-05",
        })?.price,
      ).toMatchObject(expected);
    }
  });

  it("normalizes historical Claude aliases before resolving date-effective prices", () => {
    expect(
      resolveModelReferencePrice(registry, "anthropic", "sonnet", {
        agent: "claude-code",
        at: "2026-03-01",
      }),
    ).toMatchObject({
      route: { modelId: "claude-sonnet-4-6" },
      price: { inputPerMtok: 3, outputPerMtok: 15 },
    });
    expect(
      resolveModelReferencePrice(
        registry,
        "anthropic",
        "claude-sonnet-4-6-20260701",
        { agent: "claude-code", at: "2026-08-01" },
      ),
    ).toMatchObject({
      route: { modelId: "claude-sonnet-4-6" },
      price: { inputPerMtok: 3, outputPerMtok: 15 },
    });
  });
});
