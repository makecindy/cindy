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


it('retains partial upstream successes and previous rows without manufacturing negative capabilities', () => {
  const previous = toCindyCatalog({ 'new-vendor': [model] }, 'before');
  const errors: unknown[] = [];
  const result = toCindyCatalog({ 'new-vendor': [
    { ...model, id: 'next-model', reasoning: undefined, input: undefined, contextWindow: undefined,
      supportsFastMode: false, supportsToolCalls: true },
    { ...model, api: '' },
  ] }, 'after', { previous, onError: (error: unknown) => errors.push(error) });
  expect(errors).toHaveLength(1);
  expect(result.providers['new-vendor']).toContainEqual(previous.providers['new-vendor'][0]);
  const next = result.providers['new-vendor'].find(row => row.id === 'next-model');
  expect(next).toMatchObject({ supportsFastMode: false, supportsToolCalls: true });
  for (const key of ['reasoning', 'efforts', 'defaultEffort', 'contextWindow', 'supportsImageInput'])
    expect(next).not.toHaveProperty(key);
});


it('preserves an explicit unspecified default effort', () => {
  expect(toCindyCatalog({ 'new-vendor': [{ ...model, defaultEffort: null }] }, 'now')
    .providers['new-vendor'][0]).toMatchObject({ efforts: ['high'], defaultEffort: null });
});

it('removes retired models only after a complete successful provider snapshot', () => {
  const previous = toCindyCatalog({ 'new-vendor': [model, { ...model, id: 'retired-model' }] }, 'before');
  const next = toCindyCatalog({ 'new-vendor': [model] }, 'after', { previous });
  expect(next.providers['new-vendor'].map(row => row.id)).toEqual([model.id]);
  expect(toCindyCatalog({ 'new-vendor': [] }, 'empty', { previous }).providers['new-vendor']).toEqual([]);
  expect(toCindyCatalog({ 'new-vendor': [] }, 'incomplete', { previous, incompleteProviders: ['new-vendor'] })
    .providers['new-vendor']).toEqual(previous.providers['new-vendor']);
});

it('retains missing adapter fields on the same connection and accepts explicit replacements', () => {
  const previous = toCindyCatalog({ 'new-vendor': [{ ...model, samplingParams: { temperature: 0.2 } }] }, 'before');
  const sparse = { ...model, thinkingLevelMap: undefined, compat: undefined, samplingParams: undefined };
  const kept = toCindyCatalog({ 'new-vendor': [sparse] }, 'after', { previous }).providers['new-vendor'][0];
  expect(kept.execution.pi).toEqual(previous.providers['new-vendor'][0].execution.pi);
  expect(kept.efforts).toEqual(['high']);
  const cleared = toCindyCatalog({ 'new-vendor': [{ ...sparse, thinkingLevelMap: {}, compat: {}, samplingParams: {} }] },
    'clear', { previous }).providers['new-vendor'][0];
  expect(cleared.execution.pi).toMatchObject({ thinkingLevelMap: {}, compat: {}, samplingParams: {} });
  for (const change of [{ api: 'anthropic-messages' }, { baseUrl: 'https://other.example/v1' }]) {
    const moved = toCindyCatalog({ 'new-vendor': [{ ...sparse, ...change }] }, 'moved', { previous }).providers['new-vendor'][0];
    expect(moved.execution.pi).not.toHaveProperty('thinkingLevelMap');
    expect(moved.execution.pi).not.toHaveProperty('compat');
  }
});

it.each([
  { api: 'anthropic-messages', baseUrl: model.baseUrl },
  { api: model.api, baseUrl: 'https://other.example/v1' },
  { api: model.api, baseUrl: undefined },
])('does not carry channel metadata across connection changes: %j', (connection) => {
  const previous = toCindyCatalog({ 'new-vendor': [{
    ...model,
    nativeApi: 'openai-responses',
    supportsFastMode: true,
    supportsToolCalls: true,
    reasoningRequired: true,
    samplingParams: { temperature: 0.2 },
    headers: { 'User-Agent': 'old-channel' },
  }] }, 'before');
  const sparse = { id: model.id, provider: model.provider, api: model.api, baseUrl: model.baseUrl };
  const retained = toCindyCatalog({ 'new-vendor': [sparse] }, 'same', { previous }).providers['new-vendor'][0];
  expect(retained).toEqual(previous.providers['new-vendor'][0]);

  const moved = toCindyCatalog({ 'new-vendor': [{ ...sparse, ...connection }] }, 'moved', { previous })
    .providers['new-vendor'];
  // Keep the discovered model usable, without presenting another channel's
  // price, native identity or capabilities as this connection's own metadata.
  expect(moved).toEqual([{
    id: model.id,
    name: model.id,
    upstream: connection.baseUrl ?? '',
    execution: { pi: { api: connection.api } },
  }]);
  const reported = toCindyCatalog({ 'new-vendor': [{ ...sparse, ...connection,
    cost: { input: 5 }, nativeApi: 'anthropic-messages', supportsFastMode: false,
  }] }, 'reported', { previous }).providers['new-vendor'][0];
  expect(reported).toMatchObject({ cost: { input: 5 }, nativeApi: 'anthropic-messages', supportsFastMode: false });
});
