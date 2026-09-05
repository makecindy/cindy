import { describe, expect, it } from "vitest";
import { BUNDLED_CATALOG, type ModelRegistry } from "../index.js";
import { parseModelRegistry } from "../modelAccessValidator.js";
import { resolveModelNativeApi } from "../modelRegistry.js";

const registry = (): ModelRegistry => ({
  schemaVersion: 3,
  updatedAt: "2026-09-05T00:00:00.000Z",
  models: [],
  nativeApiRules: [
    {
      providerId: "xd",
      modelIdPrefix: "google/gemini-",
      nativeApi: "google-generative-ai",
    },
  ],
});

describe("canonical model APIs in registry v3", () => {
  it("covers every maintained model route without relying on Pi runtime data", () => {
    const bundled = BUNDLED_CATALOG.modelRegistry!;
    for (const entry of bundled.models) {
      if (entry.status === "retired") continue;
      expect(entry.nativeApi, entry.id).toBeTruthy();
      for (const route of entry.routes) {
        expect(
          resolveModelNativeApi(bundled, route.providerId, route.modelId),
          `${route.providerId}/${route.modelId}`,
        ).toBe(entry.nativeApi);
      }
    }
    expect(
      resolveModelNativeApi(bundled, "xd", "bytedance-seed/seed-2.1-pro"),
    ).toBe("openai-completions");
    for (const id of [
      "gpt-5.3-codex-spark",
      "chatgpt/gpt-5.3-codex-spark",
      "gpt-99-new",
    ]) {
      expect(resolveModelNativeApi(bundled, "openai", id)).toBe(
        "openai-responses",
      );
    }
  });

  it("shares canonical metadata across owned subscription wire aliases only", () => {
    for (const id of ["gpt-6-astra", "chatgpt/gpt-6-astra"]) {
      expect(
        resolveModelNativeApi(BUNDLED_CATALOG.modelRegistry, "openai", id),
      ).toBe("openai-responses");
    }
    for (const id of ["grok-4.6", "xai/grok-4.6"]) {
      expect(
        resolveModelNativeApi(BUNDLED_CATALOG.modelRegistry, "xai", id),
      ).toBe("openai-responses");
    }
    expect(
      resolveModelNativeApi(
        BUNDLED_CATALOG.modelRegistry,
        "unrelated",
        "chatgpt/gpt-6-astra",
      ),
    ).toBeUndefined();
  });

  it.each([
    ["deepseek/deepseek-v99-pro", "openai-completions"],
    ["bytedance-seed/seed-99-pro", "openai-completions"],
    ["qwen/qwen99-flash", "openai-completions"],
    ["moonshotai/kimi-k99", "openai-completions"],
    ["z-ai/glm-99", "openai-completions"],
    ["tencent/hy99-preview", "openai-completions"],
    ["meta/muse-spark-99", "openai-responses"],
    ["x-ai/grok-99", "openai-responses"],
    ["minimax/MiniMax-M99", "anthropic-messages"],
  ])(
    "declares the native API of future family member %s locally",
    (id, api) => {
      expect(
        resolveModelNativeApi(BUNDLED_CATALOG.modelRegistry, "xd", id),
      ).toBe(api);
      expect(
        resolveModelNativeApi(BUNDLED_CATALOG.modelRegistry, "unrelated", id),
      ).toBeUndefined();
      expect(
        resolveModelNativeApi(
          BUNDLED_CATALOG.modelRegistry,
          "xd",
          `${id}/other`,
        ),
      ).toBeUndefined();
    },
  );

  it("preserves legacy retirement even when the catalog cannot declare native APIs", () => {
    const r: ModelRegistry = {
      schemaVersion: 2,
      updatedAt: registry().updatedAt,
      models: [
        {
          id: "g",
          name: "G",
          status: "retired",
          routes: [
            {
              providerId: "xd",
              modelId: "google/gemini-99",
              agents: ["codex"],
            },
          ],
        },
      ],
    };
    expect(resolveModelNativeApi(r, "xd", "google/gemini-99")).toBeNull();
  });

  it("validates the complete bundled snapshot and keeps legacy versions readable", () => {
    expect(parseModelRegistry(BUNDLED_CATALOG.modelRegistry).ok).toBe(true);
    for (const schemaVersion of [1, 2])
      expect(
        parseModelRegistry({
          schemaVersion,
          updatedAt: registry().updatedAt,
          models: [],
        }).ok,
      ).toBe(true);
    expect(parseModelRegistry({ ...registry(), schemaVersion: 2 }).ok).toBe(
      false,
    );
    expect(
      parseModelRegistry({
        ...registry(),
        nativeApiRules: [
          {
            providerId: "xd",
            modelIdPrefix: "",
            nativeApi: "google-generative-ai",
          },
        ],
      }).ok,
    ).toBe(false);
    expect(
      parseModelRegistry({
        ...registry(),
        nativeApiRules: [
          ...registry().nativeApiRules!,
          ...registry().nativeApiRules!,
        ],
      }).ok,
    ).toBe(false);
  });
  it("resolves new models by route-scoped rule without inventing other provider identities", () => {
    expect(
      resolveModelNativeApi(registry(), "xd", "google/gemini-99-pro[1m]"),
    ).toBe("google-generative-ai");
    expect(
      resolveModelNativeApi(registry(), "other", "google/gemini-99-pro"),
    ).toBeUndefined();
    expect(
      resolveModelNativeApi(registry(), "xd", "google/gemini-99/other"),
    ).toBeUndefined();
  });
  it("honors an exact correction, explicit unknown, and retirement before family defaults", () => {
    const r = registry();
    r.models = [
      {
        id: "google/new",
        name: "New",
        nativeApi: "openai-responses",
        routes: [
          { providerId: "xd", modelId: "google/gemini-new", agents: ["codex"] },
        ],
      },
    ];
    expect(parseModelRegistry(r).ok).toBe(true);
    expect(resolveModelNativeApi(r, "xd", "google/gemini-new")).toBe(
      "openai-responses",
    );
    r.models[0].nativeApi = null;
    expect(resolveModelNativeApi(r, "xd", "google/gemini-new")).toBeNull();
    delete r.models[0].nativeApi;
    r.models[0].status = "retired";
    expect(resolveModelNativeApi(r, "xd", "google/gemini-new")).toBeNull();
  });
  it("rejects unrecognized protocol values instead of silently using a compatibility route", () => {
    const r = registry();
    expect(
      parseModelRegistry({
        ...r,
        nativeApiRules: [{ ...r.nativeApiRules![0], nativeApi: "future-api" }],
      }).ok,
    ).toBe(false);
    expect(
      parseModelRegistry({
        ...r,
        models: [{ id: "m", name: "M", routes: [], nativeApi: "future-api" }],
      }).ok,
    ).toBe(false);
  });
});
