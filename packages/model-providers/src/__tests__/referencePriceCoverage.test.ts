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
