import { describe, expect, it } from "vitest";

import { BUNDLED_CATALOG } from "../builtin.js";
import {
  compareModelRegistryRevisions,
  findModelRegistryRoute,
  resolveModelReferencePrice,
} from "../modelRegistry.js";

const registry = BUNDLED_CATALOG.modelRegistry;

describe("model registry", () => {
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
      resolveModelReferencePrice(registry, "openai", "chatgpt/gpt-5.6-sol", {
        agent: "claude-code",
        inputTokens: 272_000,
      })?.price,
    ).toMatchObject({ inputPerMtok: 5, outputPerMtok: 30 });
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
