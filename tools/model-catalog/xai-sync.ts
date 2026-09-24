import { isDeepStrictEqual } from 'node:util';
/** Account-scoped import: discovery owns membership; official details own reference tariffs. */
import {
  applyModelMetadata, BUNDLED_CATALOG, catalogModelMetadata, parseCatalog, resolveModelMetadata,
  type Catalog, type CatalogModel, type ModelMetadata,
} from '../../packages/model-providers/src/index.js';
import type { ModelReferencePrice } from '../../packages/model-providers/src/modelAccessBean.js';
import { parseXaiAccountModels } from '../../apps/desktop/src/main/maker-host/model-discovery/xai-models.js';
import { getActiveCatalog, setActiveCatalog, setXaiDiscoveredModels } from '../../apps/desktop/src/main/maker-host/active-catalog.js';
import { deriveAvailableModels } from '../../apps/desktop/src/main/maker-host/catalog-to-descriptors.js';
import { modelProtocolComparison } from '../../packages/model-providers/src/modelProtocol.js';
import { providerReferencePriceQuote } from '../../apps/desktop/src/shared/modelPriceQuote.js';

export const XAI_MODELS_URL = 'https://cli-chat-proxy.grok.com/v1/models';
export const XAI_DETAILS_URL = 'https://api.x.ai/v1/language-models';
const agents = ['claude-code', 'codex', 'pi'] as const;
type RecordValue = Record<string, unknown>;
function record(value: unknown): value is RecordValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function strings(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every(v => typeof v === 'string') ? value : undefined;
}
function price(value: unknown): number | undefined {
  // Official REST contract: USD cents per 100 million tokens -> USD per million.
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value / 10_000 : undefined;
}
function tariffs(row: RecordValue, observedAt: string): ModelReferencePrice[] | undefined {
  const input = price(row.prompt_text_token_price);
  const output = price(row.completion_text_token_price);
  if (input === undefined || output === undefined) return undefined;
  const cache = price(row.cached_prompt_text_token_price);
  const threshold = row.long_context_threshold;
  if (threshold !== undefined && (!Number.isSafeInteger(threshold) || Number(threshold) < 0)) {
    throw new Error('Invalid xAI long-context threshold');
  }
  const standard: ModelReferencePrice = {
    currency: 'USD', variant: 'standard', inputPerMtok: input, outputPerMtok: output,
    ...(cache !== undefined ? { cacheReadPerMtok: cache } : {}),
    // Observation date, not a claim about the provider's historical launch date.
    effectiveFrom: observedAt.slice(0, 10),
    source: { kind: 'provider-official', url: XAI_DETAILS_URL, verifiedAt: observedAt.slice(0, 10) },
  };
  if (!threshold) return [standard];
  const long = (key: string, fallback: number | undefined) => {
    const value = price(row[key]);
    // xAI explicitly defines zero as “use standard” for *_long_context fields.
    return value === 0 ? fallback : value;
  };
  const longInput = long('prompt_text_token_price_long_context', input);
  const longOutput = long('completion_text_token_price_long_context', output);
  if (longInput === undefined || longOutput === undefined) return undefined;
  const longCache = long('cached_prompt_text_token_price_long_context', cache);
  return [
    { ...standard, maxInputTokens: Number(threshold) },
    { ...standard, minInputTokens: Number(threshold), inputPerMtok: longInput,
      outputPerMtok: longOutput, cacheReadPerMtok: longCache },
  ];
}
function tariffValue(prices: ModelReferencePrice[]) {
  return prices.map(({ source: _source, effectiveFrom: _from, effectiveUntil: _until, ...value }) => value)
    .sort((a, b) => (a.minInputTokens ?? 0) - (b.minInputTokens ?? 0));
}
/** Keep history and other variants; a changed price starts at first observation, never backdated. */
function mergeTariffs(previous: ModelReferencePrice[], next: ModelReferencePrice[], day: string) {
  const active = previous.filter(p => p.variant === 'standard' && p.currency === 'USD' &&
    p.effectiveFrom <= day && (!p.effectiveUntil || day < p.effectiveUntil));
  if (isDeepStrictEqual(tariffValue(active), tariffValue(next))) {
    return previous.map(p => active.includes(p) ? { ...p, source: next[0].source } : p);
  }
  // A date-only schema cannot represent two changes in one day. Refuse to destroy that history.
  if (active.some(p => p.effectiveFrom === day)) throw new Error('Conflicting xAI tariffs on the same date');
  return [...previous.map(p => active.includes(p) ? { ...p, effectiveUntil: day } : p), ...next];
}

