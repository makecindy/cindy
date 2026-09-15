/** Public adapter metadata delivered in the same publication as providers and presets. */
export function validateProviderModelCatalog(input: unknown): void {
  const object = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
  const assert = (condition: unknown, path: string): void => { if (!condition) throw new Error(`providerModelCatalog.${path} is invalid`); };
  const positive = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value > 0;
  const apis = new Set(['anthropic-messages', 'openai-responses', 'openai-completions', 'google-generative-ai', 'bedrock-converse-stream', 'azure-openai-responses', 'google-vertex', 'mistral-conversations', 'openai-codex-responses']);
  const efforts = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
  assert(object(input), 'root');
  const catalog = input as Record<string, any>;
  assert(catalog.schemaVersion === 1 && typeof catalog.generatedAt === 'string' && Number.isFinite(Date.parse(catalog.generatedAt)), 'version');
  assert(object(catalog.providers), 'providers');
  for (const [provider, rows] of Object.entries(catalog.providers as Record<string, any>)) {
    assert(/^[a-zA-Z0-9_-]+$/.test(provider) && Array.isArray(rows), `providers.${provider}`);
    const seen = new Set<string>();
    for (const [index, row] of rows.entries()) {
      const path = `providers.${provider}[${index}]`;
      assert(object(row) && typeof row.id === 'string' && row.id.trim() && typeof row.name === 'string' && row.name.trim(), path);
      assert(!seen.has(row.id), `${path}.id`); seen.add(row.id);
      let url: URL | undefined;
      try { url = new URL(row.upstream); } catch { /* Report a field error below. */ }
      assert(row.upstream === '' || url && ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password, `${path}.upstream`);
      assert(positive(row.contextWindow) && (row.maxOutput === undefined || positive(row.maxOutput)), `${path}.contextWindow`);
      assert(object(row.modalities) && ['input', 'output'].every(key => Array.isArray(row.modalities[key]) && row.modalities[key].every((v: unknown) => typeof v === 'string' && v.length)), `${path}.modalities`);
      assert(typeof row.supportsImageInput === 'boolean' && typeof row.reasoning === 'boolean', `${path}.capabilities`);
      assert(Array.isArray(row.efforts) && row.efforts.every((v: unknown) => efforts.has(v as string)) && new Set(row.efforts).size === row.efforts.length, `${path}.efforts`);
      assert(row.defaultEffort === null || row.efforts.includes(row.defaultEffort), `${path}.defaultEffort`);
      assert(object(row.execution) && object(row.execution.pi) && apis.has(row.execution.pi.api), `${path}.execution.pi.api`);
      const pi = row.execution.pi;
      for (const field of ['compat', 'samplingParams', 'headers', 'thinkingLevelMap']) {
        if (pi[field] === undefined) continue;
        assert(object(pi[field]), `${path}.execution.pi.${field}`);
        if (field === 'headers' || field === 'thinkingLevelMap') assert(Object.values(pi[field]).every(value => typeof value === 'string' || field === 'thinkingLevelMap' && value === null), `${path}.execution.pi.${field}`);
      }
      if (row.cost !== undefined) {
        assert(object(row.cost), `${path}.cost`);
        for (const key of ['input', 'output', 'cacheRead', 'cacheWrite']) assert(row.cost[key] === undefined || typeof row.cost[key] === 'number' && Number.isFinite(row.cost[key]) && row.cost[key] >= 0, `${path}.cost.${key}`);
      }
    }
  }
}

/** Import-time interface corrections are data, scoped to explicitly listed endpoints. */
export function validatePresetInterfaces(preset: Record<string, unknown>): void {
  const check = (value: unknown, path: string) => {
    if (value === undefined) return;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path} must be a map`);
    for (const [key, raw] of Object.entries(value)) {
      const route = raw as { baseUrl?: unknown; api?: unknown; inputs?: unknown };
      if (!route || typeof route !== 'object' || typeof route.api !== 'string' || !['anthropic-messages', 'openai-responses', 'openai-completions', 'google-generative-ai', 'bedrock-converse-stream', 'azure-openai-responses', 'google-vertex', 'mistral-conversations'].includes(route.api)
        || !Array.isArray(route.inputs) || !route.inputs.length) throw new Error(`${path}.${key} is invalid`);
      if (path === 'interfaceDefaults' && !['claude-code', 'codex', 'pi'].includes(key)) throw new Error(`${path}.${key} is invalid`);
      for (const endpoint of [route.baseUrl, ...route.inputs]) {
        if (typeof endpoint !== 'string') throw new Error(`${path}.${key}.baseUrl is invalid`);
        const url = new URL(endpoint);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error(`${path}.${key}.baseUrl is invalid`);
      }
    }
  };
  check(preset.interfaceDefaults, 'interfaceDefaults');
  check(preset.modelInterfaces, 'modelInterfaces');
}
