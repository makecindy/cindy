import { defaultWireProtocol } from './user-provider.js';
import type { ModelRegistry } from './modelAccessBean.js';
import { isModelSelectableForNewRoute } from './classification.js';
import { findBaseModel } from './modelMetadataLayers.js';
import { providerWireProtocolForApi } from './providerInterfaceRoutes.js';
import type { AgentKind, CatalogModel, Provider, ProviderWireProtocol } from './types.js';

/** Reviewed channel evidence, not public model aliases or a user-supplied configuration flag. */
export interface SelectionAliasEvidence {
  baseModelId: string;
  preferredModelId: string;
  modelIds: readonly string[];
  endpoints: readonly {
    baseUrl: string;
    wireProtocol: ProviderWireProtocol;
    requestPath?: string;
  }[];
  officialSource: string;
  verifiedAt: string;
}

/** Original members are retained for exact history lookup and management writes. */
export interface SelectionAliasGroup {
  providerId: string;
  keyModelId: string;
  members: Partial<Record<AgentKind, readonly CatalogModel[]>>;
}

/** Already-resolved preferences: the caller keeps existing owner/global/source precedence. */
export interface SelectionAliasPreferences {
  engine?: string;
  effort?: string;
  fast?: boolean | 'ultrafast';
  visible?: boolean;
  /** A user price belongs to its exact original route; never hide it behind another alias. */
  customPrice?: boolean;
  /** A member-specific thinking override retains that original row. */
  customThinking?: boolean;
}

/** Official mapping + the 2026-11-03 authenticated SSE/tool/image checks, recorded in the design. */
const VERIFIED_SELECTION_ALIASES: readonly SelectionAliasEvidence[] = [{
  baseModelId: 'deepseek/deepseek-v4.1-flash',
  preferredModelId: 'deepseek-flash',
  modelIds: ['deepseek-flash', 'deepseek-v4-flash'],
  endpoints: [
    { baseUrl: 'https://api.deepseek.com', wireProtocol: 'openai-chat' },
    { baseUrl: 'https://api.deepseek.com', wireProtocol: 'openai-responses' },
    { baseUrl: 'https://api.deepseek.com/anthropic', wireProtocol: 'anthropic-messages' },
  ],
  officialSource: 'https://api-docs.deepseek.com/quick_start/pricing/',
  verifiedAt: '2026-11-04',
}];

const DEEPSEEK_FLASH_IDS = new Set(['deepseek-flash', 'deepseek-v4-flash']);

function hasExplicitMetadata(model: CatalogModel): boolean {
  const raw = model.userModelConfig;
  return model.contextWindowExplicit === true || model.nameExplicit === true || !!raw &&
    ['contextWindow', 'maxOutputTokens', 'mode', 'modalities', 'supportsImageInput', 'reasoning',
      'reasoningDefaultEffort', 'route', 'api', 'piApi'].some((key) =>
      raw[key as keyof typeof raw] !== undefined);
}

/** Only these two inherited values are ambiguous spellings of the documented 1M size.
 * This is comparison-only: execution budgets, history and exact advanced-edit values are retained.
 * Explicit settings are excluded by the host before a marker is issued. */
function comparisonWindow(model: CatalogModel): number {
  return model.selectionAliasKey === 'deepseek-flash' && DEEPSEEK_FLASH_IDS.has(model.id) &&
    model.contextWindowExplicit !== true && [1_000_000, 1_048_576].includes(model.contextWindow)
    ? 1_000_000 : model.contextWindow;
}

const AGENTS: readonly AgentKind[] = ['claude-code', 'codex', 'pi'];

function normalizedUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return;
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    return;
  }
}

