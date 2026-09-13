/** Read-only metadata audit. Never calls chat, completions, or other billable endpoints. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  parseModelsListResponse,
  buildUserProvider,
  providerModelRecord,
  PROVIDER_MODEL_CATALOG,
  BUNDLED_CATALOG,
  type CustomProviderConfig,
} from "../../packages/model-providers/src/index.js";
import { buildModelsFetchRequest } from '../../apps/desktop/src/main/maker-host/provider-model-fetch.js';
const source = "https://openrouter.ai/api/v1/models";
const response = process.argv[2]
  ? JSON.parse(await readFile(process.argv[2], "utf8"))
  : await fetch(source, { signal: AbortSignal.timeout(30000) }).then(
      async (r) => {
        if (!r.ok) throw new Error(`Metadata GET returned ${r.status}`);
        return r.json();
      },
    );
const discovered = parseModelsListResponse(response, source);
assert(discovered?.length);
const preset = BUNDLED_CATALOG.presets!.find(p => p.id === 'openrouter')!;
const runtimes: CustomProviderConfig['runtimes'] = {};
const requestCounts: Record<string, number> = {};
for (const agent of ['claude-code', 'codex', 'pi'] as const) {
  const runtime = preset.runtimes[agent]!;
  const request = buildModelsFetchRequest({ agent, baseUrl: runtime.baseUrl,
    wireProtocol: runtime.wireProtocol, modelsUrl: runtime.modelsUrl,
    // The public catalog requires no valid credential. Exercise the authenticated
    // header construction that the previous audit accidentally skipped.
    apiKey: 'invalid-test-key',
  });
  assert.equal(request.url, source);
  assert.equal(request.init.method, 'GET');
  const actual = process.argv[2] ? response : await fetch(request.url, {
    ...request.init, signal: AbortSignal.timeout(30000),
  }).then(async r => { assert.equal(r.status, 200); return r.json(); });
  const imported = parseModelsListResponse(actual, source)!;
  assert.deepEqual(imported.map(m => m.id).sort(), discovered.map(m => m.id).sort(), agent);
  requestCounts[agent] = imported.length;
  runtimes[agent] = { ...runtime, catalogPresetId: preset.id, models: imported };
}
const provider = buildUserProvider({
  id: "audit-router",
  name: "Audit",
  runtimes,
}, { modelRegistry: BUNDLED_CATALOG.modelRegistry, presets: [preset] });
let known = 0;
const catalogIds = new Set(
  PROVIDER_MODEL_CATALOG.providers.openrouter!.map((m) => m.id),
);
let knownIds = 0;
for (const item of response.data) {
  if (catalogIds.has(item.id)) knownIds++;
  if (providerModelRecord(item.id, preset.runtimes.pi!.baseUrl, 'openai-chat'))
    known++;
  for (const agent of ["pi", "codex", "claude-code"] as const) {
    const model = provider.models[agent]!.find(model => model.id === item.id)!;
    assert.equal(model.id, item.id);
    if (item.context_length > 0)
      assert.equal(model.contextWindow, item.context_length, item.id);
    if (item.top_provider?.max_completion_tokens > 0)
      assert.equal(
        model.maxOutput,
        item.top_provider.max_completion_tokens,
        item.id,
      );
    if (item.architecture?.input_modalities)
      assert.equal(
        model.supportsImageInput,
        item.architecture.input_modalities.includes("image"),
        item.id,
      );
    if (Number(item.pricing?.prompt) >= 0)
      assert.equal(
        model.cost?.input,
        Number(item.pricing.prompt) * 1000000,
        item.id,
      );
    if (item.reasoning?.required !== undefined)
      assert.equal(model.reasoningRequired, item.reasoning.required, item.id);
  }
}
console.log(
  JSON.stringify(
    {
      models: discovered.length,
      actualDiscoveryByEngine: requestCounts,
      catalogIdentityMatches: knownIds,
      newModelIds: discovered.length - knownIds,
      exactCatalogRouteMatches: known,
      importedWithoutCatalogMatch: discovered.length - known,
      harnessProjections: discovered.length * 3,
      generationRequests: 0,
    },
    null,
    2,
  ),
);
