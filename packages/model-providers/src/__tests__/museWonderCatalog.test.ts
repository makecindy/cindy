import { describe, expect, it } from "vitest";
import { BUNDLED_CATALOG } from "../builtin.js";
import {
  findModelRegistryRoute,
  resolveBaseModelReferencePrice,
  resolveModelNativeApi,
  resolveModelReferencePrice,
} from "../modelRegistry.js";

const registry = BUNDLED_CATALOG.modelRegistry;

// Meta Model API docs (models / reasoning / pricing-rate-limits), checked 2026-10-13.
describe("Muse Wonder catalog entry", () => {
  it("routes the XD gateway ID through Claude Code and Codex with public specs", () => {
    for (const agent of ["claude-code", "codex"] as const) {
      const matched = findModelRegistryRoute(
        registry,
        "xd",
        "meta/muse-wonder-1.0",
        agent,
      );
      expect(matched?.entry).toMatchObject({
        id: "xd/meta-muse-wonder-1.0",
        name: "Muse Wonder",
        nativeApi: "openai-responses",
        contextWindow: 1048576,
        supportsImageInput: true,
        efforts: ["minimal", "low", "medium", "high", "xhigh", "max"],
        // Meta leaves the omitted effort to the model; Cindy uses its medium-first fallback.
        defaultEffort: "medium",
      });
      // Meta does not publish an output cap.
      expect(matched?.entry.maxOutputTokens).toBeUndefined();
    }
    expect(
      resolveModelNativeApi(registry, "xd", "meta/muse-wonder-1.0"),
    ).toBe("openai-responses");
  });

  it("uses the official standard tariff from the launch date", () => {
    const at = "2026-10-13";
    for (const resolved of [
      resolveModelReferencePrice(registry, "xd", "meta/muse-wonder-1.0", {
        at,
        officialOnly: true,
      }),
      resolveBaseModelReferencePrice(registry, "muse-wonder-1.0", { at }),
    ]) {
      expect(resolved?.price).toMatchObject({
        currency: "USD",
        variant: "standard",
        inputPerMtok: 4,
        outputPerMtok: 20,
        cacheReadPerMtok: 0.2,
      });
      expect(resolved?.price.cacheWritePerMtok).toBeUndefined();
    }
    expect(
      resolveBaseModelReferencePrice(registry, "muse-wonder-1.0", {
        at: "2026-10-11",
      }),
    ).toBeUndefined();
  });

  it("does not invent an API entry for the Muse Code-only Full variant", () => {
    const ids = [
      ...(registry?.baseModels ?? []).flatMap((m) => [m.id, ...(m.aliases ?? [])]),
      ...(registry?.models ?? []).flatMap((m) => [
        m.id,
        ...m.routes.map((r) => r.modelId),
      ]),
    ];
    expect(ids.filter((id) => id.includes("muse-wonder-full"))).toEqual([]);
  });
});
