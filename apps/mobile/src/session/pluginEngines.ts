/**
 * 插件提供的执行引擎(Desktop docs/plans/acp-plugin-bridge.md)在手机上的视图与规则。
 *
 * 引擎只在装了插件的那台电脑上运行：手机经 device-link 的 `maker:list-plugin-engines` 读那台的引擎
 * 列表(名称、图标、模型、思考深度、工作模式)，在那台新建任务或把任务换到 / 换出插件引擎。
 * 插件引擎任务存为 `agent_kind = 'acp'`、`providerId = acp-plugin:<插件>:<引擎>`。
 *
 * 规则与 Desktop 相同：
 * - 只在被控电脑本机运行：SSH、Agent 在另一台电脑、协同、IM、伙伴、定时、共享任务不提供。
 * - 模型是引擎自己的取值，`default` = 让引擎自己选；思考深度只认该模型列出的档位；没有 Fast、计划模式。
 * - 权限模式取引擎提供的那几档，否则用该引擎的默认档(新任务起始档)。
 * - 旧电脑不认识这个 channel(CHANNEL_NOT_ALLOWED)时按「没有插件引擎」处理，手机不会发出 'acp'。
 *
 * 列表按电脑缓存在内存里：打开模型选择器时读一次并请那台的插件重新上报模型，不轮询。
 */
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { createPluginHarnessUsageReader } from '@cindy/plugin-protocol';

import type { MobileAgentCapabilities, MobileChoiceOption, MobileModelOption } from '@cindy/maker-shared/agent-capabilities';

import { getMobileAuthOwner, isMobileAuthOwnerCurrent, subscribeMobileAuthOwner } from '@/auth/authOwnerGeneration';

export const PLUGIN_ENGINE_AGENT_KIND = 'acp' as const;
export const PLUGIN_ENGINE_PROVIDER_PREFIX = 'acp-plugin:';
/** 让引擎自己选模型的取值(引擎还没上报模型前只有这一项)。 */
export const PLUGIN_ENGINE_DEFAULT_MODEL = 'default';
/** 插件引擎可声明的思考深度(Cindy 档位 id，低 → 高)。 */
export const PLUGIN_ENGINE_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type PluginEngineEffort = (typeof PLUGIN_ENGINE_EFFORTS)[number];

export interface MobilePluginEngineModel {
  id: string;
  displayName: string;
  description?: string;
  efforts: PluginEngineEffort[];
  defaultEffort?: PluginEngineEffort;
}

export interface MobilePluginEngine {
  key: string;
  reportsUsage?: true;
  /** 任务的 providerId：`acp-plugin:<key>`。 */
  providerId: string;
  name: string;
  description?: string;
  /** 插件图标(data URL)；缺省 = 通用引擎标识。 */
  iconDataUrl?: string;
  availability: { state: 'available' | 'unavailable' | 'unknown'; message?: string };
  models: MobilePluginEngineModel[];
  permissionModes: { id: string; displayName: string }[];
  defaultPermissionMode: string;
}

/** 已建任务下一条消息要切到的插件引擎(desktop 意图投影 targetAgentKind = 'acp')。 */
export interface MobilePluginEngineSwitchIntent {
  providerId: string;
  model: string;
  effort?: string;
}

/** 选择器里选中的插件引擎行。 */
export interface MobilePluginEngineSelection {
  providerId: string;
  modelId: string;
  effort?: PluginEngineEffort;
}

export function isPluginEngineEffort(value: unknown): value is PluginEngineEffort {
  return typeof value === 'string' && (PLUGIN_ENGINE_EFFORTS as readonly string[]).includes(value);
}

/** `acp-plugin:<插件>:<引擎>` 才是插件引擎标识。 */
export function isPluginEngineProviderId(providerId: unknown): providerId is string {
  if (typeof providerId !== 'string' || !providerId.startsWith(PLUGIN_ENGINE_PROVIDER_PREFIX)) return false;
  const key = providerId.slice(PLUGIN_ENGINE_PROVIDER_PREFIX.length);
  const separator = key.lastIndexOf(':');
  return separator > 0 && separator < key.length - 1;
}

