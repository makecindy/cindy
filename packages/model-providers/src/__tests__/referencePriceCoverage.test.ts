import { describe, expect, it } from "vitest";
import { BUNDLED_CATALOG } from "../builtin.js";
import {
  resolveBaseModelReferencePrice,
  resolveModelReferencePrice,
} from "../modelRegistry.js";

const registry = BUNDLED_CATALOG.modelRegistry;
const at = "2026-09-23";

// Production price resolution: the existing CN route previously had no quote.
// Unit tier; also protects currency/date/variant boundaries for all consumers.
describe("MiniMax M3.1 Flash verified China tariff", () => {
  const options = { at: "2026-11-05", officialOnly: true };
  const model = "MiniMax-M3.1-Flash";
  it("selects the China quote without importing M3 tiers or cache-write prices", () => {
    const price = resolveModelReferencePrice(registry, "minimax-cn", model, options)?.price;
    expect(price).toMatchObject({ currency: "CNY", inputPerMtok: 1, outputPerMtok: 4, cacheReadPerMtok: 0.1 });
    expect(price?.cacheWritePerMtok).toBeUndefined();
    expect(price?.cacheWrite1hPerMtok).toBeUndefined();
    expect(resolveModelReferencePrice(registry, "minimax-cn", model, { ...options, inputTokens: 600_000 })?.price).toEqual(price);
    expect(resolveModelReferencePrice(registry, "minimax-global", model, options)?.price).toMatchObject({ currency: "USD", inputPerMtok: 0.15, outputPerMtok: 0.6, cacheReadPerMtok: 0.015 });
  });
  it("keeps historical, mismatched currency and unpublished Fast quotes unknown", () => {
    for (const extra of [{ at: "2026-11-04" }, { currency: "USD" as const }, { variant: "fast" as const }]) {
      expect(resolveModelReferencePrice(registry, "minimax-cn", model, { ...options, ...extra })).toBeUndefined();
    }
    expect(resolveBaseModelReferencePrice(registry, model, options)).toBeUndefined();
    expect(resolveBaseModelReferencePrice(registry, model, { ...options, priceGroup: "cn" })?.price.currency).toBe("CNY");
  });
});

// Production price selectors are shared by Desktop and Mobile. Missing Haiku
// prices previously resolved to unknown. Test the official 100,000-token boundary
// (half-open catalog ranges), five cache/token rates and date/variant isolation.
describe("Haiku 5.5 official prompt-length pricing", () => {
  it.each([
    [99_999, 0.1, 0.5, 0.01, 0.125, 0.2],
    [100_000, 0.1, 0.5, 0.01, 0.125, 0.2],
    [100_001, 0.5, 2.5, 0.05, 0.625, 1],
    [1_000_000, 0.5, 2.5, 0.05, 0.625, 1],
  ])("selects all five official rates for %i total prompt tokens",
    (inputTokens, input, output, read, write, write1h) => {
      const options = { at: "2026-11-05", inputTokens, currency: "USD" as const };
      const expected = {
        inputPerMtok: input, outputPerMtok: output,
        cacheReadPerMtok: read, cacheWritePerMtok: write,
        cacheWrite1hPerMtok: write1h,
      };
      expect(resolveBaseModelReferencePrice(registry, "claude-haiku-5-5", options)?.price)
        .toMatchObject(expected);
      expect(resolveModelReferencePrice(registry, "anthropic", "claude-haiku-5-5", {
        ...options, officialOnly: true,
      })?.price).toMatchObject(expected);
    },
  );

  it("does not invent historical, Fast or CNY prices", () => {
    for (const options of [
      { at: "2026-11-04" },
      { at: "2026-11-05", variant: "fast" as const },
      { at: "2026-11-05", currency: "CNY" as const },
    ]) {
      expect(resolveBaseModelReferencePrice(registry, "claude-haiku-5-5", options)).toBeUndefined();
      expect(resolveModelReferencePrice(registry, "anthropic", "claude-haiku-5-5", options)).toBeUndefined();
    }
  });
});

