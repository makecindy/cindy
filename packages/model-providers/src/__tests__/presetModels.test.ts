import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { BUNDLED_CATALOG, sanitizePresets } from "../catalog.js";
import { expandPresetModels } from "../presetModels.js";

const rawPresets = (
  JSON.parse(
    readFileSync(
      new URL("../../catalog/providers.json", import.meta.url),
      "utf8",
    ),
  ) as { presets: Record<string, unknown>[] }
).presets;

describe("预设推荐模型单一清单", () => {
  it("随包预设只在顶层写一份清单，不再按引擎各写一份", () => {
    const perEngine = rawPresets.filter((preset) =>
      Object.values(
        preset.runtimes as Record<string, Record<string, unknown>>,
      ).some((runtime) => "models" in runtime),
    );
    expect(perEngine.map((preset) => preset.id)).toEqual([]);
    expect(rawPresets.every((preset) => Array.isArray(preset.models))).toBe(
      true,
    );
  });

  it("按 engines 过滤、按 engineOverrides 覆盖，并保持推荐顺序", () => {
    const expanded = expandPresetModels({
      id: "demo",
      name: "Demo",
      models: [
        { id: "a", name: "A", contextWindow: 1000 },
        { id: "b", name: "B", engines: ["claude-code"] },
        {
          id: "c",
          name: "C",
          engineOverrides: {
            pi: { reasoning: true, reasoningEfforts: ["high"] },
          },
        },
      ],
      runtimes: {
        "claude-code": { baseUrl: "https://example.com/anthropic" },
        pi: { baseUrl: "https://example.com/v1", wireProtocol: "openai-chat" },
      },
    });
    expect(expanded).not.toHaveProperty("models");
    expect(expanded.runtimes["claude-code"]).toEqual({
      baseUrl: "https://example.com/anthropic",
      models: [
        { id: "a", name: "A", contextWindow: 1000 },
        { id: "b", name: "B" },
        { id: "c", name: "C" },
      ],
    });
    expect(
      (expanded.runtimes.pi as unknown as { models: unknown[] }).models,
    ).toEqual([
      { id: "a", name: "A", contextWindow: 1000 },
      { id: "c", name: "C", reasoning: true, reasoningEfforts: ["high"] },
    ]);
  });

  it("旧的按引擎格式（服务端下发）原样可用", () => {
    const legacy = {
      id: "legacy",
      name: "Legacy",
      runtimes: {
        codex: {
          baseUrl: "https://example.com/v1",
          models: [{ id: "x", name: "X" }],
        },
      },
    };
    expect(expandPresetModels(legacy)).toBe(legacy);
    expect(sanitizePresets([legacy])).toHaveLength(1);
  });

  it("engines / engineOverrides 畸形时整条预设被拒绝，不展开到全部引擎", () => {
    const base = {
      id: "bad",
      name: "Bad",
      runtimes: {
        "claude-code": { baseUrl: "https://example.com/anthropic" },
        codex: { baseUrl: "https://example.com/v1" },
      },
    };
    for (const malformed of [
      { engines: "codex" },
      { engines: [1] },
      { engines: [] },
      { engines: ["codxe"] },
      { engineOverrides: [] },
      { engineOverrides: { pi: "x" } },
      { engineOverrides: { codxe: { supportsImageInput: false } } },
    ]) {
      const preset = {
        ...base,
        models: [{ id: "m", name: "M", ...malformed }],
      };
      expect(expandPresetModels(preset)).toBe(preset);
      expect(sanitizePresets([preset])).toEqual([]);
    }
  });

  it("所有随包预设展开后都通过校验", () => {
    expect(sanitizePresets(rawPresets)).toHaveLength(rawPresets.length);
    expect(BUNDLED_CATALOG.presets?.length).toBeGreaterThanOrEqual(
      rawPresets.length,
    );
  });
});
