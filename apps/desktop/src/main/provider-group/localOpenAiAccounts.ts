import { createHash, randomUUID } from 'node:crypto';
import { safeStorage } from 'electron';
import { findCatalogModel, isModelSelectableForNewRoute, providerModelRecord, type AgentKind, type CatalogModel, type Provider } from '@cindy/model-providers';
import { readProviderBillingCode, type ProviderBillingCode } from '@cindy/maker-shared/error-redaction';
import { isOpenAiApiEndpoint, openAiAccountGroupKind, type OpenAiGroupAccount, type OpenAiGroupApiAgent, type OpenAiGroupProbeResult } from '../../shared/openAiAccountGroup.js';
import { isProviderGroupProviderId } from '../../shared/providerGroup.js';
import { activeOwnerScopeKey, isAppSessionBoundaryPending, ownerScopedUserDataPath } from '../appSessionState.js';
import { getActiveCatalog } from '../maker-host/active-catalog.js';
import { desktopMakerLogger } from '../maker-host/logger-adapter.js';
import { createOverrideSettingsFile } from '../maker-host/override-settings-file.js';
import { runProviderProbe, resolveSavedProbeSpec, type ProviderProbeSpec } from '../maker-host/provider-diagnostics.js';
import { fetchProviderModels, invalidateOpenAiModelList, openAiModelsRequestKey, recentOpenAiModelList, type ProviderModelsFetchSpec } from '../maker-host/provider-model-fetch.js';
import { customProviderCredentialFingerprint, getProviderRouteCredentialRevision, isProviderRouteMutationInProgress, providerRoutingForModel, routingServesWireModel } from '../maker-host/provider-route.js';
import { PROVIDER_GROUP_DEFAULT_COOLDOWN_MS } from './router.js';

const agents: readonly OpenAiGroupApiAgent[] = ['codex', 'pi'];
type Hold = ({ code: 'AUTH_INVALID' } | { code: 'QUOTA_EXCEEDED'; billingCode: ProviderBillingCode })
  & { version?: string; credential?: string };
type Health = { blocked: Record<string, Hold> };

const store = createOverrideSettingsFile<Health>({
  label: 'openai-account-health',
  log: desktopMakerLogger.child('openai-account-health'),
  defaults: { blocked: {} },
  scopeKey: activeOwnerScopeKey,
  filePath: () => ownerScopedUserDataPath('openai-account-health.json'),
  maxBytes: 256 * 1024,
  logLoadedValue: false,
  preserveUnreadableFile: true,
  normalize(raw) {
    const source = (raw as Partial<Health> | null)?.blocked;
    const blocked: Record<string, Hold> = {};
    if (!source || typeof source !== 'object') return { blocked };
    for (const [key, value] of Object.entries(source)) {
      const [id, agent, overflow] = key.split(':');
      if (overflow !== undefined || !isProviderGroupProviderId(id) || !agents.some(item => item === agent)) continue;
      const metadata = {
        ...(typeof value?.version === 'string' && /^[a-f0-9-]{36}$/.test(value.version) ? { version: value.version } : {}),
        ...(typeof value?.credential === 'string' && /^[A-Za-z0-9+/=]{16,1024}$/.test(value.credential) ? { credential: value.credential } : {}),
      };
      if (value?.code === 'AUTH_INVALID') blocked[key] = { code: value.code, ...metadata };
      if (value?.code !== 'QUOTA_EXCEEDED') continue;
      const billingCode = readProviderBillingCode(value.billingCode === 'payment_required' ? 402 : 429,
        JSON.stringify({ error: { code: value.billingCode } }));
      if (billingCode) blocked[key] = { code: value.code, billingCode, ...metadata };
    }
    return { blocked };
  },
});

function openAiGroupApiRoute(provider: Provider, agent: AgentKind, model: CatalogModel) {
  if (!agents.some(item => item === agent) || openAiAccountGroupKind(provider) !== 'apiKey'
    || model.capabilities?.toolCall === false || !isModelSelectableForNewRoute(model, { userProvider: true })) return;
  const route = providerRoutingForModel(provider, agent, model.id);
  if (route && routingServesWireModel(route, model.id) && route.authStrategy === 'api-key-header' && isOpenAiApiEndpoint(route.upstream)
    && (route.wireProtocol === undefined || route.wireProtocol === 'openai-responses')
    && (route.requestPath === undefined || route.requestPath === '/responses')) return route;
}

export function isOpenAiGroupApiModel(provider: Provider, agent: AgentKind, model: CatalogModel): boolean {
  return openAiGroupApiRoute(provider, agent, model) !== undefined;
}

