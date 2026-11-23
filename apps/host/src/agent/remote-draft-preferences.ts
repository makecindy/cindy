import { activeOwnerScopeKey } from '../../../desktop/src/main/appSessionState.js';
import { requireObject, requireString, throwIpcError } from '../../../desktop/src/main/utils/ipcValidate.js';
import {
  getRemoteNewMakerDefaults,
  getRemoteNewMakerDefaultsByVendor,
  setNewMakerDraftCache,
  setProviderModelMemoryCache,
  type NewMakerDraftSnapshot,
  type ProviderModelMemorySnapshot,
} from '../../../desktop/src/main/maker-host/newMakerDefaultsCache.js';
import { normalizeBotModelChain } from '../../../desktop/src/shared/botModelChain.js';
import { ownerScopedPath, isOwnerBoundaryPending } from '../../../desktop/src/main/ownerContext.js';
import { createLogger } from '../../../desktop/src/main/logger.js';
import { createAsyncJsonSettings } from './async-json-settings.js';

/**
 * Host-owned New Maker mirror. A Node Host has no renderer to own this state, so
 * controller writes are applied to the same main-side cache used by the desktop
 * reader instead of being acknowledged without persisting anything.
 */
const emptySnapshot = (): NewMakerDraftSnapshot => ({
  lastByVendor: {},
  fastModeByModel: {},
  effortByModel: {},
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every(item => typeof item === 'string');
}

function isFastRecord(value: unknown): value is Record<string, boolean | 'ultrafast'> {
  return isRecord(value) && Object.values(value).every(item => typeof item === 'boolean' || item === 'ultrafast');
}

function isBooleanRecord(value: unknown): value is Record<string, boolean> {
  return isRecord(value) && Object.values(value).every(item => typeof item === 'boolean');
}

function normalizeBuiltInRoute(raw: unknown): NewMakerDraftSnapshot['selectedRoute'] {
  const route = normalizeBotModelChain([raw])[0];
  return route && (route.harness === 'claude' || route.harness === 'codex' || route.harness === 'pi')
    ? route
    : undefined;
}

function normalizeSnapshot(raw: unknown): NewMakerDraftSnapshot {
  if (!isRecord(raw)) return emptySnapshot();
  const lastByVendor: NewMakerDraftSnapshot['lastByVendor'] = {};
  if (isRecord(raw.lastByVendor)) {
    for (const vendor of ['cc', 'codex', 'pi'] as const) {
      const prefs = raw.lastByVendor[vendor];
      if (!isRecord(prefs)) continue;
      lastByVendor[vendor] = {
        ...(typeof prefs.model === 'string' ? { model: prefs.model } : {}),
        ...(typeof prefs.effort === 'string' ? { effort: prefs.effort } : {}),
        ...(typeof prefs.permissionMode === 'string' ? { permissionMode: prefs.permissionMode } : {}),
        ...(prefs.providerId === null || typeof prefs.providerId === 'string' ? { providerId: prefs.providerId } : {}),
      };
    }
  }
  const providerModelMemory: ProviderModelMemorySnapshot = {};
  if (isRecord(raw.providerModelMemory)) {
    for (const [key, entry] of Object.entries(raw.providerModelMemory)) {
      if (!isRecord(entry) || !isStringRecord(entry.effortByModel) || !isFastRecord(entry.fastByModel) ||
        (entry.thinkingByModel !== undefined && !isBooleanRecord(entry.thinkingByModel))) continue;
      providerModelMemory[key] = {
        effortByModel: entry.effortByModel,
        fastByModel: entry.fastByModel,
        ...(entry.thinkingByModel !== undefined ? { thinkingByModel: entry.thinkingByModel } : {}),
      };
    }
  }
  const selectedRoute = normalizeBuiltInRoute(raw.selectedRoute);
  return {
    ...(selectedRoute ? { selectedRoute } : {}),
    lastByVendor,
    ...(isBooleanRecord(raw.modelChosenByVendor) ? { modelChosenByVendor: raw.modelChosenByVendor } : {}),
    fastModeByModel: isFastRecord(raw.fastModeByModel) ? raw.fastModeByModel : {},
    effortByModel: isStringRecord(raw.effortByModel) ? raw.effortByModel : {},
    providerModelMemory,
    worktreeEnabled: raw.worktreeEnabled === true,
  };
}

const store = createAsyncJsonSettings<NewMakerDraftSnapshot>({
  filePath: () => ownerScopedPath('host-new-maker-defaults.json'),
  defaults: emptySnapshot,
  normalize: normalizeSnapshot,
  log: createLogger('host-draft-preferences'),
  label: 'Host New Maker draft preferences',
});

/** The loaded snapshot of one account; providerModelMemory lives inside it. */
let loaded: { scope: string; snapshot: NewMakerDraftSnapshot } | null = null;

function currentScope(): string {
  if (isOwnerBoundaryPending()) throwIpcError('PRECONDITION_FAILED', 'Host account is changing');
  return activeOwnerScopeKey();
}

function assertScope(scope: string): void {
  if (currentScope() !== scope) throwIpcError('PRECONDITION_FAILED', 'Host account changed');
}

/** Feed the shared reader (newMakerDefaultsCache) the Desktop also answers from. */
function adopt(scope: string, snapshot: NewMakerDraftSnapshot): void {
  loaded = { scope, snapshot };
  setProviderModelMemoryCache(snapshot.providerModelMemory ?? {});
  setNewMakerDraftCache(snapshot, scope);
}

async function loadSnapshot(): Promise<void> {
  const scope = currentScope();
  if (loaded?.scope === scope) return;
  const snapshot = await store.read();
  assertScope(scope);
  if (loaded?.scope !== scope) adopt(scope, snapshot);
}

/** First read after a Host restart hydrates the same reader used by Desktop. */
export async function getHostNewMakerDefaults(agent: 'claude-code' | 'codex' | 'pi') {
  await loadSnapshot();
  return getRemoteNewMakerDefaults(agent);
}

export async function getHostNewMakerDefaultsByVendor() {
  await loadSnapshot();
  return getRemoteNewMakerDefaultsByVendor();
}

/**
 * Apply one change to this account's snapshot. The change runs on a copy, in order with every other
 * write, and the shared reader only sees it once the file has been replaced.
 */
async function mutate(change: (next: NewMakerDraftSnapshot) => void): Promise<void> {
  const scope = currentScope();
  const next = await store.update(current => {
    assertScope(scope);
    const base = loaded?.scope === scope ? loaded.snapshot : current;
    const copy = structuredClone(base);
    change(copy);
    return { next: copy, result: copy };
  });
  assertScope(scope);
  adopt(scope, next);
}

function requireAgent(value: unknown): 'claude-code' | 'codex' | 'pi' {
  const agent = requireString(value, 'agent');
  if (agent !== 'claude-code' && agent !== 'codex' && agent !== 'pi') {
    throwIpcError('INVALID_PARAMS', 'agent must be claude-code|codex|pi');
  }
  return agent;
}

export async function applyHostNewMakerDraftPref(raw: unknown) {
  const pref = requireObject(raw);
  const agent = requireAgent(pref.agent);
  const providerId = pref.providerId === undefined ? undefined : requireString(pref.providerId, 'providerId');
  if (pref.active !== true && !providerId) throwIpcError('INVALID_PARAMS', 'providerId required');
  const modelId = requireString(pref.modelId, 'modelId');
  if (!modelId) throwIpcError('INVALID_PARAMS', 'modelId required');
  if (pref.effort !== undefined) requireString(pref.effort, 'effort');
  if (pref.fast !== undefined && typeof pref.fast !== 'boolean' && pref.fast !== 'ultrafast') {
    throwIpcError('INVALID_PARAMS', 'fast must be boolean or ultrafast');
  }
  if (pref.thinking !== undefined && typeof pref.thinking !== 'boolean') {
    throwIpcError('INVALID_PARAMS', 'thinking must be boolean');
  }
  if (pref.markModelChoice !== undefined && typeof pref.markModelChoice !== 'boolean') {
    throwIpcError('INVALID_PARAMS', 'markModelChoice must be boolean');
  }
  if (pref.selectDraftAgent !== undefined && typeof pref.selectDraftAgent !== 'boolean') {
    throwIpcError('INVALID_PARAMS', 'selectDraftAgent must be boolean');
  }
  const taskProviderId = pref.taskProviderId === undefined
    ? undefined
    : requireString(pref.taskProviderId, 'taskProviderId');
  const effort = typeof pref.effort === 'string' ? pref.effort : undefined;

  await mutate(next => {
    const vendor = agent === 'claude-code' ? 'cc' : agent;
    if (pref.active === true && !taskProviderId) {
      const previous = next.lastByVendor[vendor] ?? {};
      const marks = pref.markModelChoice !== false;
      const alreadyChosen = next.modelChosenByVendor?.[vendor] === true;
      // As the desktop draft (newMakerDraft.ts patchVendorPrefsInternal): a write that does not mark a
      // choice (an effort or Fast change on the current model) never replaces a model or source the
      // user chose, and never clears that mark. A different model's effort is dropped with it.
      const keepsChoice = !marks && alreadyChosen;
      const keepsEffort = keepsChoice && modelId !== previous.model;
      next.lastByVendor = {
        ...next.lastByVendor,
        [vendor]: {
          ...previous,
          ...(keepsChoice ? {} : { model: modelId, providerId: providerId ?? null }),
          effort: effort !== undefined && !keepsEffort ? effort : previous.effort,
        },
      };
      if (marks) next.modelChosenByVendor = { ...next.modelChosenByVendor, [vendor]: true };
    } else if (pref.markModelChoice === true && !taskProviderId) {
      next.modelChosenByVendor = { ...next.modelChosenByVendor, [vendor]: true };
    }

    if (effort !== undefined) next.effortByModel = { ...next.effortByModel, [modelId]: effort };
    if (pref.fast !== undefined) next.fastModeByModel = { ...next.fastModeByModel, [modelId]: pref.fast as boolean | 'ultrafast' };

    const memory = { ...(next.providerModelMemory ?? {}) };
    const memoryKeys = [`${agent}:*`];
    if (providerId) memoryKeys.push(`${agent}:${providerId}`);
    for (const key of memoryKeys) {
      const previous = memory[key] ?? { effortByModel: {}, fastByModel: {}, thinkingByModel: {} };
      memory[key] = {
        effortByModel: effort !== undefined ? { ...previous.effortByModel, [modelId]: effort } : previous.effortByModel,
        fastByModel: pref.fast !== undefined
          ? { ...previous.fastByModel, [modelId]: pref.fast as boolean | 'ultrafast' }
          : previous.fastByModel,
        thinkingByModel: pref.thinking !== undefined
          ? { ...previous.thinkingByModel, [modelId]: pref.thinking as boolean }
          : previous.thinkingByModel,
      };
    }
    next.providerModelMemory = memory;

    if (pref.selectDraftAgent === true && pref.active === true && pref.markModelChoice === true && !taskProviderId) {
      next.selectedRoute = normalizeBuiltInRoute({
        harness: agent === 'claude-code' ? 'claude' : agent,
        model: modelId,
        providerId: providerId ?? null,
        effort,
        fastMode: pref.fast,
      });
    }
  });
  return getHostNewMakerDefaults(agent);
}

/** Simulate a fresh process without deleting the persisted file. */
export function resetHostDraftPreferencesReadCacheForTest(): void {
  loaded = null;
  setProviderModelMemoryCache({});
  setNewMakerDraftCache(emptySnapshot(), activeOwnerScopeKey());
}

export async function resetHostDraftPreferencesForTest(): Promise<void> {
  await store.reset();
  resetHostDraftPreferencesReadCacheForTest();
}

export async function applyHostNewMakerWorktreePref(raw: unknown) {
  const pref = requireObject(raw);
  if (typeof pref.worktreeEnabled !== 'boolean') {
    throwIpcError('INVALID_PARAMS', 'worktreeEnabled must be boolean');
  }
  const worktreeEnabled = pref.worktreeEnabled;
  await mutate(next => { next.worktreeEnabled = worktreeEnabled; });
  return getHostNewMakerDefaultsByVendor();
}
