import { describe, expect, it } from "vitest";
import { BUNDLED_CATALOG } from "../builtin.js";
import {
  resolveBaseModelReferencePrice,
  resolveModelNativeApi,
} from "../modelRegistry.js";

const registry = BUNDLED_CATALOG.modelRegistry;

// Gemini API docs (models/gemini-4-argon, thinking, pricing), checked 2026-10-14.
describe("Gemini 4 Argon catalog entry", () => {
  const base = registry?.baseModels?.find(
    (m) => m.id === "google/gemini-4-argon",
  );

  it("publishes the official specs on the public model", () => {
    expect(base?.aliases).toEqual(["gemini-4-argon"]);
    expect(base?.defaults).toMatchObject({
      name: "Gemini 4 Argon",
      group: "google",
      contextWindow: 1048576,
      // 1,048,576 output needs long decode; the catalog keeps the default synchronous cap.
      maxOutputTokens: 65536,
      supportsImageInput: true,
      modalities: { input: ["text", "image"], output: ["text"] },
      // Google documents thinking_level only: no minimal, no off.
      efforts: ["low", "medium", "high"],
      defaultEffort: "medium",
    });
  });

  it("uses the published Gateway transport without inventing model availability", () => {
    expect(
      registry?.models.some((m) => m.modelRef === "google/gemini-4-argon"),
    ).toBe(false);
    for (const id of ["google/gemini-4-argon", "gemini-4-argon"])
      expect(resolveModelNativeApi(registry, "xd", id), id).toBe(
        "openai-responses",
      );
    // The Server's Argon compatibility rule is narrower than the Gemini family.
    expect(resolveModelNativeApi(registry, "xd", "google/gemini-3.8-flash")).toBe(
      "google-generative-ai",
    );
  });

  it("switches from the launch price to the published 2026-12-01 price", () => {
    const priceAt = (at: string) =>
      resolveBaseModelReferencePrice(registry, "gemini-4-argon", { at })?.price;
    expect(priceAt("2026-10-12")).toBeUndefined();
    for (const at of ["2026-10-13", "2026-11-30"])
      expect(priceAt(at), at).toMatchObject({
        currency: "USD",
        variant: "standard",
        inputPerMtok: 2,
        outputPerMtok: 10,
        cacheReadPerMtok: 0.1,
      });
    for (const at of ["2026-12-01", "2027-06-01"])
      expect(priceAt(at), at).toMatchObject({
        currency: "USD",
        variant: "standard",
        inputPerMtok: 4,
        outputPerMtok: 20,
        cacheReadPerMtok: 0.2,
      });
    // Implicit caching only: Google publishes no cache-write price.
    expect(priceAt("2026-10-14")?.cacheWritePerMtok).toBeUndefined();
  });
});