/** sessions.agent_kind 是否为插件引擎任务(RemoteSession.agentKind 的类型只列内置值，运行时可能是 'acp')。 */
export function isPluginEngineSessionKind(agentKind: unknown): boolean {
  return agentKind === PLUGIN_ENGINE_AGENT_KIND;
}

const MAX_ENGINES = 32;
const MAX_MODELS = 200;
const MAX_PERMISSION_MODES = 16;

function text(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

function normalizeModel(raw: unknown): MobilePluginEngineModel | null {
  if (!raw || typeof raw !== 'object') return null;
  const item = raw as Record<string, unknown>;
  const { id } = item;
  // IDs are protocol values. Apply the host's size bound without trimming or shortening them.
  if (typeof id !== 'string' || id.length > 256 || !id.trim()) return null;
  const efforts = Array.isArray(item.efforts)
    ? PLUGIN_ENGINE_EFFORTS.filter((effort) => (item.efforts as unknown[]).includes(effort))
    : [];
  const defaultEffort = isPluginEngineEffort(item.defaultEffort) && efforts.includes(item.defaultEffort)
    ? item.defaultEffort
    : undefined;
  const description = text(item.description, 200);
  return {
    id,
    displayName: text(item.displayName, 200) ?? id.slice(0, 200),
    ...(description ? { description } : {}),
    efforts,
    ...(defaultEffort ? { defaultEffort } : {}),
  };
}

/** device-link 回包不可信：只保留认识的字段，形状不对的引擎整项丢弃。 */
export function normalizePluginEngines(raw: unknown): MobilePluginEngine[] {
  if (!Array.isArray(raw)) return [];
  const engines: MobilePluginEngine[] = [];
  for (const value of raw.slice(0, MAX_ENGINES)) {
    if (!value || typeof value !== 'object') continue;
    const item = value as Record<string, unknown>;
    const providerId = typeof item.providerId === 'string' ? item.providerId : '';
    const name = text(item.name, 64);
    if (!isPluginEngineProviderId(providerId) || !name) continue;
    if (engines.some((engine) => engine.providerId === providerId)) continue;
    const availability = item.availability && typeof item.availability === 'object'
      ? item.availability as Record<string, unknown>
      : {};
    const state = availability.state === 'available' || availability.state === 'unavailable'
      ? availability.state
      : 'unknown';
    const message = text(availability.message, 200);
    const models = Array.isArray(item.models)
      ? item.models.slice(0, MAX_MODELS).map(normalizeModel).filter((model): model is MobilePluginEngineModel => !!model)
      : [];
    const permissionModes = Array.isArray(item.permissionModes)
      ? item.permissionModes.slice(0, MAX_PERMISSION_MODES).flatMap((mode) => {
          if (!mode || typeof mode !== 'object') return [];
          const id = text((mode as Record<string, unknown>).id, 64);
          if (!id) return [];
          return [{ id, displayName: text((mode as Record<string, unknown>).displayName, 64) ?? id }];
        })
      : [];
    const fallbackModes = [{ id: 'ask', displayName: 'Ask' }, { id: 'bypassPermissions', displayName: 'Allow all' }];
    const modes = permissionModes.length ? permissionModes : fallbackModes;
    const requestedDefault = text(item.defaultPermissionMode, 64);
    const iconDataUrl = typeof item.iconDataUrl === 'string' && item.iconDataUrl.startsWith('data:image/')
      ? item.iconDataUrl
      : undefined;
    const description = text(item.description, 200);
    engines.push({
      key: providerId.slice(PLUGIN_ENGINE_PROVIDER_PREFIX.length),
      ...(item.reportsUsage === true ? { reportsUsage: true as const } : {}),
      providerId,
      name,
      ...(description ? { description } : {}),
      ...(iconDataUrl ? { iconDataUrl } : {}),
      availability: { state, ...(message ? { message } : {}) },
      models,
      permissionModes: modes,
      defaultPermissionMode: requestedDefault && modes.some((mode) => mode.id === requestedDefault)
        ? requestedDefault
        : modes[0]!.id,
    });
  }
  return engines;
}

export function findPluginEngine(
  engines: readonly MobilePluginEngine[],
  providerId: string | null | undefined,
): MobilePluginEngine | null {
  return providerId ? engines.find((engine) => engine.providerId === providerId) ?? null : null;
}

/** 'unknown' = 插件从没上报状态：可选，启动失败由任务自己报告(与 Desktop 相同)。 */
export function isPluginEngineSelectable(engine: Pick<MobilePluginEngine, 'availability'>): boolean {
  return engine.availability.state !== 'unavailable';
}

/** 引擎下列出的模型行：上报过的模型，或在还没上报时只有「默认模型」一项；当前选的是默认时它也保留。 */
export function pluginEngineModelRows(
  engine: Pick<MobilePluginEngine, 'models'>,
  activeModelId?: string | null,
): (MobilePluginEngineModel & { isDefault: boolean })[] {
  const models = engine.models.map((model) => ({ ...model, isDefault: false }));
  const defaultRow = { id: PLUGIN_ENGINE_DEFAULT_MODEL, displayName: '', efforts: [], isDefault: true };
  if (models.length === 0) return [defaultRow];
  return activeModelId === PLUGIN_ENGINE_DEFAULT_MODEL ? [defaultRow, ...models] : models;
}

/** 该模型实际使用的思考深度：选中的档位在它列出的档位里就用，否则用它的默认档；没有档位为 null。 */
export function resolvePluginEngineEffort(
  engine: Pick<MobilePluginEngine, 'models'> | null | undefined,
  modelId: string | null | undefined,
  requested: unknown,
): PluginEngineEffort | null {
  const model = engine?.models.find((item) => item.id === modelId);
  const offered = model?.efforts ?? [];
  if (isPluginEngineEffort(requested) && offered.includes(requested)) return requested;
  return model?.defaultEffort && offered.includes(model.defaultEffort) ? model.defaultEffort : null;
}

/** 插件引擎任务的权限模式：引擎提供的那一档，否则用引擎的默认档；引擎已不在时只保留「全部允许」。 */
export function pluginEnginePermissionMode(
  mode: string | null | undefined,
  engine: Pick<MobilePluginEngine, 'permissionModes' | 'defaultPermissionMode'> | null | undefined,
): string {
  if (engine) {
    return engine.permissionModes.some((option) => option.id === mode) ? mode! : engine.defaultPermissionMode;
  }
  return mode === 'bypassPermissions' ? 'bypassPermissions' : 'ask';
}

/** 模型在该引擎下的显示名；默认项或不认识的 id 返回 undefined(调用方用本地化的「默认模型」等)。 */
export function pluginEngineModelName(
  engine: Pick<MobilePluginEngine, 'models'> | null | undefined,
  modelId: string | null | undefined,
): string | undefined {
  if (!engine || !modelId || modelId === PLUGIN_ENGINE_DEFAULT_MODEL) return undefined;
  return engine.models.find((model) => model.id === modelId)?.displayName;
}

/**
 * 新建插件引擎任务时 maker:create-session 的引擎字段(Desktop 只接受带 acp-plugin: 标识、
 * 不带远程字段的 'acp')。
 */
export function pluginEngineCreateSessionFields(
  engine: MobilePluginEngine,
  selection: { modelId: string; effort?: string | null; permissionMode?: string | null },
): { agentKind: typeof PLUGIN_ENGINE_AGENT_KIND; providerId: string; model: string; effort: string; permissionMode: string; fastMode: false } {
  const model = selection.modelId || PLUGIN_ENGINE_DEFAULT_MODEL;
  return {
    agentKind: PLUGIN_ENGINE_AGENT_KIND,
    providerId: engine.providerId,
    model,
    effort: resolvePluginEngineEffort(engine, model, selection.effort) ?? '',
    permissionMode: pluginEnginePermissionMode(selection.permissionMode, engine),
    fastMode: false,
  };
}

/**
 * 插件引擎任务的能力视图：主机级开关(能否切换引擎等)沿用被控电脑上报的那份，模型、思考深度与
 * 权限模式换成引擎自己的；插件引擎没有 Fast 与计划模式。
 */
export function pluginEngineSessionCapabilities(
  host: MobileAgentCapabilities | null,
  engine: MobilePluginEngine | null,
  labels: { defaultModel: string; effort(id: PluginEngineEffort): string },
): MobileAgentCapabilities {
  const rows = engine ? pluginEngineModelRows(engine) : [{
    id: PLUGIN_ENGINE_DEFAULT_MODEL, displayName: '', efforts: [] as PluginEngineEffort[], isDefault: true,
  }];
  const availableModels: MobileModelOption[] = rows.map((row) => ({
    id: row.id,
    label: row.isDefault ? labels.defaultModel : row.displayName,
    ...(row.description ? { description: row.description } : {}),
    efforts: [...row.efforts],
    effortDisplayNames: Object.fromEntries(row.efforts.map((effort) => [effort, labels.effort(effort)])),
    defaultEffort: row.defaultEffort ?? null,
    supportsFastMode: false,
  }));
  const effortLevels: MobileChoiceOption[] = PLUGIN_ENGINE_EFFORTS
    .filter((effort) => rows.some((row) => row.efforts.includes(effort)))
    .map((effort) => ({ id: effort, label: labels.effort(effort) }));
  const permissionModes: MobileChoiceOption[] = (engine?.permissionModes ?? [
    { id: 'ask', displayName: 'Ask' },
    { id: 'bypassPermissions', displayName: 'Allow all' },
  ]).map((mode) => ({ id: mode.id, label: mode.displayName }));
  return {
    ...(host ?? {}),
    availableModels,
    effortLevels,
    permissionModes,
    hasFastMode: false,
    planModeSupported: false,
  };
}

/** desktop 意图投影里的插件引擎意图；不是插件引擎、或没有引擎标识时返回 null。 */
export function normalizePluginEngineSwitchIntent(value: unknown): MobilePluginEngineSwitchIntent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (item.targetAgentKind !== PLUGIN_ENGINE_AGENT_KIND) return null;
  if (!isPluginEngineProviderId(item.providerId)) return null;
  if (typeof item.model !== 'string' || item.model.length === 0) return null;
  return {
    providerId: item.providerId,
    model: item.model,
    ...(typeof item.effort === 'string' && item.effort ? { effort: item.effort } : {}),
  };
}

