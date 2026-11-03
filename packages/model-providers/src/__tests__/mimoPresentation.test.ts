import { describe, expect, it } from "vitest";
import { BUNDLED_CATALOG, presetDisplayName } from "../catalog.js";
import { buildUserProvider } from "../user-provider.js";
import { isMimoTokenPlanPreset } from "../mimoPresentation.js";
import type { CustomProviderConfig } from "../types.js";

const config = (baseUrl: string): CustomProviderConfig => ({
  id: "my-account",
  name: "Personal models",
  runtimes: {
    codex: {
      baseUrl,
      wireProtocol: "openai-chat",
      models: [{ id: "mimo-v2.5", name: "MiMo" }],
    },
  },
});

describe("MiMo subscription presentation", () => {
  it.each(["cn", "ams", "sgp"])(
    "recognizes existing and renamed %s connections without changing auth or routing",
    (region) => {
      const baseUrl = `https://token-plan-${region}.xiaomimimo.com/v1`;
      const provider = buildUserProvider(config(baseUrl));
      expect(provider.access).toEqual({
        kind: "subscription",
        product: "MiMo Token Plan",
      });
      expect(provider.name).toBe("Personal models");
      expect(provider.id).toBe("my-account");
      expect(provider.auth).toEqual({ method: "apiKey" });
      expect(provider.routing.codex?.upstream).toBe(baseUrl);
      expect(provider.routing.codex?.authStrategy).toBe("api-key-header");
    },
  );

  it.each([
    "https://api.xiaomimimo.com/v1",
    "https://proxy.example/v1",
    "https://token-plan-cn.xiaomimimo.com.example.org/v1",
    "https://token-plan-cn.xiaomimimo.com@evil.example/v1",
    "http://token-plan-cn.xiaomimimo.com/v1",
    "https://token-plan-cn.xiaomimimo.com:8080/v1",
  ])("keeps %s as an API even with a subscription-looking name", (baseUrl) => {
    expect(
      buildUserProvider({ ...config(baseUrl), name: "MiMo Token Plan" }).access,
    ).toEqual({ kind: "api" });
  });

  it("does not label mixed runtime/model endpoints or unauthenticated connections as subscriptions", () => {
    const input = config("https://token-plan-cn.xiaomimimo.com/v1");
    expect(
      buildUserProvider({ ...input, auth: { method: "none" } }).access,
    ).toEqual({ kind: "api" });
    input.runtimes.pi = {
      baseUrl: "https://api.xiaomimimo.com/v1",
      models: [],
    };
    expect(buildUserProvider(input).access).toEqual({ kind: "api" });
    delete input.runtimes.pi;
    input.runtimes.codex!.models[0].route = {
      baseUrl: "https://api.xiaomimimo.com/v1",
      wireProtocol: "openai-chat",
    };
    expect(buildUserProvider(input).access).toEqual({ kind: "api" });
  });

  it("recognizes shipped Token Plan presets and localizes their names even with old catalog labels", () => {
    for (const id of [
      "xiaomi-mimo-token-plan-cn",
      "xiaomi-token-plan-ams",
      "xiaomi-token-plan-sgp",
    ]) {
      const preset = BUNDLED_CATALOG.presets!.find((p) => p.id === id)!;
      expect(isMimoTokenPlanPreset(preset), id).toBe(true);
      expect(presetDisplayName(preset, "zh-CN")).toMatch(
        /^小米 MiMo Token Plan/,
      );
      expect(presetDisplayName(preset, "en")).toMatch(
        /^Xiaomi MiMo Token Plan/,
      );
    }
    expect(
      isMimoTokenPlanPreset(
        BUNDLED_CATALOG.presets!.find((p) => p.id === "xiaomi-mimo-api-cn")!,
      ),
    ).toBe(false);
    expect(isMimoTokenPlanPreset({ runtimes: {} })).toBe(false);
    expect(
      presetDisplayName(
        { id: "xiaomi-token-plan-sgp", name: "MiMo Token Plan (Singapore)" },
        "zh-CN",
      ),
    ).toBe("小米 MiMo Token Plan (新加坡)");
    expect(
      presetDisplayName({ id: "xiaomi-mimo-api-cn", name: "old" }, "en"),
    ).toBe("Xiaomi MiMo API");
  });
});