// Unit regression: an explicit Batch quote was unknown despite the official
// absolute prices. Keep the integer-token boundary and do not inherit caches
// or historical dates from the existing Standard rows.
describe("Haiku 5.5 Batch reference prices adopted on November 6 UTC", () => {
  it.each([[100_000, 0.05, 0.25], [100_001, 0.25, 1.25], [1_000_000, 0.25, 1.25]])(
    "resolves Batch at %i prompt tokens without guessing cache rates", (inputTokens, input, output) => {
      const options = { at: "2026-11-06", variant: "batch" as const, currency: "USD" as const, inputTokens };
      const price = resolveBaseModelReferencePrice(registry, "claude-haiku-5-5", options)?.price;
      expect(price).toEqual({
        currency: "USD", variant: "batch",
        ...(inputTokens <= 100_000 ? { maxInputTokens: 100001 } : { minInputTokens: 100001 }),
        inputPerMtok: input, outputPerMtok: output, effectiveFrom: "2026-11-06",
        source: { kind: "provider-official", url: "https://platform.claude.com/docs/en/about-claude/pricing", verifiedAt: "2026-11-06" },
      });
      expect(resolveModelReferencePrice(registry, "anthropic", "claude-haiku-5-5", { ...options, officialOnly: true })?.price).toEqual(price);
    },
  );

  it("keeps pre-adoption and CNY Batch unknown and leaves the default Standard quote intact", () => {
    for (const options of [
      { at: "2026-11-05", variant: "batch" as const },
      { at: "2026-11-06", variant: "batch" as const, currency: "CNY" as const },
    ]) expect(resolveBaseModelReferencePrice(registry, "claude-haiku-5-5", options)).toBeUndefined();
    expect(resolveBaseModelReferencePrice(registry, "claude-haiku-5-5", { at: "2026-11-06" })?.price)
      .toMatchObject({ variant: "standard", inputPerMtok: 0.1, outputPerMtok: 0.5, cacheReadPerMtok: 0.01 });
  });
});

describe("Kimi K3 one-hour cache writes adopted on November 5", () => {
  it.each([
    ["moonshot-kimi-cn", "kimi-k3", "kimi-k3", "cn", "CNY", 20, 100, 2, 40],
    ["moonshot-kimi-global", "kimi-k3", "kimi-k3", "global", "USD", 3, 15, 0.3, 6],
    ["xd", "moonshot/kimi-k3", "xd/moonshotai-kimi-k3", "global", "USD", 3, 15, 0.3, 6],
    ["xd", "moonshotai/kimi-k3", "xd/moonshotai-kimi-k3", "global", "USD", 3, 15, 0.3, 6],
  ] as const)("resolves %s/%s without backfilling the historical gap",
    (provider, model, baseModel, priceGroup, currency, input, output, read, write1h) => {
      const options = { at: "2026-11-05", officialOnly: true };
      const price = resolveModelReferencePrice(registry, provider, model, options)?.price;
      expect(price).toMatchObject({
        currency, variant: "standard", inputPerMtok: input, outputPerMtok: output,
        cacheReadPerMtok: read, cacheWritePerMtok: input, cacheWrite1hPerMtok: write1h,
        effectiveFrom: "2026-11-05",
      });
      expect(resolveBaseModelReferencePrice(registry, baseModel, { ...options, priceGroup })?.price).toEqual(price);
      const historical = resolveModelReferencePrice(registry, provider, model, { ...options, at: "2026-11-04" })?.price;
      expect(historical).toMatchObject({ currency, cacheWritePerMtok: input });
      expect(historical?.cacheWrite1hPerMtok).toBeUndefined();
      expect(resolveModelReferencePrice(registry, provider, model, { ...options, variant: "fast" })).toBeUndefined();
    });
});

// Unit: production price resolution from the complete bundled Registry. K3.1 had no
// prices; cover both models/markets, historical unknowns and channel isolation.
describe("Kimi K3.1 official API reference prices", () => {
  it.each([
    ["kimi-k3.1-pro", "cn", "CNY", 13, 68, 1.3, 13, 26],
    ["kimi-k3.1-pro", "global", "USD", 2, 10, 0.2, 2, 4],
    ["kimi-k3.1-pro-highspeed", "cn", "CNY", 26, 136, 1.3, 26, 52],
    ["kimi-k3.1-pro-highspeed", "global", "USD", 4, 20, 0.2, 4, 8],
  ] as const)(
    "resolves %s/%s without guessing another currency or historical price",
    (model, market, currency, input, output, read, write, write1h) => {
      const options = { at: "2026-11-05", officialOnly: true };
      const price = resolveModelReferencePrice(registry, `moonshot-kimi-${market}`, model, options)?.price;
      expect(price).toMatchObject({
        currency, variant: "standard", inputPerMtok: input, outputPerMtok: output,
        cacheReadPerMtok: read, cacheWritePerMtok: write, cacheWrite1hPerMtok: write1h,
      });
      expect(resolveBaseModelReferencePrice(registry, model, { ...options, priceGroup: market })?.price).toEqual(price);
      expect(resolveBaseModelReferencePrice(registry, model, options)).toBeUndefined();
      expect(resolveModelReferencePrice(registry, `moonshot-kimi-${market}`, model, { ...options, currency: currency === "CNY" ? "USD" : "CNY" })).toBeUndefined();
      expect(resolveModelReferencePrice(registry, `moonshot-kimi-${market}`, model, { at: "2026-11-04" })).toBeUndefined();
      expect(resolveModelReferencePrice(registry, `moonshot-kimi-${market}`, model, { ...options, variant: "fast" })).toBeUndefined();
      expect(resolveModelReferencePrice(registry, "moonshot-kimi-code", model.replace("kimi-", ""), options)).toBeUndefined();
    },
  );
});

