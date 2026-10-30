import { describe, expect, it } from "vitest";
import { parseModelRegistry } from "../modelAccessValidator.js";
import { referencePricesForRoute } from "../modelMetadataLayers.js";
import type { ModelRegistry } from "../modelAccessBean.js";

export function pricedRegistry(): ModelRegistry {
  return {
    schemaVersion: 5,
    updatedAt: "2026-09-11T00:00:00.000Z",
    baseModels: [
      {
        id: "maker/model",
        aliases: ["model"],
        defaults: {},
        referencePriceGroups: [
          {
            id: "global",
            prices: [
              {
                currency: "USD",
                variant: "standard",
                inputPerMtok: 2,
                outputPerMtok: 10,
                cacheWritePerMtok: 2.5,
                effectiveFrom: "2026-09-01",
                source: {
                  kind: "provider-official",
                  url: "https://example.test/prices",
                  verifiedAt: "2026-09-01",
                },
              },
            ],
          },
        ],
      },
    ],
    models: [
      {
        id: "entry",
        name: "Model",
        modelRef: "maker/model",
        routes: [
          {
            providerId: "supplier",
            modelId: "wire-model",
            agents: ["codex"],
            referencePriceGroup: "global",
          },
        ],
      },
    ],
  };
}

describe("V5 model reference tariffs", () => {
  it("validates public tariffs independently of supplier membership", () => {
    const r = pricedRegistry();
    expect(parseModelRegistry(r).ok).toBe(true);
    r.models = [];
    expect(parseModelRegistry(r).ok).toBe(true);
    r.baseModels![0].referencePriceGroups![0].prices[0].cacheWritePerMtok = -1;
    expect(parseModelRegistry(r).ok).toBe(false);
  });
  it("rejects unsupported fields in older versions and dangling group references", () => {
    const r = pricedRegistry();
    expect(parseModelRegistry({ ...r, schemaVersion: 4 }).ok).toBe(false);
    r.models[0].routes[0].referencePriceGroup = "missing";
    expect(parseModelRegistry(r).ok).toBe(false);
    delete r.models[0].routes[0].referencePriceGroup;
    expect(parseModelRegistry(r).ok).toBe(true);
  });
  it("rejects duplicate groups, overlapping tariffs and misspelled fields", () => {
    for (const kind of ["duplicate", "overlap", "unknown"] as const) {
      const r = pricedRegistry();
      const groups = r.baseModels![0].referencePriceGroups!;
      if (kind === "duplicate") groups.push(structuredClone(groups[0]));
      if (kind === "overlap")
        groups[0].prices.push(structuredClone(groups[0].prices[0]));
      if (kind === "unknown") Object.assign(groups[0], { typo: true });
      expect(parseModelRegistry(r).ok, kind).toBe(false);
    }
  });
  it("keeps supplier and manufacturer prices separate without filling missing cache rates", () => {
    const r = pricedRegistry(),
      entry = r.models[0],
      route = entry.routes[0];
    const official = referencePricesForRoute(r, entry, route)!;
    route.referencePrices = [{ ...official[0], inputPerMtok: 9 }];
    delete route.referencePrices[0].cacheWritePerMtok;
    expect(referencePricesForRoute(r, entry, route)?.[0].inputPerMtok).toBe(9);
    expect(
      referencePricesForRoute(r, entry, route)?.[0].cacheWritePerMtok,
    ).toBeUndefined();
    expect(referencePricesForRoute(r, entry, route, true)).toEqual(official);
    route.referencePrices = [];
    expect(referencePricesForRoute(r, entry, route)).toEqual([]);
    expect(referencePricesForRoute(r, entry, route, true)).toEqual(official);
    delete route.referencePriceGroup;
    expect(referencePricesForRoute(r, entry, route, true)).toBeUndefined();
  });
});

import {
  resolveBaseModelReferencePrice,
  resolveModelReferencePrice,
} from "../modelRegistry.js";
import { BUNDLED_CATALOG } from "../builtin.js";

it("selects by public identity, market, currency, historical date and input band", () => {
  const r = structuredClone(BUNDLED_CATALOG.modelRegistry!);
  r.models = [];
  const options = { at: "2026-09-11" };
  expect(
    resolveBaseModelReferencePrice(r, "gpt-5.6-luna", options)?.price,
  ).toMatchObject({ inputPerMtok: 0.2, cacheWritePerMtok: 0.25 });
  expect(
    resolveBaseModelReferencePrice(r, "openai/gpt-5.6-luna", {
      ...options,
      variant: "fast",
      inputTokens: 272001,
    })?.price,
  ).toMatchObject({ inputPerMtok: 0.8, cacheWritePerMtok: 1 });
  expect(
    resolveBaseModelReferencePrice(r, "openai/gpt-5.6-luna", {
      at: "2026-07-29",
    })?.price.inputPerMtok,
  ).toBe(1);
  expect(
    resolveBaseModelReferencePrice(r, "minimax/minimax-m2.7", options),
  ).toBeUndefined();
  expect(
    resolveBaseModelReferencePrice(r, "minimax/minimax-m2.7", {
      ...options,
      priceGroup: "cn",
    })?.price.currency,
  ).toBe("CNY");
  expect(
    resolveBaseModelReferencePrice(r, "minimax/minimax-m2.7", {
      ...options,
      currency: "USD",
    })?.price.inputPerMtok,
  ).toBe(0.3);
  expect(resolveBaseModelReferencePrice(r, "unknown", options)).toBeUndefined();
  expect(
    resolveBaseModelReferencePrice(r, "openai/gpt-5.6-cyber", {
      ...options,
      inputTokens: 272001,
    }),
  ).toBeUndefined();
});
it("does not select arbitrarily between markets with the same currency", () => {
  const r = pricedRegistry();
  const groups = r.baseModels![0].referencePriceGroups!;
  groups.push({ ...groups[0], id: "other-market" });
  expect(
    resolveBaseModelReferencePrice(r, "model", { currency: "USD" }),
  ).toBeUndefined();
  expect(
    resolveBaseModelReferencePrice(r, "model", { priceGroup: "global" })?.price
      .inputPerMtok,
  ).toBe(2);
});
it("uses route identity to find official pricing while preserving legacy catalogs", () => {
  const r = pricedRegistry(),
    route = r.models[0].routes[0];
  route.referencePrices = [
    { ...r.baseModels![0].referencePriceGroups![0].prices[0], inputPerMtok: 8 },
  ];
  expect(
    resolveModelReferencePrice(r, "supplier", "wire-model")?.price.inputPerMtok,
  ).toBe(8);
  expect(
    resolveModelReferencePrice(r, "supplier", "wire-model", {
      officialOnly: true,
    })?.price.inputPerMtok,
  ).toBe(2);
  expect(
    resolveModelReferencePrice(
      { ...r, schemaVersion: 4 },
      "supplier",
      "wire-model",
      { officialOnly: true },
    )?.price.inputPerMtok,
  ).toBe(8);
});
