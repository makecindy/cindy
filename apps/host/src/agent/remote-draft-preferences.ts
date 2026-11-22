import { activeOwnerScopeKey } from '../../../desktop/src/main/appSessionState.js';
import { requireObject, requireString } from '../../../desktop/src/main/utils/ipcValidate.js';
import {
  getRemoteNewMakerDefaults,
  getRemoteNewMakerDefaultsByVendor,
  setNewMakerDraftCache,
  setProviderModelMemoryCache,
  type NewMakerDraftSnapshot,
  type ProviderModelMemorySnapshot,
} from '../../../desktop/src/main/maker-host/newMakerDefaultsCache.js';
import { normalizeBotModelChain } from '../../../desktop/src/shared/botModelChain.js';
import { createOverrideSettingsFile } from '../../../desktop/src/main/maker-host/override-settings-file.js';
import { ownerScopedPath, isOwnerBoundaryPending } from '../../../desktop/src/main/ownerContext.js';
import { createLogger } from '../../../desktop/src/main/logger.js';

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

const store = createOverrideSettingsFile<NewMakerDraftSnapshot>({
  filePath: () => ownerScopedPath('host-new-maker-defaults.json'),
  defaults: emptySnapshot,
  normalize: normalizeSnapshot,
  log: createLogger('host-draft-preferences'),
  label: 'Host New Maker draft preferences',
});

let snapshotScope: string | undefined;
let snapshot: NewMakerDraftSnapshot | null = null;
let providerMemory: ProviderModelMemorySnapshot = {};

function readSnapshot(): NewMakerDraftSnapshot {
  if (isOwnerBoundaryPending()) throw new Error('[PRECONDITION_FAILED] Host account is changing');
  const scope = activeOwnerScopeKey();
  if (!snapshot || snapshotScope !== scope) {
    snapshot = store.read();
    snapshotScope = scope;
    providerMemory = snapshot.providerModelMemory ?? {};
  }
  return snapshot;
}

function syncSharedCache(): NewMakerDraftSnapshot {
  const next = readSnapshot();
  next.providerModelMemory = providerMemory;
  setProviderModelMemoryCache(providerMemory);
  setNewMakerDraftCache(next, activeOwnerScopeKey());
  return next;
}

function publishSnapshot(): void {
  const next = syncSharedCache();
  store.writePatch(next);
  snapshot = next;
}

/** First read after a Host restart hydrates the same reader used by Desktop. */
export function getHostNewMakerDefaults(agent: 'claude-code' | 'codex' | 'pi') {
  syncSharedCache();
  return getRemoteNewMakerDefaults(agent);
}

export function getHostNewMakerDefaultsByVendor() {
  syncSharedCache();
  return getRemoteNewMakerDefaultsByVendor();
}

function requireAgent(value: unknown): 'claude-code' | 'codex' | 'pi' {
  const agent = requireString(value, 'agent');
  if (agent !== 'claude-code' && agent !== 'codex' && agent !== 'pi') {
    throw new Error('[INVALID_PARAMS] agent must be claude-code|codex|pi');
  }
  return agent;
}