export function selectOpenAiGroupProbe(provider: Provider, preferredAgent?: OpenAiGroupApiAgent,
  accept: (model: CatalogModel) => boolean = () => true): { agent: OpenAiGroupApiAgent; model: CatalogModel; disableReasoning: boolean } | undefined {
  // Settings tests the primary configured runtime. Use a model with known
  // no-reasoning behavior first, then verified prices within that set.
  for (const agent of preferredAgent ? [preferredAgent] : agents) {
    const choices = (provider.models[agent] ?? []).flatMap(model => {
      if (!accept(model)) return [];
      const route = openAiGroupApiRoute(provider, agent, model);
      if (!route) return [];
      const record = providerModelRecord(model.id, route.upstream, 'openai-responses');
      const noReasoning = record?.reasoning === false || (record?.reasoning === undefined
        && (model.reasoning === false || model.capabilities?.reasoning === false));
      const off = record?.execution.pi.thinkingLevelMap?.off;
      const disableReasoning = !noReasoning && !model.reasoningRequired && (off === 'none'
        || (off === undefined && model.reasoningEfforts?.some(effort => String(effort) === 'none') === true));
      const input = model.cost?.input ?? record?.cost?.input;
      const output = model.cost?.output ?? record?.cost?.output;
      const cost = input !== undefined && output !== undefined ? input * 8 + output * 16 : Infinity;
      return [{ model, disableReasoning, avoidsReasoning: noReasoning || disableReasoning, cost }];
    });
    const choice = choices.sort((a, b) => Number(b.avoidsReasoning) - Number(a.avoidsReasoning) || a.cost - b.cost)[0];
    if (choice) return { agent, model: choice.model, disableReasoning: choice.disableReasoning };
  }
}

const inFlight = new Map<string, Promise<OpenAiGroupProbeResult>>();
const modelRejections = new Map<string, number>();
const MODEL_REJECTION_TTL_MS = 5 * 60_000;
const temporary = new Map<string, { result: OpenAiGroupProbeResult; until: number }>();
const latestObservation = new Map<string, number>();
const pendingHealth = new Map<string, Set<Promise<boolean>>>();
let observationSequence = 0;
let notifyAccountChanged: (providerId: string) => void = () => {};

export function setOpenAiGroupAccountChangedListener(listener: typeof notifyAccountChanged): void {
  notifyAccountChanged = listener;
}

function provider(id: string) {
  return getActiveCatalog().providers.find(row => row.id === id);
}

function makeScope(id: string, agent: AgentKind) {
  const owner = activeOwnerScopeKey();
  const revision = getProviderRouteCredentialRevision(id);
  const routing = provider(id)?.routing;
  const credential = (runtime: AgentKind) => {
    const hash = customProviderCredentialFingerprint(id, runtime);
    if (!hash) return;
    const headers = new Headers(routing?.[runtime]?.headerOverride);
    const project = headers.get('openai-project');
    const organization = headers.get('openai-organization');
    // One key can be dispatched with different project/organization headers.
    // Preserve older fingerprints when neither override is set.
    return project || organization
      ? createHash('sha256').update(JSON.stringify([hash, project, organization])).digest('hex') : hash;
  };
  const fingerprint = credential(agent);
  const slots = agents.filter(candidate => candidate === agent
    || (fingerprint !== undefined && credential(candidate) === fingerprint));
  return {
    id, fingerprint,
    keys: slots.map(candidate => `${id}:${candidate}`),
    scopedKey: owner + ':' + revision + ':' + id + ':' + (fingerprint ?? agent),
    isCurrent: () => !isAppSessionBoundaryPending() && activeOwnerScopeKey() === owner && getProviderRouteCredentialRevision(id) === revision
      && !isProviderRouteMutationInProgress(id),
  };
}

type CredentialScope = ReturnType<typeof makeScope>;

function matchingHolds(scope: CredentialScope, health: Health): [string, Hold][] {
  return agents.flatMap<[string, Hold]>(agent => {
    const key = `${scope.id}:${agent}`;
    const hold = health.blocked[key];
    if (!hold) return [];
    if (hold.credential && scope.fingerprint) {
      try {
        return safeStorage.decryptString(Buffer.from(hold.credential, 'base64')) === scope.fingerprint ? [[key, hold]] : [];
      } catch { /* Same-slot hold remains in effect if the encrypted identity cannot be read. */ }
    }
    return scope.keys.includes(key) ? [[key, hold]] : [];
  });
}