export function buildXaiSyncCandidate(baseline: Catalog, accountPayload: unknown, detailsPayload: unknown, observedAt: string) {
  if (!Number.isFinite(Date.parse(observedAt))) throw new Error('Invalid observation timestamp');
  const catalog = structuredClone(baseline);
  if (catalog.modelRegistry?.schemaVersion !== 5) throw new Error('Sync requires an existing V5 catalog');
  const registry = catalog.modelRegistry;
  const provider = catalog.providers.find(p => p.id === 'xai');
  if (!provider) throw new Error('Catalog lacks xAI subscription routing');
  // API discovery supplies no Fast execution relation or tariff. Preserve explicitly verified
  // catalog facts; never derive these from a suffix or from "2x" in a description.
  const verified = BUNDLED_CATALOG.providers.find(p => p.id === 'xai')!;
  const fastParents = [...new Map([
    ...(verified.models.codex ?? []), ...(provider.models.codex ?? []),
  ].filter(m => m.fastModelId).map(m => [m.id, m])).values()];
  for (const parent of fastParents) {
    for (const id of [parent.id, parent.fastModelId!]) {
      const source = BUNDLED_CATALOG.modelRegistry?.baseModels?.find(b => b.id === id);
      if (!source) continue;
      registry.baseModels ??= [];
      const existing = registry.baseModels.find(b => b.id === id);
      if (!existing) registry.baseModels.push(structuredClone(source));
      else for (const sourceGroup of source.referencePriceGroups ?? []) {
        existing.referencePriceGroups ??= [];
        const group = existing.referencePriceGroups.find(g => g.id === sourceGroup.id);
        if (!group) existing.referencePriceGroups.push(structuredClone(sourceGroup));
        else for (const variant of new Set(sourceGroup.prices.map(p => p.variant))) {
          if (!group.prices.some(p => p.variant === variant)) {
            group.prices.push(...structuredClone(sourceGroup.prices.filter(p => p.variant === variant)));
          }
        }
      }
    }
  }
  if (record(accountPayload) && Array.isArray(accountPayload.data)) {
    for (const row of accountPayload.data) {
      if (!record(row) || row.hidden === true || (record(row._meta) && row._meta.hidden === true)) continue;
      if (row.api_backend !== undefined && row.api_backend !== 'responses') {
        throw new Error('Unsupported xAI discovery backend; keep the previous catalog');
      }
    }
  }
  const discovered = parseXaiAccountModels(accountPayload);
  if (!discovered.length) throw new Error('Empty account list: refusing to replace a working catalog');
  if (!record(detailsPayload) || !Array.isArray(detailsPayload.models) || !detailsPayload.models.length) {
    throw new Error('Invalid or empty xAI language-models response');
  }
  const details = detailsPayload.models;
  if (!details.every(row => record(row) && typeof row.id === 'string')) throw new Error('Invalid xAI detail record');
  const ids = new Set(details.map(row => row.id));
  if (ids.size !== details.length) throw new Error('Duplicate xAI detail IDs');
  const gaps: Array<{ modelId: string; fields: string[] }> = [];
  const evidence: Array<{ modelId: string; detailId?: string; fieldsFromApi: string[]; fieldsFromCatalog: string[] }> = [];
  for (const member of discovered) {
    const wireId = member.id.replace(/^xai\//, '');
    const exact = details.filter(row => row.id === wireId);
    const matches = exact.length ? exact : details.filter(row => strings(row.aliases)?.includes(wireId));
    if (matches.length > 1) throw new Error(`Ambiguous xAI alias: ${wireId}`);
    const detail = matches[0];
    const input = detail && strings(detail.input_modalities);
    const output = detail && strings(detail.output_modalities);
    const capabilities = detail && record(detail.capabilities) ? detail.capabilities : undefined;
    // Reuse the runtime parser for effort validation and ascending order.
    const capabilityModel = capabilities ? parseXaiAccountModels({ data: [{ id: wireId,
      reasoning_efforts: capabilities.reasoning_effort,
      reasoning_effort: capabilities.default_reasoning_effort,
    }] })[0] : undefined;
    const metadata: ModelMetadata = {
      ...(input ? { supportsImageInput: input.includes('image') } : {}),
      ...(input && output ? { modalities: { input, output } } : {}),
      ...(capabilityModel?.efforts !== undefined ? { efforts: capabilityModel.efforts } : {}),
      ...(capabilityModel?.defaultEffort !== undefined ? { defaultEffort: capabilityModel.defaultEffort } : {}),
    };
    let entry = registry.models.find(e => e.routes.some(r => r.providerId === 'xai' && r.modelId === member.id));
    if (!entry) {
      entry = { id: member.id, name: member.name ?? wireId, status: 'active', modelRef: member.id,
        routes: [{ providerId: 'xai', modelId: member.id, agents: ['claude-code', 'codex'] }] };
      registry.models.push(entry);
    }
    const baseId = entry.modelRef ?? entry.id;
    registry.baseModels ??= [];
    let baseModel = registry.baseModels.find(b => b.id === baseId);
    if (!baseModel) { baseModel = { id: baseId, aliases: [], defaults: {} }; registry.baseModels.push(baseModel); }
    // Account-only fields stay on this connection's route; never become universal public facts.
    const route = entry.routes.find(r => r.providerId === 'xai' && r.modelId === member.id)!;
    const configuredDefault = resolveModelMetadata(registry, 'xai', member.id).defaultEffort;
    const accountMetadata = catalogModelMetadata(member);
    // A recommended effort is not a new configuration decision. Existing intent wins.
    if (configuredDefault !== undefined) delete accountMetadata.defaultEffort;
    route.defaults = { ...route.defaults, ...accountMetadata };
    const baseDefault = baseModel.defaults.defaultEffort;
    baseModel.defaults = { ...baseModel.defaults, ...metadata,
      ...(baseDefault !== undefined ? { defaultEffort: baseDefault } : {}) };
    if (member.nativeApi === 'openai-responses' && entry.nativeApi === undefined) entry.nativeApi = member.nativeApi;
    const prices = detail && tariffs(detail, observedAt);
    const knownFast = fastParents.some(m => m.fastModelId === member.id);
    const knownParent = fastParents.some(m => m.id === member.id);
    if (knownFast || knownParent) route.referencePriceGroup ??= 'global';
    if (prices) {
      baseModel.referencePriceGroups ??= [];
      let group = baseModel.referencePriceGroups.find(g => g.id === 'global');
      if (!group) { group = { id: 'global', prices: [] }; baseModel.referencePriceGroups.push(group); }
      group.prices = mergeTariffs(group.prices, prices, observedAt.slice(0, 10));
      route.referencePriceGroup ??= 'global';
    }
    const missing: string[] = [];
    const hasCatalogPrice = baseModel.referencePriceGroups?.some(g => g.prices.some(p =>
      p.variant === 'standard' && p.effectiveFrom <= observedAt.slice(0, 10) &&
      (!p.effectiveUntil || observedAt.slice(0, 10) < p.effectiveUntil)));
    if (!detail) missing.push('officialDetails');
    if (!prices && !hasCatalogPrice) missing.push('apiReferencePrice');
    if (!input && baseModel.defaults.supportsImageInput === undefined) missing.push('inputModalities');
    if (member.maxOutput === undefined) missing.push('apiMaxOutput');
    // Neither endpoint declares the Fast toggle's execution semantics. Names are not evidence.
    if (!knownFast && !knownParent) missing.push('fastExecution');
    gaps.push({ modelId: member.id, fields: missing });
    evidence.push({ modelId: member.id, ...(detail ? { detailId: detail.id as string } : {}),
      fieldsFromCatalog: [...(knownParent || knownFast ? ['fastExecution'] : []),
        ...(!prices && hasCatalogPrice ? ['referencePrices'] : [])],
      fieldsFromApi: [...Object.keys(catalogModelMetadata(member)), ...Object.keys(metadata), ...(prices ? ['referencePrices'] : [])] });
    for (const agent of agents) {
      const id = agent === 'pi' ? wireId : member.id;
      provider.models[agent] ??= [];
      const old = provider.models[agent]!.find(m => m.id === id);
      const resolved = resolveModelMetadata(registry, 'xai', member.id, catalogModelMetadata(member), undefined, agent);
      if (!resolved.contextWindow && !old?.contextWindow) throw new Error(`Unknown context window: ${member.id}`);
      const efforts = resolved.efforts ?? old?.efforts ?? [];
      const seed: CatalogModel = old ?? { id, name: member.name ?? wireId,
        contextWindow: resolved.contextWindow!, efforts, defaultEffort: null, status: 'active' };
      const model = applyModelMetadata(seed, resolved);
      const fastMapping = verified.models[agent]?.find(m => m.id === id)?.fastModelId;
      if (model.fastModelId === undefined && fastMapping !== undefined) model.fastModelId = fastMapping;
      // The new runtime derives Fast capability from the mapping + account membership.
      // Do not publish a boolean that would make an older client send service_tier instead.
      if (member.nativeApi !== undefined) model.nativeApi = member.nativeApi;
      if (agent === 'pi' && member.nativeApi === 'openai-responses') model.piApi = 'openai-responses';
      const comparison = modelProtocolComparison(provider, { [agent]: model }).forAgent(agent);
      // Unspecified user preferences follow native engines only; the real user override is applied later.
      const declaredDefault = (agent === 'pi' ? undefined : entry.perAgent?.[agent]?.defaultEnabled)
        ?? entry.defaultEnabled ?? old?.defaultEnabled;
      model.defaultEnabled = declaredDefault !== false && !knownFast && comparison?.mode === 'matching';
      if (agent !== 'pi') {
        entry.perAgent ??= {};
        entry.perAgent[agent] = { ...entry.perAgent[agent], defaultEnabled: model.defaultEnabled };
      }
      provider.models[agent] = [...provider.models[agent]!.filter(m => m.id !== id), model];
    }
  }
  // Keep monotonic revision even when the clock is behind the baseline's publication time.
  registry.updatedAt = new Date(Math.max(Date.parse(observedAt), Date.parse(registry.updatedAt) + 1)).toISOString();
  return { catalog: parseCatalog(catalog), discovered, evidence, gaps, observedAt };
}

/** Actual app import -> active catalog -> picker descriptors and price presentation input. */
export function inspectXaiImport(candidate: ReturnType<typeof buildXaiSyncCandidate>) {
  // Verify the artifact alone, then again with normal live discovery layered on top.
  setXaiDiscoveredModels(null);
  setActiveCatalog(parseCatalog(JSON.stringify(candidate.catalog)));
  const fromFile = getActiveCatalog();
  for (const member of candidate.discovered) {
    for (const agent of agents) {
      const id = agent === 'pi' ? member.id.replace(/^xai\//, '') : member.id;
      const xai = fromFile.providers.find(p => p.id === 'xai')!;
      if (!deriveAvailableModels({ ...fromFile, providers: [xai] }, agent).some(m => m.id === id)) {
        throw new Error(`Serialized catalog missing ${agent}/${member.id}`);
      }
    }
  }
  setXaiDiscoveredModels(candidate.discovered);
  const active = getActiveCatalog();
  const provider = active.providers.find(p => p.id === 'xai')!;
  const rows = candidate.discovered.map(member => {
    const modelRows = Object.fromEntries(agents.map(agent => [agent, provider.models[agent]?.find(
      m => m.id === (agent === 'pi' ? member.id.replace(/^xai\//, '') : member.id))]));
    const comparison = modelProtocolComparison(provider, modelRows);
    return { modelId: member.id, harnesses: Object.fromEntries(agents.map(agent => {
      const model = modelRows[agent];
      const descriptor = deriveAvailableModels({ ...active, providers: [provider] }, agent).find(m => m.id === model?.id);
      if (!model || !descriptor) throw new Error(`Import missing ${agent}/${member.id}`);
      if (comparison.forAgent(agent)?.mode === 'compatibility' && model.defaultEnabled === true) {
        throw new Error(`Compatibility route incorrectly enabled: ${agent}/${member.id}`);
      }
      const quote = providerReferencePriceQuote('xai', member.id, active.modelRegistry, { agent, officialOnly: true, at: candidate.observedAt });
      return [agent, { ...descriptor, protocol: comparison.forAgent(agent), apiReferencePrice: quote ?? null }];
    })) };
  });
  return { rows, importedModels: rows.length, harnessProjections: rows.length * agents.length,
    complete: candidate.gaps.every(g => !g.fields.length), gaps: candidate.gaps, evidence: candidate.evidence,
    generationRequests: 0, verification: 'active-catalog + picker descriptors + reference-price resolver; no GUI or inference' };
}