describe("verified September reference-price coverage", () => {
  it("resolves the existing Muse 1.2 route to its official tariff", () => {
    expect(
      resolveModelReferencePrice(registry, "xd", "meta/muse-spark-1.2", {
        at,
        officialOnly: true,
      })?.price,
    ).toMatchObject({
      currency: "USD",
      inputPerMtok: 1.25,
      outputPerMtok: 4.25,
      cacheReadPerMtok: 0.15,
    });
  });

  it.each([
    ["moonshot-kimi-cn", "kimi-k3", "CNY", 20],
    ["moonshot-kimi-global", "kimi-k3", "USD", 3],
    ["xd", "moonshot/kimi-k3", "USD", 3],
    ["xd", "moonshotai/kimi-k3", "USD", 3],
  ] as const)(
    "resolves %s/%s cache writes without rewriting history",
    (provider, model, currency, write) => {
      const price = resolveModelReferencePrice(registry, provider, model, {
        at,
      })?.price;
      expect(price).toMatchObject({ currency, cacheWritePerMtok: write });
      expect(price?.cacheWrite1hPerMtok).toBeUndefined();
      expect(
        resolveModelReferencePrice(registry, provider, model, {
          at: "2026-09-22",
        })?.price.cacheWritePerMtok,
      ).toBeUndefined();
    },
  );

  it("selects the verified HY4 market without substituting dollars", () => {
    expect(
      resolveBaseModelReferencePrice(registry, "tencent/hy4-preview", { at })
        ?.price,
    ).toMatchObject({
      currency: "CNY",
      inputPerMtok: 6,
      outputPerMtok: 18,
      cacheReadPerMtok: 0.3,
    });
    expect(
      resolveModelReferencePrice(registry, "xd", "tencent/hy4-preview", {
        at,
        currency: "USD",
      }),
    ).toBeUndefined();
  });

  it("keeps price-only models independent of provider membership", () => {
    expect(
      resolveBaseModelReferencePrice(registry, "muse-spark-1.3", { at })?.price,
    ).toMatchObject({
      inputPerMtok: 1.25,
      outputPerMtok: 4.25,
      cacheReadPerMtok: 0.15,
    });
    expect(
      registry?.models.some((m) => m.modelRef === "meta/muse-spark-1.3"),
    ).toBe(false);
    expect(
      registry?.models.some((m) => m.modelRef === "google/gemini-3.8-flash"),
    ).toBe(false);
  });

  it("switches Gemini's promotional price at the published date", () => {
    expect(
      resolveBaseModelReferencePrice(registry, "gemini-3.8-flash", {
        at: "2026-12-31",
      })?.price,
    ).toMatchObject({
      inputPerMtok: 0.75,
      outputPerMtok: 3.75,
      cacheReadPerMtok: 0.075,
    });
    expect(
      resolveBaseModelReferencePrice(registry, "gemini-3.8-flash", {
        at: "2027-01-01",
      })?.price,
    ).toMatchObject({
      inputPerMtok: 1.5,
      outputPerMtok: 7.5,
      cacheReadPerMtok: 0.15,
    });
  });

  it("does not present the K2.8 reseller estimate as a manufacturer tariff", () => {
    expect(
      resolveBaseModelReferencePrice(registry, "moonshotai/kimi-k2.8-preview", {
        at,
      }),
    ).toBeUndefined();
    expect(
      resolveModelReferencePrice(
        registry,
        "moonshot-kimi-code",
        "kimi-for-coding",
        { at, officialOnly: true },
      ),
    ).toBeUndefined();
  });
});

describe("Sonnet 5.5 adopted official reference price", () => {
  it("resolves the direct route without inventing a price before adoption", () => {
    const options = { at: "2026-11-05", officialOnly: true };
    const expected = {
      currency: "USD", variant: "standard", inputPerMtok: 2, outputPerMtok: 10,
      cacheReadPerMtok: 0.1, cacheWritePerMtok: 2.5, cacheWrite1hPerMtok: 4,
    };
    expect(resolveModelReferencePrice(registry, "anthropic", "claude-sonnet-5-5", options)?.price).toMatchObject(expected);
    expect(resolveBaseModelReferencePrice(registry, "claude-sonnet-5-5", options)?.price).toMatchObject(expected);
    expect(resolveModelReferencePrice(registry, "anthropic", "claude-sonnet-5-5", { at: "2026-11-04", officialOnly: true })).toBeUndefined();
    expect(resolveModelReferencePrice(registry, "anthropic", "claude-sonnet-5-5", { ...options, variant: "fast" })).toBeUndefined();
  });
});

