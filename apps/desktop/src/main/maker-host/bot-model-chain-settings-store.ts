import { app } from 'electron';
import path from 'node:path';
import { isModelVisible, type ProviderView } from '@cindy/model-providers';
import { defaultBotModelChain } from '../../shared/botDefaultModelChain.js';

import {
  normalizeBotModelChain,
  type BotModelRoute,
} from '../../shared/botModelChain.js';
import { activeOwnerScopeKey, getActiveAppSession, ownerScopedUserDataPath } from '../appSessionState.js';
import { desktopMakerLogger } from './logger-adapter.js';
import { getMakerIfReady } from './index.js';
import { getDesktopProviderService } from './createDesktopProviderService.js';
import {
  createOverrideSettingsFile,
  type OverrideSettingsState,
} from './override-settings-file.js';

import { getModelVisibilityOverride, waitForModelVisibilityMirror } from './model-visibility-mirror.js';
import { getSelectedNewMakerRoute } from './newMakerDefaultsCache.js';

const log = desktopMakerLogger.child('bot-model-chain-settings-store');

export interface BotModelChainSettings {
  modelChain: BotModelRoute[];
}

const DEFAULTS: BotModelChainSettings = { modelChain: [] };

function normalize(raw: unknown): BotModelChainSettings {
  const record = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};
  const modelChain = normalizeBotModelChain(record.modelChain);
  return { modelChain };
}

function settingsFilePath(rootPath?: string): string {
  return path.join(rootPath ?? app.getPath('userData'), 'bot-model-chain-settings.json');
}

const stores = new Map<
  string,
  ReturnType<typeof createOverrideSettingsFile<BotModelChainSettings>>
>();

let providerRead: { owner: string; promise: Promise<ProviderView[]> } | undefined;

function readConnectedProviders(owner: string): Promise<ProviderView[]> {
  if (providerRead?.owner === owner) return providerRead.promise;
  // A roster read resolves several profiles together. Share only the in-flight
  // credential read, never a cached connection state or another owner's result.
  const promise = getDesktopProviderService().listProviders({ allowSideEffects: false })
    .finally(() => { if (providerRead?.promise === promise) providerRead = undefined; });
  providerRead = { owner, promise };
  return promise;
}

function currentStore(rootPath?: string) {
  const ownerRoot = rootPath
    ?? (getActiveAppSession().dataOwnerId ? ownerScopedUserDataPath() : null);
  const key = ownerRoot ?? '<global>';
  let current = stores.get(key);
  if (!current) {
    current = createOverrideSettingsFile<BotModelChainSettings>({
      filePath: () => settingsFilePath(ownerRoot ?? undefined),
      defaults: DEFAULTS,
      normalize,
      log,
      label: 'bot-model-chain',
      scopeKey: rootPath
        ? () => `root:${rootPath}`
        : activeOwnerScopeKey,
    });
    stores.set(key, current);
  }
  return current;
}

export async function readBotModelChainSettings(
  options?: { rootPath?: string; providers?: readonly ProviderView[]; availableAgents?: ReadonlySet<'cc' | 'codex' | 'pi' | 'grok-build'> },
): Promise<BotModelChainSettings> {
  return (await readBotModelChainSettingsState(options)).value;
}

export async function readBotModelChainSettingsState(
  options?: { rootPath?: string; providers?: readonly ProviderView[]; availableAgents?: ReadonlySet<'cc' | 'codex' | 'pi' | 'grok-build'> },
): Promise<OverrideSettingsState<BotModelChainSettings>> {
  const store = currentStore(options?.rootPath);
  store.invalidateIfChanged();
  const state = store.readState();
  if (state.isCustomized) return state;
  // Capture the owner before reading live connections; never persist derived defaults.
  const owner = activeOwnerScopeKey();
  await waitForModelVisibilityMirror();
  const providers = options?.providers ?? await readConnectedProviders(owner);
  if (activeOwnerScopeKey() !== owner) throw new Error('Bot model defaults owner changed');
  store.invalidateIfChanged();
  const latest = store.readState();
  if (latest.isCustomized) return latest;
  const availableAgents = options?.availableAgents ?? new Set(
    (getMakerIfReady()?.listAvailableAgents() ?? []).map((agent) => agent === 'claude-code' ? 'cc' : agent),
  );
  const value = { modelChain: defaultBotModelChain({ providers, providersLoading: false,
    availableAgents, availableAgentsLoaded: true,
    preferredRoute: getSelectedNewMakerRoute(owner),
    isModelEnabled: (agent, providerId, model) => isModelVisible(
      getModelVisibilityOverride(agent, providerId, model.id), model.defaultEnabled),
  }) };
  return { ...latest, value, defaults: value };
}

export async function writeBotModelChainSettings(
  modelChain: unknown,
  options?: { rootPath?: string },
): Promise<OverrideSettingsState<BotModelChainSettings>> {
  const normalized = normalizeBotModelChain(modelChain);
  if (normalized.length === 0) throw new Error('Bot model chain must contain at least one route');
  const store = currentStore(options?.rootPath);
  await store.writePatchAtomic({ modelChain: normalized }, { preserveDefaults: true });
  log.info('Bot model chain setting written', { routeCount: normalized.length });
  return store.readState();
}

/** Clear only the current owner's global override, then use the normal default resolver. */
export async function resetBotModelChainSettings(
  options?: Parameters<typeof readBotModelChainSettingsState>[0],
): Promise<OverrideSettingsState<BotModelChainSettings>> {
  const owner = activeOwnerScopeKey();
  await currentStore(options?.rootPath).resetAtomic();
  if (!options?.rootPath && activeOwnerScopeKey() !== owner) {
    throw new Error('Bot model settings owner changed');
  }
  return readBotModelChainSettingsState(options);
}

/**
 * A null override means the permanent Bot Profile follows the owner-scoped
 * global route chain. Explicit per-Bot chains remain frozen in its profile.
 */
export async function readEffectiveBotModelSelection(
  config: Record<string, unknown>,
  options?: Parameters<typeof readBotModelChainSettingsState>[0],
): Promise<{ chain: BotModelRoute[]; followsCindyDefault: boolean }> {
  if (Array.isArray(config.modelChainOverride)) {
    const explicit = normalizeBotModelChain(config.modelChainOverride);
    if (explicit.length > 0) return { chain: explicit, followsCindyDefault: false };
  }
  // Preserve old explicit routes; null is the durable follow-default marker.
  if (config.modelChainOverride !== null && config.modelOverride !== null) {
    const legacy = normalizeBotModelChain(config.modelChain, config);
    if (legacy.length || typeof config.model === 'string') return { chain: legacy, followsCindyDefault: false };
  }
  const state = await readBotModelChainSettingsState(options);
  return { chain: state.value.modelChain, followsCindyDefault: !state.isCustomized };
}

export async function readEffectiveBotModelChain(
  config: Record<string, unknown>,
  options?: Parameters<typeof readBotModelChainSettingsState>[0],
): Promise<BotModelRoute[]> {
  return (await readEffectiveBotModelSelection(config, options)).chain;
}