// —— 模型选择器里的插件引擎分组 ——

export interface UnifiedMobilePluginEngineRow {
  key: string;
  providerId: string;
  modelId: string;
  title: string;
  subtitle?: string;
  /** 引擎不可用时插件给的说明。 */
  notice?: string;
  iconDataUrl?: string;
  /** 这一行将使用的思考深度(没有可选档位时为 null)。 */
  effort: PluginEngineEffort | null;
  efforts: PluginEngineEffort[];
  effortLabel: string;
  selected: boolean;
  disabled: boolean;
}

export interface UnifiedMobilePluginEngineGroup {
  key: string;
  title: string;
  rows: UnifiedMobilePluginEngineRow[];
}

/** 插件引擎分组：引擎名命中搜索时整组列出，否则只列命中的模型；不可用的引擎可见但不能选。 */
export function buildPluginEngineGroups(
  options: { engines: readonly MobilePluginEngine[]; active: MobilePluginEngineSelection | null },
  query: string,
  labels: {
    defaultModel: string;
    effort(id: PluginEngineEffort): string;
    unavailable(name: string, hint?: string): string;
  },
): UnifiedMobilePluginEngineGroup[] {
  const needle = query.trim().toLowerCase();
  const groups: UnifiedMobilePluginEngineGroup[] = [];
  for (const engine of options.engines) {
    const selectable = isPluginEngineSelectable(engine);
    const active = options.active?.providerId === engine.providerId ? options.active : null;
    const engineMatches = !needle || engine.name.toLowerCase().includes(needle);
    const rows = pluginEngineModelRows(engine, active?.modelId)
      .filter((model) => engineMatches
        || [model.isDefault ? labels.defaultModel : model.displayName, model.description]
          .some((text) => text?.toLowerCase().includes(needle)))
      .map((model): UnifiedMobilePluginEngineRow => {
        const selected = !!active && active.modelId === model.id;
        const effort = resolvePluginEngineEffort(engine, model.id, selected ? active?.effort : undefined);
        return {
          key: `${engine.providerId}#${model.id}`,
          providerId: engine.providerId,
          modelId: model.id,
          title: model.isDefault ? labels.defaultModel : model.displayName,
          ...(model.description ? { subtitle: model.description } : {}),
          ...(!selectable ? { notice: labels.unavailable(engine.name, engine.availability.message) } : {}),
          ...(engine.iconDataUrl ? { iconDataUrl: engine.iconDataUrl } : {}),
          effort,
          efforts: [...model.efforts],
          effortLabel: effort ? labels.effort(effort) : '',
          selected,
          disabled: !selectable,
        };
      });
    if (rows.length) groups.push({ key: `plugin-engine:${engine.providerId}`, title: engine.name, rows });
  }
  return groups;
}

