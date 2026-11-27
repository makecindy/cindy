import { app } from 'electron';
import path from 'node:path';
import {
  isCindyAutoModelId,
  isModelVisible,
  movedCindyAutoSourceId,
  type ProviderView,
} from '@cindy/model-providers';
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
import { readModelGroupsConfig, readModelGroupsConfigForSelected } from '../model-groups/store.js';
import { modelGroupsConfigForRemote, type ModelGroupsConfig } from '../../shared/modelGroups.js';

import { inspectSettingsFile, isSettingsObject, validateOptionalSettingsFields } from './settings-inspection.js';

const log = desktopMakerLogger.child('bot-model-chain-settings-store');

/** 只取保存的链；缺少 override 时保留存储默认 []，不求解依赖凭据的运行时链。 */
export function inspectBotModelChainSettings(ownerRoot: string) {
  return inspectSettingsFile({ filePath: () => settingsFilePath(ownerRoot), defaults: DEFAULTS, normalize,
    validate: (raw) => validateOptionalSettingsFields(raw, {
      modelChain: (value) => Array.isArray(value) && value.every((route) => {
        if (!isSettingsObject(route) || typeof route.model !== 'string' || !route.model.trim()) return false;
        try {
          validateOptionalSettingsFields(route, {
            harness: (v) => v === 'claude' || v === 'codex' || v === 'pi',
            providerId: (v) => v === null || typeof v === 'string',
            effort: (v) => typeof v === 'string', fastMode: (v) => typeof v === 'boolean',
          });
          return true;
        } catch { return false; }
      }),
    }),
  });
}

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
  options?: { rootPath?: string; providers?: readonly ProviderView[]; availableAgents?: ReadonlySet<'cc' | 'codex' | 'pi'> },
): Promise<BotModelChainSettings> {
  return (await readBotModelChainSettingsState(options)).value;
}

