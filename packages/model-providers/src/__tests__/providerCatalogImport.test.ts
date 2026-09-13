import { describe, expect, it } from "vitest";
import { toCindyCatalog } from "../../../../tools/pi/catalog-format.mjs";
import { readBundledCatalog } from "../../../../tools/pi/read-bundled-catalog.mjs";

const model = {
  id: "new-model",
  provider: "new-vendor",
  api: "openai-completions",
  baseUrl: "https://example.test/v1",
  contextWindow: 10000,
  maxTokens: 4000,
  input: ["text", "image"],
  reasoning: true,
  thinkingLevelMap: { off: null, minimal: null, low: null, medium: null, high: "high", xhigh: null, max: null },
  cost: { input: 0, output: -1 },
  compat: { supportsStore: false },
};
const shard = (value: string) =>
  `// ../ai/src/providers/data/new-vendor.json\nvar vendor_default = ${value};\nstartApplication();`;

describe("Pi source import", () => {
  it('does not turn the bundled manifest into a provider to refresh', () => {
    const manifest = '// ../ai/src/providers/data/.manifest.json\nvar manifest_default = { "providers": {} };\n';
    const providers = readBundledCatalog(manifest + shard(JSON.stringify({ 'openai-completions': { 'new-model': model } })));
    expect(Object.keys(providers)).toEqual(['new-vendor']);
  });
  it("reads only generated literal shards and converts all providers deterministically", () => {
    const providers = readBundledCatalog(
      shard(JSON.stringify({ "openai-completions": { "new-model": model } })),
    );
    const result = toCindyCatalog(providers, "2026-09-12T00:00:00Z");
    expect(result.providers["new-vendor"]).toMatchObject([
      {
        id: "new-model",
        supportsImageInput: true,
        contextWindow: 10000,
        maxOutput: 4000,
        efforts: ["high"],
        cost: { input: 0 },
        execution: {
          pi: {
            api: "openai-completions",
            thinkingLevelMap: { off: null },
            compat: { supportsStore: false },
          },
        },
      },
    ]);
    expect(result.providers["new-vendor"][0].cost).not.toHaveProperty("output");
    expect(toCindyCatalog(providers, result.generatedAt)).toEqual(result);
  });
  it("rejects executable expressions and incomplete input without executing application code", () => {
    expect(() =>
      readBundledCatalog(shard("{ data: process.exit(1) }")),
    ).toThrow("non-literal");
    expect(() => readBundledCatalog(shard("{"))).toThrow("Incomplete");
    expect(() => readBundledCatalog("startApplication()")).toThrow(
      "No generated",
    );
  });
  it("does not copy credentials into the public catalog", () => {
    expect(() =>
      toCindyCatalog(
        { vendor: [{ ...model, baseUrl: "https://user:secret@example.test" }] },
        "now",
      ),
    ).toThrow("Credential-bearing");
    const row = toCindyCatalog(
      {
        vendor: [
          {
            ...model,
            headers: { Authorization: "secret", "NVCF-POLL-SECONDS": "3600" },
          },
        ],
      },
      "now",
    ).providers.vendor[0];
    expect(row.execution.pi.headers).toEqual({ "NVCF-POLL-SECONDS": "3600" });
  });
});