function readHealth(): Health {
  store.invalidateIfChanged();
  return store.read();
}

function readHold(scope: CredentialScope): Hold | undefined {
  const holds = matchingHolds(scope, readHealth());
  return holds.find(([, hold]) => hold.code === 'QUOTA_EXCEEDED')?.[1] ?? holds[0]?.[1];
}

function holdResult(hold: Hold): OpenAiGroupProbeResult {
  return hold.code === 'QUOTA_EXCEEDED' ? { ok: false, code: hold.code, billingCode: hold.billingCode } : { ok: false, code: hold.code };
}

export function isOpenAiGroupAccountUnavailable(id: string, agent: AgentKind): boolean {
  const account = provider(id);
  if (!account || openAiAccountGroupKind(account) !== 'apiKey') return false;
  const scope = makeScope(id, agent);
  const entry = temporary.get(scope.scopedKey);
  return !!readHold(scope) || (entry?.result.code === 'RATE_LIMITED' && entry.until > Date.now());
}

export function isOpenAiGroupApiAccount(id: string): boolean {
  const account = provider(id);
  return account !== undefined && openAiAccountGroupKind(account) === 'apiKey';
}

export function openAiGroupAccountResult(row: Provider): Pick<OpenAiGroupAccount, 'checks'> {
  const checks: NonNullable<OpenAiGroupAccount['checks']> = [];
  const seen = new Set<string>();
  for (const agent of agents) {
    if (!selectOpenAiGroupProbe(row, agent)) continue;
    const scope = makeScope(row.id, agent);
    if (seen.has(scope.scopedKey)) continue;
    seen.add(scope.scopedKey);
    const hold = readHold(scope);
    const entry = temporary.get(scope.scopedKey);
    const result = hold ? holdResult(hold) : entry && entry.until > Date.now() ? entry.result : undefined;
    checks.push({ agent, ...(hold ? { blocked: true } : {}), ...(result ? { result } : {}) });
  }
  return { checks };
}

function accountHasApiModel(account: Provider, modelId: string, agent: AgentKind): boolean {
  const model = findCatalogModel(account, modelId, agent, { exact: true });
  return !!model && isOpenAiGroupApiModel(account, agent, model);
}

export function hasOpenAiGroupApiModel(id: string, modelId: string, agent: AgentKind): boolean {
  const account = provider(id);
  return !!account && accountHasApiModel(account, modelId, agent);
}

export function isLocalOpenAiGroupAccountUsable(groupId: string, id: string, modelId: string, agent: AgentKind): boolean {
  const group = provider(groupId);
  const account = id === groupId ? group : provider(id);
  const kind = account && openAiAccountGroupKind(account);
  if (id !== groupId && (!group || !openAiAccountGroupKind(group) || !account || !kind)) return false;
  if (!account || kind !== 'apiKey') return true;
  return accountHasApiModel(account, modelId, agent) && !isOpenAiGroupAccountUnavailable(id, agent);
}

function holdVersions(scope: CredentialScope, health: Health): string {
  return matchingHolds(scope, health).map(([key, hold]) => key + '=' + hold.code + ':' + (hold.version ?? 'legacy')).join(',');
}

async function setHold(scope: CredentialScope, hold: Hold | undefined, testedHolds?: string): Promise<boolean> {
  let changed = false;
  let applied = false;
  let credential: string | undefined;
  if (hold && scope.fingerprint && safeStorage.isEncryptionAvailable()) {
    try { credential = safeStorage.encryptString(scope.fingerprint).toString('base64'); }
    catch { /* Fall back to the current credential slots. */ }
  }
  await store.updateAtomic(({ value }) => {
    if (!scope.isCurrent()) return {};
    const matching = matchingHolds(scope, value);
    if (!hold && (testedHolds === undefined || testedHolds !== holdVersions(scope, value))) return {};
    applied = true;
    const blocked = { ...value.blocked };
    if (hold) {
      // Keep a known billing cause visible, but invalidate an overlapping
      // success when the same credential also returns a fresh 401.
      const priorBilling = hold.code === 'AUTH_INVALID' && matching.find(([, saved]) => saved.code === 'QUOTA_EXCEEDED')?.[1];
      const next = { ...(priorBilling || hold), version: randomUUID(), ...(credential ? { credential } : {}) };
      for (const key of scope.keys) blocked[key] = next;
      changed = true;
    } else {
      for (const [key] of matching) {
        delete blocked[key];
        changed = true;
      }
    }
    return changed ? { blocked } : {};
  });
  if (changed && scope.isCurrent()) notifyAccountChanged(scope.id);
  return applied && scope.isCurrent();
}