export async function readBotModelChainSettingsState(
  options?: { rootPath?: string; providers?: readonly ProviderView[]; availableAgents?: ReadonlySet<'cc' | 'codex' | 'pi'> },
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

/** Read only Profile-owned routes; null means resolving this profile needs owner settings. */
export function readExplicitBotModelChain(config: Record<string, unknown>): BotModelRoute[] | null {
  if (Array.isArray(config.modelChainOverride)) {
    const explicit = normalizeBotModelChain(config.modelChainOverride);
    if (explicit.length > 0) return explicit;
  }
  // Preserve old explicit routes; null is the durable follow-default marker.
  if (config.modelChainOverride !== null && config.modelOverride !== null) {
    const legacy = normalizeBotModelChain(config.modelChain, config);
    if (legacy.length || typeof config.model === 'string') return legacy;
  }
  return null;
}

/**
 * 保存下来的 Auto 路由在使用时跟随服务端：Auto 被挪到另一家 Cindy 来源后改用新来源，
 * 不改写伙伴资料或设置里存的值。目录读不到时原样返回，交给既有的路由校验。
 */
async function followMovedCindyAuto(
  chain: BotModelRoute[],
  providers: readonly ProviderView[] | undefined,
): Promise<BotModelRoute[]> {
  // 预设 auto 只在 Cindy AI 上、不会被挪动；只有模型组 Auto 才值得为此读一次目录。
  if (!chain.some((route) => route.harness !== 'acp' && !route.agentDeviceId && route.model !== 'auto' && isCindyAutoModelId(route.model)))
    return chain;
  let views = providers;
  if (!views) {
    const owner = activeOwnerScopeKey();
    try {
      views = await readConnectedProviders(owner);
    } catch (error) {
      if (activeOwnerScopeKey() !== owner) throw new Error('Bot model chain owner changed');
      log.warn('Bot model chain Auto follow skipped: providers unavailable', {
        error: error instanceof Error ? error.message : String(error),
      });
      return chain;
    }
    if (activeOwnerScopeKey() !== owner) throw new Error('Bot model chain owner changed');
  }
  const catalog = views;
  return chain.map((route) => {
    if (route.agentDeviceId || route.harness === 'acp') return route;
    const providerId = movedCindyAutoSourceId(catalog, {
      agent: route.harness === 'claude' ? 'claude-code' : route.harness,
      model: route.model,
      providerId: route.providerId,
    });
    return providerId ? { ...route, providerId } : route;
  });
}

/** A null override follows owner settings; explicit per-Bot routes stay in its Profile. */
export async function readEffectiveBotModelSelection(
  config: Record<string, unknown>,
  options?: Parameters<typeof readBotModelChainSettingsState>[0],
): Promise<{ chain: BotModelRoute[]; followsCindyDefault: boolean }> {
  const explicit = readExplicitBotModelChain(config);
  if (explicit !== null) {
    return {
      chain: await followMovedCindyAuto(explicit, options?.providers),
      followsCindyDefault: false,
    };
  }
  const state = await readBotModelChainSettingsState(options);
  // 未自定义的伙伴默认由实时目录推导，已经是当前位置；只有用户自定义的设置是存下来的。
  const chain = state.isCustomized
    ? await followMovedCindyAuto(state.value.modelChain, options?.providers)
    : state.value.modelChain;
  return { chain, followsCindyDefault: !state.isCustomized };
}

export async function readEffectiveBotModelChain(
  config: Record<string, unknown>,
  options?: Parameters<typeof readBotModelChainSettingsState>[0],
): Promise<BotModelRoute[]> {
  return (await readEffectiveBotModelSelection(config, options)).chain;
}

/**
 * 模型组此刻会选的来源(只看不记，不推进「轮流」)；组用不了为 null。由 maker-ipc 注入，
 * 这里不直接依赖选路模块。未注入时按存下的模型。
 */
type BotModelGroupPreview = (groupId: string) => Promise<BotModelRoute | null>;
let previewModelGroup: BotModelGroupPreview | null = null;

export function setBotModelGroupPreview(next: BotModelGroupPreview | null): void {
  previewModelGroup = next;
}

/**
 * 新建伙伴对话用的首选模型(model-groups.md §6.2)：首选是模型组时取组此刻会选的来源，用不了才是存下的具体模型，
 * 这样存下的模型后来断开、组里还有能用的来源时，新对话不会被模型准入挡住。之后由套用流程按组的规则正式选一次。
 */
export async function readEffectiveBotPrimaryRoute(
  config: Record<string, unknown>,
  options?: Parameters<typeof readBotModelChainSettingsState>[0],
): Promise<BotModelRoute | null> {
  const [primary] = await readEffectiveBotModelChain(config, options);
  if (!primary?.modelGroup || !previewModelGroup) return primary ?? null;
  const picked = await previewModelGroup(primary.modelGroup).catch((error: unknown) => {
    log.warn('Bot model group preview failed; using the saved model', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  });
  return picked ? { ...picked, modelGroup: primary.modelGroup } : primary;
}

/**
 * 这台电脑的模型组，给远程控制它的手机与电脑在伙伴模型设置里选(model-groups.md §6.2)。
 * 只有来源的供应商连接 id 与模型 id，与同账号可读的模型目录同一层级，不含凭证。
 */
export function listBotModelGroupsForRemote(): ModelGroupsConfig {
  return modelGroupsConfigForRemote(readModelGroupsConfig());
}

/**
 * 远程保存或新建伙伴时补全模型组项(model-groups.md §6.2)：控制端只记下了组，这里把存下的具体模型换成组此刻会选的来源；
 * 这台电脑上没有这个组时去掉组、按控制端带来的具体模型；组暂时用不了时保留原来的具体模型。
 */
export async function fillBotModelGroupRoutes(chain: readonly BotModelRoute[]): Promise<BotModelRoute[]> {
  const config = readModelGroupsConfigForSelected();
  return Promise.all(chain.map(async (route) => {
    if (!route.modelGroup) return route;
    if (!config.routes.some((group) => group.id === route.modelGroup)) {
      const { modelGroup: _missing, ...plain } = route;
      return plain;
    }
    const picked = previewModelGroup ? await previewModelGroup(route.modelGroup).catch(() => null) : null;
    return picked ? { ...picked, modelGroup: route.modelGroup } : route;
  }));
}