/** Object key order is not a capability difference; absent and explicit false remain distinct. */
function stableValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableValue).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value).filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableValue(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

function routeMatches(
  provider: Provider,
  agent: AgentKind,
  model: CatalogModel,
  evidence: SelectionAliasEvidence,
): boolean {
  const runtime = provider.routing[agent];
  if (!runtime || runtime.disabled || runtime.modelIdRewrite) return false;
  const baseUrl = normalizedUrl(model.route?.baseUrl ?? runtime.upstream);
  const protocol = model.route?.wireProtocol ?? runtime.wireProtocol ?? defaultWireProtocol(agent);
  const declaredApis = agent === 'pi' ? [model.api, model.piApi] : [model.api];
  if (!baseUrl || !protocol || declaredApis.some((api) =>
    api !== undefined && providerWireProtocolForApi(api) !== protocol)) return false;
  const requestPath = model.route?.requestPath ?? runtime.requestPath;
  return evidence.endpoints.some((endpoint) =>
    normalizedUrl(endpoint.baseUrl) === baseUrl && endpoint.wireProtocol === protocol &&
    endpoint.requestPath === requestPath);
}

function knownFlashReferenceCost(model: CatalogModel | undefined): CatalogModel['cost'] {
  if (!model || model.selectionAliasKey !== 'deepseek-flash' || model.id !== 'deepseek-flash' ||
      model.currency !== undefined && model.currency !== 'USD') return;
  const cost = model.cost;
  if (!cost || cost.cacheWrite !== undefined && cost.cacheWrite !== 0) return;
  // The verified official peak/off-peak reference bands, not a new unconditional billing rate.
  return (cost.input === 0.3 && cost.output === 1.2 && cost.cacheRead === 0.006) ||
    (cost.input === 0.15 && cost.output === 0.6 && cost.cacheRead === 0.003) ? cost : undefined;
}

function compatibleModels(models: readonly CatalogModel[]): boolean {
  // Comparing the complete effective shape is intentionally conservative. Names and documentation
  // may differ between an alias and its replacement; execution facts and explicit settings may not.
  const referenceCost = knownFlashReferenceCost(models.find(model => model.id === 'deepseek-flash'));
  const signature = (model: CatalogModel): string => {
    const { id, name, description, group, sortOrder, icon, discoveredMetadata,
      userModelConfig, ...facts } = model;
    const explicit = userModelConfig && Object.fromEntries(Object.entries(userModelConfig)
      .filter(([key]) => !['id', 'name', 'discoveredMetadata', 'discoveredCost'].includes(key)));
    // A removed obsolete quote is missing metadata, not evidence of another tariff. Compare
    // it with the already-present verified reference band; never rewrite runtime costs.
    const comparedCost = model.cost ?? (model.selectionAliasKey === 'deepseek-flash' &&
      model.id === 'deepseek-v4-flash' ? referenceCost : undefined);
    return stableValue({ facts: { ...facts, contextWindow: comparisonWindow(model), cost: comparedCost }, explicit,
      explicitName: model.nameExplicit ? name : undefined });
  };
  return models.every((model) => signature(model) === signature(models[0]));
}

function conflictingPreferences(values: readonly SelectionAliasPreferences[]): boolean {
  // Only explicit values participate: false is a value, undefined is inheritance.
  return values.some((value) => value.customPrice === true || value.customThinking === true) ||
    (['engine', 'effort', 'fast', 'visible'] as const).some((field) =>
    new Set(values.map((value) => value[field]).filter((value) => value !== undefined)).size > 1);
}

/** Read-only field-wise inheritance. A conflict has no winner and must keep separate rows. */
export function inheritSelectionAliasPreferences(
  values: readonly { modelId: string; preferences: SelectionAliasPreferences }[],
): { preferences: SelectionAliasPreferences; sourceModelIds: string[] } | undefined {
  if (conflictingPreferences(values.map((value) => value.preferences))) return;
  const preferences: SelectionAliasPreferences = {};
  const sources = new Set<string>();
  for (const value of values) {
    for (const field of ['engine', 'effort', 'fast'] as const) {
      if (value.preferences[field] !== undefined) sources.add(value.modelId);
    }
    if (value.preferences.engine !== undefined) preferences.engine = value.preferences.engine;
    if (value.preferences.effort !== undefined) preferences.effort = value.preferences.effort;
    if (value.preferences.fast !== undefined) preferences.fast = value.preferences.fast;
  }
  return { preferences, sourceModelIds: [...sources].sort() };
}

/**
 * Prepare display groups without removing routes or mutating saved configuration. No production
 * caller should use a group before its preference and advanced-edit adapters retain every member.
 * Evidence is injected for protocol fixtures; production admission is restricted to reviewed endpoints.
 */
export function selectionAliasGroups(options: {
  provider: Provider;
  registry: ModelRegistry | undefined;
  evidence?: readonly SelectionAliasEvidence[];
  preferences: (agent: AgentKind, modelId: string) => SelectionAliasPreferences;
}): SelectionAliasGroup[] {
  const { provider, registry, preferences, evidence = VERIFIED_SELECTION_ALIASES } = options;
  const groups: SelectionAliasGroup[] = [];
  for (const proof of evidence) {
    const ids = new Set(proof.modelIds);
    if (ids.size < 2 || ids.size !== proof.modelIds.length || !ids.has(proof.preferredModelId) ||
      !normalizedUrl(proof.officialSource) || !/^\d{4}-\d{2}-\d{2}$/.test(proof.verifiedAt) ||
      proof.modelIds.some((id) => findBaseModel(registry, id)?.id !== proof.baseModelId) ||
      evidence.some((other) => other !== proof && other.modelIds.some((id) => ids.has(id)))) continue;

    const members: SelectionAliasGroup['members'] = {};
    const presentIds = new Set<string>();
    const engines: SelectionAliasPreferences[] = [];
    let compatible = true;
    for (const agent of AGENTS) {
      const models = (provider.models[agent] ?? []).filter((model) => ids.has(model.id));
      if (!models.length) continue;
      const prefs = models.map((model) => preferences(agent, model.id));
      if (!provider.agents.includes(agent) ||
        new Set(models.map((model) => model.id)).size !== models.length ||
        !models.every((model) => routeMatches(provider, agent, model, proof)) ||
        !compatibleModels(models) || conflictingPreferences(prefs) ||
        prefs.some((pref) => models.some((model) =>
          (pref.effort !== undefined && !model.efforts.some((effort) => effort === pref.effort)) ||
          (pref.fast === true && model.supportsFastMode !== true) ||
          (pref.fast === 'ultrafast' && model.supportsUltrafastMode !== true)))) {
        compatible = false;
        break;
      }
      engines.push(...prefs.map(({ engine }) => ({ engine })));
      members[agent] = [...models].sort((a, b) => a.id.localeCompare(b.id));
      for (const model of models) presentIds.add(model.id);
    }
    const engineAvailable = engines.every(({ engine }) => engine === undefined ||
      (['cc', 'codex', 'pi'] as const).some((candidate) => candidate === engine &&
        (members[candidate === 'cc' ? 'claude-code' : candidate]?.length ?? 0) > 0));
    if (compatible && presentIds.size > 1 && !conflictingPreferences(engines) && engineAvailable) {
      groups.push({ providerId: provider.id, keyModelId: proof.preferredModelId, members });
    }
  }
  return groups;
}

/** New picks respect admission; saved IDs are identity lookups, not permission to send requests. */
export function selectionAliasMember(
  group: SelectionAliasGroup,
  agent: AgentKind,
  savedModelId?: string,
  isVisible: (model: CatalogModel) => boolean = (model) => model.defaultEnabled !== false,
): CatalogModel | undefined {
  const members = group.members[agent] ?? [];
  if (savedModelId !== undefined) return members.find((model) => model.id === savedModelId);
  const selectable = members.filter((model) => isVisible(model) &&
    isModelSelectableForNewRoute(model, { userProvider: true }));
  return selectable.find((model) => model.id === group.keyModelId) ?? selectable[0];
}

/** Management targets include hidden/disabled members; selectors still apply their own admission. */
export function selectionAliasTargets(
  group: SelectionAliasGroup,
  agent?: AgentKind,
): { agent: AgentKind; modelId: string }[] {
  return AGENTS.filter((candidate) => agent === undefined || candidate === agent)
    .flatMap((candidate) => (group.members[candidate] ?? [])
      .map((model) => ({ agent: candidate, modelId: model.id })));
}

/** Correct only proven obsolete automatic facts on the verified official direct connection.
 * No saved config is written. Local overrides and explicit runtime settings retain separate rows.
 * Static cost 0.14/0.28 is obsolete; current time-dependent pricing stays with the reference-price
 * service rather than being invented as one unconditional CatalogModel.cost. */
export function projectSelectionAliases(
  input: Provider,
  registry: ModelRegistry | undefined,
  options: { hasUserMetadata?: (agent: AgentKind, model: CatalogModel) => boolean } = {},
): Provider {
  let provider = input;
  const clearMarkers = (p: Provider): Provider => ({ ...p,
    models: Object.fromEntries(Object.entries(p.models).map(([agent, models]) =>
      [agent, models?.map(({ selectionAliasKey: _marker, ...model }) => model)])),
  });
  if (Object.values(provider.models).some((models) => models?.some((m) => m.selectionAliasKey))) {
    provider = clearMarkers(provider);
  }
  if (provider.source !== 'user') return provider;
  const evidence = VERIFIED_SELECTION_ALIASES.filter((proof) => {
    if (proof.modelIds.some((id) => findBaseModel(registry, id)?.id !== proof.baseModelId)) return false;
    const members = AGENTS.flatMap((agent) => (provider.models[agent] ?? [])
      .filter((m) => proof.modelIds.includes(m.id)).map((model) => ({ agent, model })));
    return new Set(members.map(({ model }) => model.id)).size > 1 && members.every(({ agent, model }) =>
      routeMatches(provider, agent, model, proof) && !hasExplicitMetadata(model) &&
      !options.hasUserMetadata?.(agent, model));
  });
  if (!evidence.length) return provider;
  provider = { ...provider, models: Object.fromEntries(Object.entries(provider.models).map(([agent, models]) =>
    [agent, models?.map((model) => {
      const proof = evidence.find((p) => p.modelIds.includes(model.id));
      if (!proof) return model;
      const cost = model.cost;
      const obsoleteCost = cost?.input === 0.14 && cost.output === 0.28 &&
        (cost.cacheRead === undefined || cost.cacheRead === 0.0028) &&
        (cost.cacheWrite === undefined || cost.cacheWrite === 0);
      return { ...model,
        supportsImageInput: true,
        modalities: { input: ['text', 'image'], output: ['text'] },
        ...([undefined, 384_000, 393_216].includes(model.maxOutput) ? { maxOutput: 393_216 } : {}),
        ...(obsoleteCost ? { cost: undefined } : {}),
        selectionAliasKey: proof.preferredModelId,
      };
    })])) };
  const groups = selectionAliasGroups({ provider, registry, evidence, preferences: () => ({}) });
  return { ...provider, models: Object.fromEntries(Object.entries(provider.models).map(([agent, models]) =>
    [agent, models?.map(({ selectionAliasKey: _marker, ...model }) => {
      const group = groups.find((g) => g.members[agent as AgentKind]?.some((m) => m.id === model.id));
      return group ? { ...model, selectionAliasKey: group.keyModelId } : model;
    })])) };
}

/** Consume only the host's marker; callers supply their own effective preferences/visibility. */
export function markedSelectionAliasGroups(
  provider: Provider,
  preferences: (agent: AgentKind, modelId: string) => SelectionAliasPreferences,
): SelectionAliasGroup[] {
  const keys = new Set(Object.values(provider.models).flatMap((models) =>
    (models ?? []).flatMap((model) => model.selectionAliasKey ? [model.selectionAliasKey] : [])));
  const result: SelectionAliasGroup[] = [];
  for (const key of keys) {
    const members: SelectionAliasGroup['members'] = {};
    const allPrefs: SelectionAliasPreferences[] = [];
    const ids = new Set<string>();
    let compatible = true;
    for (const agent of AGENTS) {
      const models = (provider.models[agent] ?? []).filter((model) => model.selectionAliasKey === key);
      if (!models.length) continue;
      const prefs = models.map((model) => preferences(agent, model.id));
      if (!provider.agents.includes(agent) ||
        new Set(models.map((model) => model.id)).size !== models.length ||
        !compatibleModels(models) || conflictingPreferences(prefs) ||
        prefs.some((pref) => models.some((model) =>
          (pref.effort !== undefined && !model.efforts.some((effort) => effort === pref.effort)) ||
          (pref.fast === true && model.supportsFastMode !== true) ||
          (pref.fast === 'ultrafast' && model.supportsUltrafastMode !== true)))) {
        compatible = false;
        break;
      }
      allPrefs.push(...prefs.map(({ engine }) => ({ engine })));
      members[agent] = models;
      models.forEach((model) => ids.add(model.id));
    }
    const engineAvailable = allPrefs.every(({ engine }) => engine === undefined ||
      (['cc', 'codex', 'pi'] as const).some((candidate) => candidate === engine &&
        (members[candidate === 'cc' ? 'claude-code' : candidate]?.length ?? 0) > 0));
    if (compatible && ids.has(key) && ids.size > 1 && !conflictingPreferences(allPrefs) && engineAvailable) {
      result.push({ providerId: provider.id, keyModelId: key, members });
    }
  }
  return result;
}