export function captureOpenAiGroupApiResponse(id: string, agent: AgentKind) {
  const row = provider(id);
  if (!row || !agents.some(item => item === agent) || openAiAccountGroupKind(row) !== 'apiKey') return;
  const scope = makeScope(id, agent);
  const observe = captureObservation(scope);
  return (result: OpenAiGroupProbeResult, retryAt?: number, defaultCooldownMs?: number) => {
    const request = observe(result, retryAt, defaultCooldownMs);
    if (result.ok) return request;
    const pending = pendingHealth.get(scope.scopedKey) ?? new Set<Promise<boolean>>();
    pending.add(request);
    pendingHealth.set(scope.scopedKey, pending);
    const finished = () => {
      pending.delete(request);
      if (!pending.size && pendingHealth.get(scope.scopedKey) === pending) pendingHealth.delete(scope.scopedKey);
    };
    void request.then(finished, finished);
    return request;
  };
}

/** The upstream proxy sees the structured body before the engine emits its terminal turn. */
export async function settleOpenAiGroupAccountHealth(id: string, agent: AgentKind): Promise<void> {
  await Promise.allSettled(pendingHealth.get(makeScope(id, agent).scopedKey) ?? []);
}

/** Capture before dispatch. A newer authentication or billing refusal wins. */
export function captureOpenAiGroupDirectRecovery(id: string, agent: AgentKind, modelId: string) {
  const row = provider(id);
  const model = row && findCatalogModel(row, modelId, agent, { exact: true });
  if (!row || !model || !isOpenAiGroupApiModel(row, agent, model)) return;
  const scope = makeScope(id, agent);
  if (!scope.fingerprint) return;
  const versions = holdVersions(scope, readHealth());
  if (!versions) return;
  return Object.assign(() => setHold(scope, undefined, versions), { fingerprint: scope.fingerprint });
}

function captureObservation(scope: CredentialScope, testedHolds?: string) {
  const sequence = ++observationSequence;
  const fromTest = testedHolds !== undefined;
  const latest = () => (latestObservation.get(scope.scopedKey) ?? 0) <= sequence;
  return async (result: OpenAiGroupProbeResult, retryAt?: number, defaultCooldownMs = PROVIDER_GROUP_DEFAULT_COOLDOWN_MS) => {
    if (!scope.isCurrent()) return false;
    // A confirmed refusal must survive ordinary successes, including those
    // arriving out of order. An overlapping test may only clear its snapshot.
    if (result.billingCode) {
      return setHold(scope, { code: 'QUOTA_EXCEEDED', billingCode: result.billingCode });
    }
    if (result.code === 'AUTH_INVALID') return setHold(scope, { code: result.code });
    if (!fromTest && !latest()) return false;
    if (!fromTest && !result.ok && result.code !== 'RATE_LIMITED') return true;
    if (latest()) latestObservation.set(scope.scopedKey, sequence);
    if (latestObservation.size > 2048) latestObservation.delete(latestObservation.keys().next().value!);
    if (temporary.size > 2048) temporary.delete(temporary.keys().next().value!);
    if (result.code === 'RATE_LIMITED') {
      const current = temporary.get(scope.scopedKey);
      const now = Date.now();
      const until = retryAt ?? (current?.result.code === 'RATE_LIMITED' && current.until > now
        ? current.until : now + defaultCooldownMs);
      temporary.set(scope.scopedKey, { result, until });
    } else if (result.ok) {
      if (!fromTest) {
        if (readHold(scope)) return false;
        if (scope.isCurrent() && latest()) temporary.delete(scope.scopedKey);
        return !readHold(scope);
      }
      if (!await setHold(scope, undefined, testedHolds)) return false;
      if (scope.isCurrent()) temporary.delete(scope.scopedKey);
    }
    if (!scope.isCurrent()) return false;
    if (fromTest && result.code !== 'RATE_LIMITED') {
      const current = temporary.get(scope.scopedKey);
      const now = Date.now();
      if (current?.result.code !== 'RATE_LIMITED' || current.until <= now) {
        temporary.set(scope.scopedKey, { result, until: now + PROVIDER_GROUP_DEFAULT_COOLDOWN_MS });
      }
    }
    return true;
  };
}

