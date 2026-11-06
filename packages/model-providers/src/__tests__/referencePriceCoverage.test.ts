import { describe, expect, it } from "vitest";
import { BUNDLED_CATALOG } from "../builtin.js";
import {
  resolveBaseModelReferencePrice,
  resolveModelReferencePrice,
} from "../modelRegistry.js";

const registry = BUNDLED_CATALOG.modelRegistry;
const at = "2026-09-23";

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
