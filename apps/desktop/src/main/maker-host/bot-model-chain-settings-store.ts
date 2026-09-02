import { app } from 'electron';
import path from 'node:path';

import {
  NEW_BOT_DEFAULT_HARNESS,
  NEW_BOT_DEFAULT_PI_EFFORT,
  NEW_BOT_DEFAULT_PI_MODEL,
  NEW_BOT_DEFAULT_PI_PROVIDER,
} from '../../shared/botDefaults.js';
import {
  normalizeBotModelChain,
  type BotModelRoute,
} from '../../shared/botModelChain.js';
import { getActiveAppSession, ownerScopedUserDataPath } from '../appSessionState.js';
import { desktopMakerLogger } from './logger-adapter.js';
import {
  createOverrideSettingsFile,
  type OverrideSettingsState,
} from './override-settings-file.js';

const log = desktopMakerLogger.child('bot-model-chain-settings-store');

export interface BotModelChainSettings {
  modelChain: BotModelRoute[];
}

const DEFAULT_MODEL_CHAIN: BotModelRoute[] = [{
  harness: NEW_BOT_DEFAULT_HARNESS,
  model: NEW_BOT_DEFAULT_PI_MODEL,
  providerId: NEW_BOT_DEFAULT_PI_PROVIDER,
  effort: NEW_BOT_DEFAULT_PI_EFFORT,
  fastMode: false,
}];

const DEFAULTS: BotModelChainSettings = { modelChain: DEFAULT_MODEL_CHAIN };

function normalize(raw: unknown): BotModelChainSettings {
  const record = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};
  const modelChain = normalizeBotModelChain(record.modelChain);
  return { modelChain: modelChain.length > 0 ? modelChain : DEFAULT_MODEL_CHAIN };
}

function settingsFilePath(rootPath?: string): string {
  return path.join(rootPath ?? app.getPath('userData'), 'bot-model-chain-settings.json');
}

const stores = new Map<
  string,
  ReturnType<typeof createOverrideSettingsFile<BotModelChainSettings>>
>();

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
        : () => getActiveAppSession().dataOwnerId ?? '<global>',
    });
    stores.set(key, current);
  }
  return current;
}

export function readBotModelChainSettings(
  options?: { rootPath?: string },
): BotModelChainSettings {
  const store = currentStore(options?.rootPath);
  store.invalidateIfChanged();
  return store.read();
}

export function readBotModelChainSettingsState(
  options?: { rootPath?: string },
): OverrideSettingsState<BotModelChainSettings> {
  const store = currentStore(options?.rootPath);
  store.invalidateIfChanged();
  return store.readState();
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

/**
 * A null override means the permanent Bot Profile follows the owner-scoped
 * global route chain. Explicit per-Bot chains remain frozen in its profile.
 */
export function readEffectiveBotModelChain(
  config: Record<string, unknown>,
  options?: { rootPath?: string },
): BotModelRoute[] {
  if (Array.isArray(config.modelChainOverride)) {
    const explicit = normalizeBotModelChain(config.modelChainOverride);
    if (explicit.length > 0) return explicit;
  }
  // Before modelChainOverride existed, modelOverride:null was the durable
  // marker for “follow the Bot default”. Preserve that meaning on upgrade.
  if (config.modelChainOverride === null || config.modelOverride === null) {
    return readBotModelChainSettings(options).modelChain;
  }
  return normalizeBotModelChain(config.modelChain, config);
}