export async function testOpenAiGroupApiAccount(id: string, fetchImpl?: typeof fetch, agent?: OpenAiGroupApiAgent): Promise<OpenAiGroupProbeResult> {
  const row = provider(id);
  const selected = row && openAiGroupAccountResult(row).checks?.find(check => check.blocked);
  const initial = row && selectOpenAiGroupProbe(row, agent ?? selected?.agent);
  if (!initial) return { ok: false, code: 'NO_TEST_MODEL' };
  const scope = makeScope(id, initial.agent);
  const active = inFlight.get(scope.scopedKey);
  if (active) return active;
  const observed = captureObservation(scope, holdVersions(scope, readHealth()));
  const running = (async (): Promise<OpenAiGroupProbeResult> => {
    const initialSpec = await resolveSavedProbeSpec(id, initial.agent, initial.model.id);
    if (!scope.isCurrent() || !isOpenAiApiEndpoint(initialSpec.baseUrl)) return { ok: false, code: 'UNKNOWN' };
    if (!initialSpec.apiKey && !new Headers(initialSpec.headers).get('authorization')) return { ok: false, code: 'AUTH_INVALID' };
    const listingSpec = (probe: ProviderProbeSpec): ProviderModelsFetchSpec => ({
      agent: probe.agent, baseUrl: probe.baseUrl, wireProtocol: 'openai-responses', authMethod: 'apiKey',
      modelsUrl: 'https://api.openai.com/v1/models', apiKey: probe.apiKey, headers: probe.headers,
      allowEmpty: true, redirect: 'error', responseByteLimit: 2 * 1024 * 1024, isCurrent: scope.isCurrent,
    });
    const listingKey = openAiModelsRequestKey(listingSpec(initialSpec));
    if (!listingKey) return { ok: false, code: 'AUTH_INVALID' };
    let listing = recentOpenAiModelList(listingKey, fetchImpl);
    if (!listing) {
      // A restricted key can be allowed to generate without being allowed to list.
      // Only the Responses request can decide the connection's billing/auth state.
      await fetchProviderModels(listingSpec(initialSpec), fetchImpl);
      if (!scope.isCurrent()) return { ok: false, code: 'UNKNOWN' };
      listing = recentOpenAiModelList(listingKey, fetchImpl);
    }
    const current = provider(id);
    if (!current) return { ok: false, code: 'UNKNOWN' };
    const rejectionKey = (modelId: string) => JSON.stringify([listingKey, id, getProviderRouteCredentialRevision(id), modelId]);
    const eligible = (model: CatalogModel) => (modelRejections.get(rejectionKey(model.id)) ?? 0) <= Date.now();
    const confirmed = listing?.ids;
    const choice = (confirmed && selectOpenAiGroupProbe(current, initial.agent, model => eligible(model) && confirmed.has(model.id)))
      ?? (!listing?.complete ? selectOpenAiGroupProbe(current, initial.agent, eligible) : undefined);
    const spec = choice && await resolveSavedProbeSpec(id, choice.agent, choice.model.id);
    if (!scope.isCurrent()) return { ok: false, code: 'UNKNOWN' };
    if (!choice || !spec) {
      const result: OpenAiGroupProbeResult = { ok: false, code: 'NO_TEST_MODEL' };
      await observed(result);
      return result;
    }
    if (!isOpenAiApiEndpoint(spec.baseUrl) || openAiModelsRequestKey(listingSpec(spec)) !== listingKey) {
      return { ok: false, code: 'UNKNOWN' };
    }
    const result = await runProviderProbe({
      ...spec, requireResponsesGeneration: true, disableReasoning: choice.disableReasoning,
    }, fetchImpl);
    if (!scope.isCurrent()) return { ok: false, code: 'UNKNOWN' };
    if (result.code === 'MODEL_NOT_FOUND') {
      modelRejections.set(rejectionKey(choice.model.id), Date.now() + MODEL_REJECTION_TTL_MS);
      if (modelRejections.size > 2048) modelRejections.delete(modelRejections.keys().next().value!);
      invalidateOpenAiModelList(listingKey, fetchImpl);
    }
    const summary: OpenAiGroupProbeResult = { ok: result.ok,
      ...(result.code ? { code: result.code } : {}),
      ...(result.billingCode ? { billingCode: result.billingCode } : {}) };
    const applied = await observed(summary, result.retryAt);
    if (!scope.isCurrent()) return { ok: false, code: 'UNKNOWN' };
    if (applied) return summary;
    const hold = readHold(scope);
    return hold ? holdResult(hold) : { ok: false, code: 'UNKNOWN' };
  })().finally(() => { inFlight.delete(scope.scopedKey); });
  inFlight.set(scope.scopedKey, running);
  return running;
}