// Unit: explicit Batch lookup must preserve official cache prices, unknown fields,
// adoption history and 200K boundaries. Existing tests did not cover these PDF SKUs.
describe("Anthropic Batch reference prices vendor-effective 2026-10-22 and adopted 2026-11-06", () => {
  it.each([
  ["claude-opus-5-5", 2, 10, 0.1, 2.5, 4, undefined],
  ["claude-fable-5-1", 5, 25, 0.125, 6.25, 10, undefined],
  ["claude-fable-5", 5, 25, 0.5, 6.25, 10, undefined],
  ["claude-mythos-5", 5, 25, 0.5, 6.25, 10, undefined],
  ["claude-opus-5", 2.5, 12.5, 0.25, 3.125, 5, undefined],
  ["claude-opus-4-8", 2.5, 12.5, 0.25, 3.125, 5, undefined],
  ["claude-opus-4-7", 2.5, 12.5, 0.25, 3.125, 5, undefined],
  ["claude-opus-4-6", 2.5, 12.5, 0.25, 3.125, 5, undefined],
  ["claude-opus-4-5", 2.5, 12.5, 0.25, 3.125, 5, 200001],
  ["claude-sonnet-5", 1, 5, 0.1, 1.25, 2, undefined],
  ["claude-sonnet-4-6", 1.5, 7.5, 0.15, 1.875, 3, undefined],
  ["claude-sonnet-4-5", 1.5, 7.5, undefined, undefined, undefined, 200001],
  ["claude-haiku-4-5", 0.5, 2.5, 0.05, 0.625, 1, 200001],
  ] as const)("resolves %s Batch at its evidence-backed effective date while preserving standard", (id, input, output, read, write, oneHour, maximum) => {
    const options = { at: "2026-11-06", variant: "batch" as const, currency: "USD" as const };
    const direct = resolveModelReferencePrice(registry, "anthropic", id, options)?.price;
    expect(direct).toEqual({
      currency: "USD", variant: "batch", inputPerMtok: input, outputPerMtok: output,
      ...(read !== undefined ? { cacheReadPerMtok: read, cacheWritePerMtok: write, cacheWrite1hPerMtok: oneHour } : {}),
      ...(maximum !== undefined ? { maxInputTokens: maximum } : {}),
      effectiveFrom: id === "claude-sonnet-4-5" ? "2026-11-06" : "2026-10-22",
      source: { kind: "provider-official", url: id === "claude-sonnet-4-5"
        ? "https://platform.claude.com/docs/en/about-claude/pricing"
        : "https://assets.claude.com/5633dc848caa431115468f31c7085d695bbfb9cc.pdf", verifiedAt: "2026-11-06" },
    });
    expect(resolveBaseModelReferencePrice(registry, id, { ...options, priceGroup: "global" })?.price).toEqual(direct);
    expect(resolveModelReferencePrice(registry, "anthropic", id, { ...options, at: "2026-10-21" })).toBeUndefined();
    if (id === "claude-sonnet-4-5") {
      expect(resolveModelReferencePrice(registry, "anthropic", id, { ...options, at: "2026-11-05" })).toBeUndefined();
    } else {
      expect(resolveModelReferencePrice(registry, "anthropic", id, { ...options, at: "2026-10-22" })?.price).toEqual(direct);
      expect(resolveModelReferencePrice(registry, "anthropic", id, { ...options, at: "2026-11-05" })?.price).toEqual(direct);
    }
    expect(resolveModelReferencePrice(registry, "anthropic", id, { ...options, currency: "CNY" })).toBeUndefined();
    expect(resolveBaseModelReferencePrice(registry, id, { ...options, priceGroup: "cn" })).toBeUndefined();
    expect(resolveModelReferencePrice(registry, "anthropic", id, { at: "2026-11-06" })?.price.variant).toBe("standard");
    if (maximum !== undefined) {
      expect(resolveModelReferencePrice(registry, "anthropic", id, { ...options, inputTokens: 200000 })?.price).toEqual(direct);
      expect(resolveModelReferencePrice(registry, "anthropic", id, { ...options, inputTokens: 200001 })).toBeUndefined();
    }
  });
});