export function applyHostNewMakerDraftPref(raw: unknown) {
  const pref = requireObject(raw);
  const agent = requireAgent(pref.agent);
  const providerId = pref.providerId === undefined ? undefined : requireString(pref.providerId, 'providerId');
  if (pref.active !== true && !providerId) throw new Error('[INVALID_PARAMS] providerId required');
  const modelId = requireString(pref.modelId, 'modelId');
  if (!modelId) throw new Error('[INVALID_PARAMS] modelId required');
  if (pref.effort !== undefined) requireString(pref.effort, 'effort');
  if (pref.fast !== undefined && typeof pref.fast !== 'boolean' && pref.fast !== 'ultrafast') {
    throw new Error('[INVALID_PARAMS] fast must be boolean or ultrafast');
  }
  if (pref.thinking !== undefined && typeof pref.thinking !== 'boolean') {
    throw new Error('[INVALID_PARAMS] thinking must be boolean');
  }
  if (pref.markModelChoice !== undefined && typeof pref.markModelChoice !== 'boolean') {
    throw new Error('[INVALID_PARAMS] markModelChoice must be boolean');
  }
  if (pref.selectDraftAgent !== undefined && typeof pref.selectDraftAgent !== 'boolean') {
    throw new Error('[INVALID_PARAMS] selectDraftAgent must be boolean');
  }
  const taskProviderId = pref.taskProviderId === undefined
    ? undefined
    : requireString(pref.taskProviderId, 'taskProviderId');

  const next = readSnapshot();
  const vendor = agent === 'claude-code' ? 'cc' : agent;
  if (pref.active === true && !taskProviderId) {
    const previous = next.lastByVendor[vendor] ?? {};
    next.lastByVendor = {
      ...next.lastByVendor,
      [vendor]: {
        ...previous,
        model: modelId,
        providerId: providerId ?? null,
        effort: typeof pref.effort === 'string' ? pref.effort : previous.effort,
      },
    };
    next.modelChosenByVendor = {
      ...next.modelChosenByVendor,
      [vendor]: pref.markModelChoice !== false,
    };
  } else if (pref.markModelChoice !== undefined && !taskProviderId) {
    next.modelChosenByVendor = {
      ...next.modelChosenByVendor,
      [vendor]: pref.markModelChoice,
    };
  }

  if (typeof pref.effort === 'string') next.effortByModel = { ...next.effortByModel, [modelId]: pref.effort };
  if (pref.fast !== undefined) next.fastModeByModel = { ...next.fastModeByModel, [modelId]: pref.fast };

  const memoryKeys = [`${agent}:*`];
  if (providerId) memoryKeys.push(`${agent}:${providerId}`);
  for (const key of memoryKeys) {
    const previous = providerMemory[key] ?? { effortByModel: {}, fastByModel: {}, thinkingByModel: {} };
    providerMemory = {
      ...providerMemory,
      [key]: {
        effortByModel: typeof pref.effort === 'string'
          ? { ...previous.effortByModel, [modelId]: pref.effort }
          : previous.effortByModel,
        fastByModel: pref.fast !== undefined
          ? { ...previous.fastByModel, [modelId]: pref.fast }
          : previous.fastByModel,
        thinkingByModel: pref.thinking !== undefined
          ? { ...previous.thinkingByModel, [modelId]: pref.thinking }
          : previous.thinkingByModel,
      },
    };
  }

  if (pref.selectDraftAgent === true && pref.active === true && pref.markModelChoice === true && !taskProviderId) {
    next.selectedRoute = normalizeBuiltInRoute({
      harness: agent === 'claude-code' ? 'claude' : agent,
      model: modelId,
      providerId: providerId ?? null,
      effort: pref.effort,
      fastMode: pref.fast,
    });
  }
  publishSnapshot();
  return getHostNewMakerDefaults(agent);
}

/** Simulate a fresh process without deleting the persisted file. */
export function resetHostDraftPreferencesReadCacheForTest(): void {
  snapshot = null;
  providerMemory = {};
  setProviderModelMemoryCache({});
  setNewMakerDraftCache(emptySnapshot(), activeOwnerScopeKey());
}

export function resetHostDraftPreferencesForTest(): void {
  store.reset();
  resetHostDraftPreferencesReadCacheForTest();
}

export function applyHostNewMakerWorktreePref(raw: unknown) {
  const pref = requireObject(raw);
  if (typeof pref.worktreeEnabled !== 'boolean') {
    throw new Error('[INVALID_PARAMS] worktreeEnabled must be boolean');
  }
  readSnapshot().worktreeEnabled = pref.worktreeEnabled;
  publishSnapshot();
  return getHostNewMakerDefaultsByVendor();
}
