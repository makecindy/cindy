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
  // #10269, unit: regeneration must preserve the verified Carbon transport
  // while reusing Argon's maintained IDE identity, not its unverified capacity.
  it('supplements Copilot Carbon from the same source Chat adapter only', () => {
    const argon = { ...model, id: 'gemini-4-argon', provider: 'github-copilot',
      baseUrl: 'https://api.individual.githubcopilot.com',
      headers: { 'Editor-Version': 'fixture-editor', Authorization: 'invalid-fixture-secret' },
      compat: { supportsStore: false, supportsReasoningEffort: false },
    };
    const before = structuredClone(argon);
    const errors: unknown[] = [];
    // Malformed external JSON bypasses the compile-time PiImportModel contract.
    const source = JSON.parse(JSON.stringify([null, argon]));
    const imported = toCindyCatalog({ 'github-copilot': source }, 'fixture', { onError: error => errors.push(error) });
    expect(errors).toHaveLength(1);
    const carbon = imported.providers['github-copilot'].find(row => row.id === 'gemini-4-carbon');
    expect(carbon).toEqual({ id: 'gemini-4-carbon', name: 'Gemini 4 Carbon', upstream: argon.baseUrl,
      execution: { pi: { api: 'openai-completions', headers: { 'Editor-Version': 'fixture-editor' }, compat: argon.compat } },
    });
    expect(argon).toEqual(before);
    for (const changed of [{ ...argon, baseUrl: 'https://proxy.example' },
      { ...argon, api: 'anthropic-messages' }, { ...argon, provider: 'another-provider' }]) {
      expect(toCindyCatalog({ [changed.provider]: [changed] }, 'fixture').providers[changed.provider])
        .not.toContainEqual(expect.objectContaining({ id: 'gemini-4-carbon' }));
    }
    const explicit = { ...argon, id: 'gemini-4-carbon', api: 'openai-responses', headers: {}, compat: {} };
    const refreshed = toCindyCatalog({ 'github-copilot': [argon, explicit] }, 'fixture', { previous: imported });
    expect(refreshed.providers['github-copilot'].find(row => row.id === explicit.id)?.execution.pi)
      .toMatchObject({ api: 'openai-responses', headers: {}, compat: {} });
  });

  // #9863: the pinned source labels Copilot Astra as Chat; regeneration must retain
  // its Responses contract. Existing import cases only cover generic conversion.
  it('corrects only the exact Copilot Astra Chat source during import', () => {
    const astra = { id: 'gpt-6-astra', provider: 'github-copilot',
      baseUrl: 'https://api.individual.githubcopilot.com', api: 'openai-completions' };
    const inputs = [astra,
      { ...astra, id: 'kimi-k3' },
      { ...astra, provider: 'another-provider' },
      { ...astra, baseUrl: 'https://proxy.example/v1' },
      { ...astra, baseUrl: `${astra.baseUrl}/custom` },
      { ...astra, api: 'openai-responses' },
      { ...astra, api: 'anthropic-messages' },
    ];
    for (const [index, input] of inputs.entries()) {
      const before = structuredClone(input);
      const first = toCindyCatalog({ [input.provider]: [input] }, 'fixture');
      expect(first.providers[input.provider][0].execution.pi.api).toBe(index === 0 ? 'openai-responses' : input.api);
      expect(toCindyCatalog({ [input.provider]: [input] }, 'fixture')).toEqual(first);
      expect(input).toEqual(before);
    }
    const previous = toCindyCatalog({ 'github-copilot': [{ ...astra,
      headers: { 'Copilot-Integration-Id': 'vscode-chat' }, compat: { supportsStore: false },
    }] }, 'before');
    const refreshed = toCindyCatalog({ 'github-copilot': [astra] }, 'after', { previous });
    expect(refreshed.providers['github-copilot']).toEqual(previous.providers['github-copilot']);
  });

  // #9863 review: changing only api leaves Chat adapter flags and unsupported
  // reasoning levels. Verify the generated Responses contract, not only its name.
  it('replaces Copilot Astra Chat adapter metadata when correcting its API', () => {
    const stale = { id: 'gpt-6-astra', provider: 'github-copilot',
      baseUrl: 'https://api.individual.githubcopilot.com', api: 'openai-completions', reasoning: true,
      thinkingLevelMap: { xhigh: 'xhigh', max: 'max' },
      compat: { supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: false },
    };
    const before = structuredClone(stale);
    const catalog = toCindyCatalog({ 'github-copilot': [stale] }, 'fixture');
    const corrected = catalog.providers['github-copilot'][0];
    expect(corrected.efforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(corrected.execution.pi).toEqual({
      api: 'openai-responses',
      thinkingLevelMap: { off: null, minimal: null, low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' },
      compat: { supportsOpenAIGrammarTools: true },
    });
    expect(toCindyCatalog({ 'github-copilot': [stale] }, 'fixture', { previous: catalog })).toEqual(catalog);
    expect(stale).toEqual(before);
  });

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
  // Pi 1.x wraps each shard in a lazy `__esm` initializer and mixes image/classifier rows into
  // the same shard; the 0.x-only marker found no shards, so `--pi-bundle` could not import 1.x.
  it("reads Pi 1.x lazy shards and keeps only chat models", () => {
    const value = JSON.stringify({
      "openai-completions": {
        "chat:new-model": { ...model, type: "chat" },
        "image:new-image": { ...model, id: "new-image", type: "image" },
      },
    });
    const lazyShard = `// ../ai/src/providers/data/new-vendor.json\nvar vendor_default;\nvar init_vendor = __esm(() => {\n  vendor_default = ${value};\n});\nstartApplication();`;
    expect(readBundledCatalog(lazyShard)["new-vendor"].map((row: { id: string }) => row.id)).toEqual(["new-model"]);
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
