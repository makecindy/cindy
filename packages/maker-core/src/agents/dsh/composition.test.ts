import { describe, expect, it } from "vitest";

import { buildDshCordisConfig, renderDshCordisYaml } from "./composition.js";

describe("DSH Cordis composition", () => {
  it("quotes scoped package names so the generated YAML can load the DeepSeek plugin graph", () => {
    const yaml = renderDshCordisYaml(
      buildDshCordisConfig({
        provider: "deepseek-official",
        model: "deepseek-v4-pro",
        apiKeyEnv: "DEEPSEEK_API_KEY",
        cwd: "C:/test-workdir",
        sessionRoot: "C:/test-sessions",
        bashLocal: false,
      }),
    );

    expect(yaml).toContain('name: "@deepseek-ai/dsh-llm-deepseek"');
    expect(yaml).toContain('name: "./cindy-dsh-bridge.mjs"');
  });

  it("carries the configured endpoint, context window, and reasoning default into the DeepSeek adapter", () => {
    const yaml = renderDshCordisYaml(
      buildDshCordisConfig({
        provider: "deepseek-official",
        model: "vendor-pro",
        apiKeyEnv: "DEEPSEEK_API_KEY",
        cwd: "C:/test-workdir",
        sessionRoot: "C:/test-sessions",
        baseUrl: "https://gateway.example.test/deepseek",
        reasoningEffort: "low",
        models: [
          {
            id: "vendor-pro",
            name: "Vendor Pro",
            contextWindow: 640_000,
            maxTokens: 16_000,
          },
        ],
      }),
    );

    expect(yaml).toContain('baseURL: "https://gateway.example.test/deepseek"');
    expect(yaml).toContain('thinking: "enabled"');
    expect(yaml).toContain('reasoningEffort: "low"');
    expect(yaml).toContain('contextWindow: 640000');
    expect(yaml).toContain('maxTokens: 16000');
  });

  it("turns thinking off only when the configured DSH effort is off", () => {
    const yaml = renderDshCordisYaml(
      buildDshCordisConfig({
        provider: "deepseek-official",
        model: "vendor-flash",
        apiKeyEnv: "DEEPSEEK_API_KEY",
        cwd: "C:/test-workdir",
        sessionRoot: "C:/test-sessions",
        reasoningEffort: "off",
      }),
    );

    expect(yaml).toContain('thinking: "disabled"');
    expect(yaml).toContain('reasoningEffort: "off"');
  });

  it.each([
    ["always-on", "enabled"],
    ["always-off", "disabled"],
  ] as const)("renders fixed %s thinking without an unsupported effort field", (policy, thinking) => {
    const yaml = renderDshCordisYaml(
      buildDshCordisConfig({
        provider: "deepseek-official",
        model: "fixed-thinking-model",
        apiKeyEnv: "DEEPSEEK_API_KEY",
        cwd: "C:/test-workdir",
        sessionRoot: "C:/test-sessions",
        thinkingPolicy: policy,
        reasoningEffort: "high",
      }),
    );

    expect(yaml).toContain(`thinking: "${thinking}"`);
    expect(yaml).not.toContain("reasoningEffort:");
  });
});