// —— 按电脑缓存的引擎列表 ——

interface CacheEntry {
  engines: MobilePluginEngine[];
  /** 这台电脑支持这个 channel(读到过列表，哪怕是空的)。 */
  supported: boolean;
}

const EMPTY_ENGINES: MobilePluginEngine[] = [];
const EMPTY_ENTRY: CacheEntry = { engines: EMPTY_ENGINES, supported: false };
const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();
let version = 0;

function publish(): void {
  version += 1;
  for (const listener of listeners) listener();
}

function sameEngines(a: readonly MobilePluginEngine[], b: readonly MobilePluginEngine[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export const pluginUsageReader = createPluginHarnessUsageReader();

/** 读到的列表写进缓存；内容没变不通知。 */
export function setCachedPluginEngines(deviceId: string, engines: MobilePluginEngine[], supported: boolean): void {
  const previous = cache.get(deviceId);
  if (previous && previous.supported === supported && sameEngines(previous.engines, engines)) return;
  pluginUsageReader.retainReportingEngines(getMobileAuthOwner(), deviceId, supported ? engines : []);
  cache.set(deviceId, { engines: engines.length ? engines : EMPTY_ENGINES, supported });
  publish();
}

export function getCachedPluginEngines(deviceId: string | null | undefined): readonly MobilePluginEngine[] {
  return (deviceId ? cache.get(deviceId)?.engines : undefined) ?? EMPTY_ENGINES;
}

/** 退出账号 / 切换账号时清掉，不把上一个账号的电脑引擎带过去。 */
export function clearPluginEngineCache(): void {
  lastRefreshAt.clear();
  inFlight.clear();
  if (cache.size === 0) return;
  cache.clear();
  publish();
}

export interface PluginEngineReader {
  listPluginEngines(): Promise<MobilePluginEngine[]>;
  refreshPluginEngines(): Promise<void>;
}

/** 同一台电脑并发只读一次；临时断开时保留最后一次读到的引擎。 */
export function loadPluginEngines(deviceId: string, reader: PluginEngineReader): Promise<void> {
  ensureOwnerSubscription();
  const owner = getMobileAuthOwner();
  if (!owner.accountId) return Promise.resolve();
  const existing = inFlight.get(deviceId);
  if (existing) return existing;
  const run = reader.listPluginEngines()
    .then((engines) => {
      if (isMobileAuthOwnerCurrent(owner)) setCachedPluginEngines(deviceId, engines, true);
    })
    .catch(() => {
      // 旧电脑没有这个 channel，或读失败：保留已读到的列表，从没读到时就是空列表。
      if (isMobileAuthOwnerCurrent(owner) && !cache.has(deviceId)) {
        setCachedPluginEngines(deviceId, [], false);
      }
    })
    .finally(() => {
      if (inFlight.get(deviceId) === run) inFlight.delete(deviceId);
    });
  inFlight.set(deviceId, run);
  return run;
}

/** Lists with plugin tasks share one initial catalogue read per device. */
export function prefetchPluginEngineIcons(deviceId: string, reader: PluginEngineReader): Promise<void> {
  return getCachedPluginEngines(deviceId).length ? Promise.resolve() : loadPluginEngines(deviceId, reader);
}

/** 插件重新上报模型需要一点时间：请求后只再读一次，不轮询。 */
const REFRESH_REREAD_DELAY_MS = 2500;
const lastRefreshAt = new Map<string, number>();
const REFRESH_MIN_INTERVAL_MS = 60_000;
// 账号变了：缓存里是上一个账号的电脑，整份丢掉(第一次读列表时才订阅)。
let ownerSubscribed = false;
function ensureOwnerSubscription(): void {
  if (ownerSubscribed) return;
  ownerSubscribed = true;
  subscribeMobileAuthOwner(clearPluginEngineCache);
}

/** 模型选择器打开：读当前列表，并请那台电脑的插件重新上报模型(那台按插件冷却)。 */
export function refreshPluginEnginesForPicker(deviceId: string, reader: PluginEngineReader, now = Date.now()): void {
  const owner = getMobileAuthOwner();
  void loadPluginEngines(deviceId, reader).then(() => {
    if (!isMobileAuthOwnerCurrent(owner) || !cache.get(deviceId)?.engines.length) return;
    const last = lastRefreshAt.get(deviceId) ?? 0;
    if (now - last < REFRESH_MIN_INTERVAL_MS) return;
    lastRefreshAt.set(deviceId, now);
    void reader.refreshPluginEngines().catch(() => undefined);
    setTimeout(() => {
      if (isMobileAuthOwnerCurrent(owner)) void loadPluginEngines(deviceId, reader);
    }, REFRESH_REREAD_DELAY_MS);
  });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function getVersion(): number {
  return version;
}

/** Until a computer's catalogue is known, its usage endpoint can still answer directly. */
export function usePluginEngineUsageSupport(deviceId: string, providerId: string | null | undefined) {
  const snapshot = () => {
    const entry = cache.get(deviceId);
    if (!providerId || !entry?.supported) return undefined;
    return findPluginEngine(entry.engines, providerId)?.reportsUsage === true;
  };
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/**
 * 某台电脑的插件引擎列表。enabled 为 false(远程 SSH、另一台电脑上的 Agent 等)时返回空列表且不读。
 * 挂载时读一次；`refresh` 给模型选择器打开时用。
 */
export function usePluginEngines(
  reader: PluginEngineReader | null,
  deviceId: string | null | undefined,
  enabled: boolean,
): { engines: readonly MobilePluginEngine[]; refresh(): void } {
  useSyncExternalStore(subscribe, getVersion, getVersion);
  const active = enabled && !!deviceId && !!reader;
  useEffect(() => {
    if (!active || cache.has(deviceId!)) return;
    void loadPluginEngines(deviceId!, reader!);
  }, [active, deviceId, reader]);
  const refresh = useCallback(() => {
    if (active) refreshPluginEnginesForPicker(deviceId!, reader!);
  }, [active, deviceId, reader]);
  return { engines: active ? getCachedPluginEngines(deviceId) : EMPTY_ENGINES, refresh };
}

/** 任务列表等只读场景：已读到过的引擎(没读到过返回 null，调用方显示通用引擎标识)。 */
export function usePluginEngineFor(
  deviceId: string | null | undefined,
  providerId: string | null | undefined,
): MobilePluginEngine | null {
  useSyncExternalStore(subscribe, getVersion, getVersion);
  return findPluginEngine(getCachedPluginEngines(deviceId), providerId);
}
