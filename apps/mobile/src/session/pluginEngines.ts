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
import { ANTIGRAVITY_MARK_DATA_URL, isAntigravityEngine } from '@cindy/maker-shared/branding';
import {
  isSharedTaskPeer,
  parseAgentDeviceFavoriteSource,
  parseProviderShareFavoriteSource,
  providerShareFavoriteWireKey,
  type ProviderShareFavoriteSource,
} from '@cindy/device-link';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { buildPluginEngineUsagePresentation, matchPluginEngineQuotaGroup } from '@cindy/maker-shared/plugin-engine-usage';
import type { QuotaLevel } from '@cindy/maker-shared/quota-level';
import { resolvePermissionModeForOptions } from '@cindy/maker-shared/permission-mode';
import { createPluginHarnessUsageReader, type GhostHarnessUsage } from '@cindy/plugin-protocol';

import type { MobileAgentCapabilities, MobileChoiceOption, MobileModelOption } from '@cindy/maker-shared/agent-capabilities';

import { getMobileAuthOwner, isMobileAuthOwnerCurrent, subscribeMobileAuthOwner } from '@/auth/authOwnerGeneration';
import type { RemoteInvoke } from '@/device-link/mobileMakerTransport';
import { isProviderShareAgentDeviceId } from './providerShareAgentDevice';
import type { RemoteAgentCatalog } from './remoteAgentCatalogs';
import type { MobileModelFavorite } from './unifiedMobileModels';

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
  /**
   * 用户在那台电脑的「设置 → 模型供应商」里把它从模型选择器中隐藏了：选择器不再列出，已经在用它的任务
   * 照常显示名字、图标和用量。旧电脑不带这个字段。用户在那里停用的引擎由那台电脑报成 unavailable。
   */
  hidden?: true;
  defaultModelAllowed?: false;
  /** Whether the owning computer opened this engine for remote use / sharing. */
  remoteUse?: { supported: boolean; enabled: boolean; shareSupported?: boolean };
  /** Execution computer or share (`share:<shareId>`) when this engine runs outside the task computer. */
  deviceId?: string;
  /** Display name of the remote computer or share. */
  deviceName?: string;
  /** Favorite identity supplied by the task computer for a shared plugin engine. */
  favoriteSource?: ProviderShareFavoriteSource;
  models: MobilePluginEngineModel[];
  permissionModes: { id: string; displayName: string }[];
  defaultPermissionMode: string;
}

/** 已建任务下一条消息要切到的插件引擎(desktop 意图投影 targetAgentKind = 'acp')。 */
export interface MobilePluginEngineSwitchIntent {
  providerId: string;
  model: string;
  effort?: string;
  /** Null selects the task computer. Omission keeps the current execution computer. */
  agentDeviceId?: string | null;
}

/** 选择器里选中的插件引擎行。 */
export interface MobilePluginEngineSelection {
  providerId: string;
  modelId: string;
  effort?: PluginEngineEffort;
  /** Execution computer or share id; null / undefined = task computer. */
  deviceId?: string | null;
}

/** Identity of a plugin engine choice inside one picker (same plugin can be installed on several computers). */
export function pluginEngineChoiceKey(choice: { providerId: string; deviceId?: string | null }): string {
  return choice.deviceId ? `${choice.deviceId}\n${choice.providerId}` : choice.providerId;
}

/** Whether two plugin engine selections/entries refer to the same engine on the same computer. */
export function isSamePluginEngineChoice(
  a: { providerId: string; deviceId?: string | null } | null | undefined,
  b: { providerId: string; deviceId?: string | null } | null | undefined,
): boolean {
  return !!a && !!b && a.providerId === b.providerId && (a.deviceId ?? null) === (b.deviceId ?? null);
}

/** Whether another computer's plugin engine is open for remote use right now. */
export function isPluginEngineOfferedRemotely(
  engine: Pick<MobilePluginEngine, 'availability' | 'remoteUse'>,
): boolean {
  return engine.remoteUse?.supported === true
    && engine.remoteUse.enabled === true
    && engine.availability.state !== 'unavailable';
}

/** Stable source-filter id for a local or remote plugin engine in UnifiedModelPickerSheet. */
export function pluginEngineFilterId(providerId: string, deviceId?: string | null): string {
  return deviceId ? `plugin-engine:${JSON.stringify([deviceId, providerId])}` : `plugin-engine:${providerId}`;
}

/** Whether a favorite's stored providerId refers to a local, remote, or shared plugin engine. */
export function isPluginEngineFavoriteProviderId(providerId: unknown): boolean {
  if (typeof providerId !== 'string') return false;
  if (isPluginEngineProviderId(providerId)) return true;
  const agentDevice = parseAgentDeviceFavoriteSource(providerId);
  if (agentDevice && isPluginEngineProviderId(agentDevice.providerId)) return true;
  const share = parseProviderShareFavoriteSource(providerId);
  return !!share && isPluginEngineProviderId(share.providerId);
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
    const fallbackModes = [{ id: 'ask', displayName: 'Default permissions' }, { id: 'bypassPermissions', displayName: 'Full access' }];
    const modes = permissionModes.length ? permissionModes : fallbackModes;
    const requestedDefault = text(item.defaultPermissionMode, 64);
    const ghostId = typeof item.ghostId === 'string' ? item.ghostId : undefined;
    const iconDataUrl = isAntigravityEngine({ ghostId, providerId, name })
      ? ANTIGRAVITY_MARK_DATA_URL
      : typeof item.iconDataUrl === 'string' && item.iconDataUrl.startsWith('data:image/')
      ? item.iconDataUrl
      : undefined;
    const description = text(item.description, 200);
    const rawRemoteUse = item.remoteUse && typeof item.remoteUse === 'object' && !Array.isArray(item.remoteUse)
      ? item.remoteUse as Record<string, unknown>
      : null;
    const remoteUse = rawRemoteUse
      ? {
          supported: rawRemoteUse.supported === true,
          enabled: rawRemoteUse.enabled === true,
          ...(typeof rawRemoteUse.shareSupported === 'boolean'
            ? { shareSupported: rawRemoteUse.shareSupported }
            : {}),
        }
      : undefined;
    engines.push({
      key: providerId.slice(PLUGIN_ENGINE_PROVIDER_PREFIX.length),
      ...(item.reportsUsage === true ? { reportsUsage: true as const } : {}),
      providerId,
      name,
      ...(description ? { description } : {}),
      ...(iconDataUrl ? { iconDataUrl } : {}),
      availability: { state, ...(message ? { message } : {}) },
      ...(item.hidden === true ? { hidden: true as const } : {}),
      ...(item.defaultModelAllowed === false ? { defaultModelAllowed: false as const } : {}),
      ...(remoteUse ? { remoteUse } : {}),
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
  deviceId?: string | null,
): MobilePluginEngine | null {
  if (!providerId) return null;
  if (deviceId !== undefined) {
    return engines.find((engine) => isSamePluginEngineChoice(engine, { providerId, deviceId })) ?? null;
  }
  return engines.find((engine) => engine.providerId === providerId && !engine.deviceId)
    ?? engines.find((engine) => engine.providerId === providerId)
    ?? null;
}

/** 'unknown' = 插件从没上报状态：可选，启动失败由任务自己报告(与 Desktop 相同)。 */
export function isPluginEngineSelectable(engine: Pick<MobilePluginEngine, 'availability'>): boolean {
  return engine.availability.state !== 'unavailable';
}

/** 引擎下列出的模型行：上报过的模型，或在还没上报时只有「默认模型」一项；当前选的是默认时它也保留。 */
export function pluginEngineModelRows(
  engine: Pick<MobilePluginEngine, 'models' | 'defaultModelAllowed'>,
  activeModelId?: string | null,
): (MobilePluginEngineModel & { isDefault: boolean })[] {
  const models = engine.models.map((model) => ({ ...model, isDefault: false }));
  if (engine.defaultModelAllowed === false) return models;
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

/** 插件引擎任务的权限模式：按跨引擎等价规则（ask <-> default）匹配引擎提供的档位，否则安全回落到引擎默认档；引擎已不在时只保留「完全访问」。 */
export function pluginEnginePermissionMode(
  mode: string | null | undefined,
  engine: Pick<MobilePluginEngine, 'permissionModes' | 'defaultPermissionMode'> | null | undefined,
): string {
  if (engine) {
    return resolvePermissionModeForOptions(
      mode,
      engine.permissionModes.map((option) => option.id),
      engine.defaultPermissionMode,
    );
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
): { agentKind: typeof PLUGIN_ENGINE_AGENT_KIND; providerId: string; model: string; effort: string; permissionMode: string; fastMode: false; agentDeviceId?: string } {
  const model = selection.modelId || PLUGIN_ENGINE_DEFAULT_MODEL;
  return {
    agentKind: PLUGIN_ENGINE_AGENT_KIND,
    providerId: engine.providerId,
    model,
    effort: resolvePluginEngineEffort(engine, model, selection.effort) ?? '',
    permissionMode: pluginEnginePermissionMode(selection.permissionMode, engine),
    fastMode: false,
    ...(engine.deviceId ? { agentDeviceId: engine.deviceId } : {}),
  };
}

/**
 * 插件引擎任务的能力视图：主机级开关(能否切换引擎等)沿用被控电脑上报的那份，模型、思考深度与
 * 权限模式换成引擎自己的；插件引擎没有 Fast，计划模式按引擎是否声明 `plan` 档决定。
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
    { id: 'ask', displayName: 'Default permissions' },
    { id: 'bypassPermissions', displayName: 'Full access' },
  ]).map((mode) => ({ id: mode.id, label: mode.displayName }));
  return {
    ...(host ?? {}),
    availableModels,
    effortLevels,
    permissionModes,
    hasFastMode: false,
    planModeSupported: engine?.permissionModes.some((mode) => mode.id === 'plan') === true,
  };
}

/** desktop 意图投影里的插件引擎意图；不是插件引擎、或没有引擎标识时返回 null。 */
export function normalizePluginEngineSwitchIntent(value: unknown): MobilePluginEngineSwitchIntent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (item.targetAgentKind !== PLUGIN_ENGINE_AGENT_KIND) return null;
  if (!isPluginEngineProviderId(item.providerId)) return null;
  if (typeof item.model !== 'string' || item.model.length === 0) return null;
  const agentDeviceId = item.agentDeviceId;
  if (agentDeviceId != null && (typeof agentDeviceId !== 'string' || agentDeviceId.length === 0)) return null;
  return {
    providerId: item.providerId,
    model: item.model,
    ...(typeof item.effort === 'string' && item.effort ? { effort: item.effort } : {}),
    ...(agentDeviceId !== undefined ? { agentDeviceId } : {}),
  };
}

/** The pending target has priority over the saved execution location, including an explicit return home. */
export function pluginEngineExecutionDeviceId(
  currentDeviceId: string | null | undefined,
  intent: MobilePluginEngineSwitchIntent | null,
): string | null {
  return intent?.agentDeviceId === undefined ? currentDeviceId ?? null : intent.agentDeviceId;
}

// —— 模型选择器里的插件引擎分组 ——

export interface UnifiedMobilePluginEngineRow {
  key: string;
  providerId: string;
  /** Execution computer or share id when running on another computer; absent = task computer. */
  deviceId?: string;
  /** Present when running on another computer or share (renders the remote badge). */
  remoteDevice?: { deviceId: string; name: string };
  modelId: string;
  title: string;
  subtitle?: string;
  quotaLabel?: string;
  engineName?: string;
  /** 引擎不可用时插件给的说明。 */
  notice?: string;
  iconDataUrl?: string;
  /** 这一行将使用的思考深度(没有可选档位时为 null)。 */
  effort: PluginEngineEffort | null;
  efforts: PluginEngineEffort[];
  defaultEffort?: PluginEngineEffort;
  effortLabel: string;
  selected: boolean;
  disabled: boolean;
  /** 收藏区行携带原收藏记录，普通引擎行不带。 */
  favorite?: MobileModelFavorite;
}

export interface UnifiedMobilePluginEngineQuotaGroup {
  id: string;
  label: string;
  remaining: number;
  level: QuotaLevel;
  reset: string | null;
  summary: string;
  accessibilityLabel: string;
}

export interface UnifiedMobilePluginEngineQuota {
  summary: string;
  remaining?: number;
  level: QuotaLevel;
  accessibilityLabel: string;
  isMultiGroup?: boolean;
  groups?: UnifiedMobilePluginEngineQuotaGroup[];
}

export interface UnifiedMobilePluginEngineGroup {
  key: string;
  providerId: string;
  deviceId?: string;
  choiceKey: string;
  title: string;
  quota?: UnifiedMobilePluginEngineQuota;
  rows: UnifiedMobilePluginEngineRow[];
}

/** Formats a plugin engine's usage snapshot into picker header quota readout(s) or a balance. */
export function formatPluginEnginePickerQuota(
  usage: GhostHarnessUsage | null | undefined,
  now: number,
  language: string,
  countdown: (resetsAtSeconds: number, now: number) => string | null,
): UnifiedMobilePluginEngineQuota | undefined {
  const presentation = buildPluginEngineUsagePresentation(usage, now);
  if (presentation.groups.length > 0) {
    const groups: UnifiedMobilePluginEngineQuotaGroup[] = presentation.groups.map((group) => {
      const label = presentation.isMultiGroup
        ? (group.shortLabel ?? group.primary.label)
        : group.primary.label;
      const percent = `${group.remainingPercent}%`;
      const reset = group.primary.resetsAt ? countdown(group.primary.resetsAt / 1000, now) : null;
      const summary = reset ? `${percent} · ${reset}` : percent;
      return {
        id: group.id,
        label,
        remaining: group.remainingPercent,
        level: group.level,
        reset,
        summary,
        accessibilityLabel: [label, summary].filter(Boolean).join(' · '),
      };
    });
    if (!presentation.isMultiGroup) {
      const only = groups[0]!;
      return {
        summary: only.summary,
        level: only.level,
        accessibilityLabel: only.accessibilityLabel,
        remaining: only.remaining,
        groups,
      };
    }
    return {
      summary: groups.map((group) => `${group.label} ${group.remaining}%`).join(' · '),
      level: presentation.level,
      accessibilityLabel: groups.map((group) => group.accessibilityLabel).join(' · '),
      isMultiGroup: true,
      groups,
    };
  }
  const balance = presentation.balances[0];
  if (!balance) return undefined;
  let formatted: string;
  try {
    formatted = new Intl.NumberFormat(language, {
      style: 'currency',
      currency: balance.currency,
      currencyDisplay: 'code',
    }).format(balance.numericAmount);
  } catch {
    formatted = `${balance.currency} ${balance.amount}`;
  }
  return {
    summary: formatted,
    level: presentation.level,
    accessibilityLabel: formatted,
  };
}

/** Formats per-model quota text for a plugin engine row, matching built-in `modelQuotaLabel`. */
export function formatPluginEngineModelQuotaLabel(
  usage: GhostHarnessUsage | null | undefined,
  model: { id: string; name?: string | null },
  now: number,
  countdown: (resetsAtSeconds: number, now: number, windowMinutes: number | null) => string | null,
): string | undefined {
  if (!usage || model.id === PLUGIN_ENGINE_DEFAULT_MODEL) return undefined;
  const presentation = buildPluginEngineUsagePresentation(usage, now);
  const group = matchPluginEngineQuotaGroup(presentation, model);
  if (!group) return undefined;
  const reset = group.primary.resetsAt
    ? countdown(group.primary.resetsAt / 1000, now, group.primary.windowMinutes ?? null)
    : null;
  return [reset, `${group.remainingPercent}%`].filter(Boolean).join(' · ');
}

/** Formats per-model quota when a plugin engine publishes model-scoped usage windows. */
export function formatPluginEngineModelQuota(
  usage: GhostHarnessUsage | null | undefined,
  modelId: string,
  now: number,
  countdown: (resetsAtSeconds: number, now: number) => string | null,
): string | null {
  if (!usage?.windows?.length || !modelId || modelId === PLUGIN_ENGINE_DEFAULT_MODEL) return null;
  const matching = usage.windows.filter(
    (row) =>
      (!row.resetsAt || row.resetsAt > now)
      && Array.isArray(row.models)
      && row.models.includes(modelId),
  );
  if (matching.length === 0) return null;
  const first = matching.reduce<(typeof matching)[number] | undefined>(
    (lowest, row) => (!lowest || row.remainingPercent < lowest.remainingPercent ? row : lowest),
    undefined,
  );
  if (!first) return null;
  const reset = first.resetsAt ? countdown(first.resetsAt / 1000, now) : null;
  return [reset, `${Math.round(first.remainingPercent)}%`].filter(Boolean).join(' · ');
}

/** 插件引擎分组：引擎名命中搜索时整组列出，否则只列命中的模型；不可用的引擎可见但不能选。 */
export function buildPluginEngineGroups(
  options: { engines: readonly MobilePluginEngine[]; active: MobilePluginEngineSelection | null },
  query: string,
  labels: {
    defaultModel: string;
    effort(id: PluginEngineEffort): string;
    unavailable(name: string, hint?: string): string;
    remoteTitle?(engineName: string, deviceName: string): string;
    modelQuota?(engine: MobilePluginEngine, modelId: string): string | null;
  },
): UnifiedMobilePluginEngineGroup[] {
  const needle = query.trim().toLowerCase();
  const groups: UnifiedMobilePluginEngineGroup[] = [];
  for (const engine of options.engines) {
    const selectable = isPluginEngineSelectable(engine);
    const active = isSamePluginEngineChoice(options.active, engine) ? options.active : null;
    // 只装了插件但未登录 / 未就绪的引擎、用户在那台电脑上隐藏的引擎都不在模型选择器里占位；
    // 仅当前任务已选该引擎时保留以便识别状态。
    if ((!selectable || engine.hidden) && !active) continue;
    const choiceKey = pluginEngineChoiceKey(engine);
    const deviceLabel = engine.deviceId ? (engine.deviceName ?? engine.deviceId) : null;
    const groupTitle = deviceLabel
      ? (labels.remoteTitle ? labels.remoteTitle(engine.name, deviceLabel) : `${engine.name} · ${deviceLabel}`)
      : engine.name;
    const engineMatches = !needle
      || engine.name.toLowerCase().includes(needle)
      || (deviceLabel ? deviceLabel.toLowerCase().includes(needle) : false);
    const rows = pluginEngineModelRows(engine, active?.modelId)
      .filter((model) => engineMatches
        || [model.isDefault ? labels.defaultModel : model.displayName, model.description]
          .some((text) => text?.toLowerCase().includes(needle)))
      .map((model): UnifiedMobilePluginEngineRow => {
        const selected = !!active && active.modelId === model.id;
        const effort = resolvePluginEngineEffort(engine, model.id, selected ? active?.effort : undefined);
        const quotaLabel = labels.modelQuota?.(engine, model.id) ?? null;
        return {
          key: `${choiceKey}#${model.id}`,
          providerId: engine.providerId,
          ...(engine.deviceId ? { deviceId: engine.deviceId } : {}),
          ...(engine.deviceId ? { remoteDevice: { deviceId: engine.deviceId, name: deviceLabel! } } : {}),
          modelId: model.id,
          title: model.isDefault ? labels.defaultModel : model.displayName,
          ...(model.description ? { subtitle: model.description } : {}),
          ...(quotaLabel ? { quotaLabel } : {}),
          engineName: engine.name,
          ...(!selectable ? { notice: labels.unavailable(engine.name, engine.availability.message) } : {}),
          ...(engine.iconDataUrl ? { iconDataUrl: engine.iconDataUrl } : {}),
          effort,
          efforts: [...model.efforts],
          ...(model.defaultEffort ? { defaultEffort: model.defaultEffort } : {}),
          effortLabel: effort ? labels.effort(effort) : '',
          selected,
          disabled: !selectable,
        };
      });
    if (rows.length) {
      groups.push({
        key: `plugin-engine:${choiceKey}`,
        providerId: engine.providerId,
        ...(engine.deviceId ? { deviceId: engine.deviceId } : {}),
        choiceKey,
        title: groupTitle,
        rows,
      });
    }
  }
  return groups;
}

/**
 * 解析收藏列表里的插件引擎条目（支持本机、同账号另一台电脑及插件引擎分享）：
 * 已隐藏但可用的引擎照常解析（与内置隐藏供应商同口径）；
 * 不可用引擎或已移除的模型返回 null，不删原收藏。
 */
export function resolveMobilePluginEngineFavorite(
  item: MobileModelFavorite,
  engines: readonly MobilePluginEngine[],
  labels: {
    defaultModel: string;
    effort(id: PluginEngineEffort): string;
    modelQuota?(engine: MobilePluginEngine, modelId: string): string | null;
  },
): UnifiedMobilePluginEngineRow | null {
  let engine: MobilePluginEngine | undefined;
  if (isPluginEngineProviderId(item.providerId)) {
    engine = engines.find((candidate) => candidate.providerId === item.providerId && !candidate.deviceId);
  } else {
    const agentDevice = parseAgentDeviceFavoriteSource(item.providerId);
    if (agentDevice && isPluginEngineProviderId(agentDevice.providerId)) {
      engine = engines.find(
        (candidate) => candidate.providerId === agentDevice.providerId && candidate.deviceId === agentDevice.deviceId,
      );
    } else {
      const share = parseProviderShareFavoriteSource(item.providerId);
      if (share && isPluginEngineProviderId(share.providerId)) {
        engine = engines.find(
          (candidate) =>
            candidate.providerId === share.providerId
            && !!candidate.favoriteSource
            && providerShareFavoriteWireKey(candidate.favoriteSource) === item.providerId,
        );
      }
    }
  }
  if (!engine || !isPluginEngineSelectable(engine)) return null;
  let title: string;
  let efforts: PluginEngineEffort[];
  let defaultEffort: PluginEngineEffort | undefined;
  if (item.modelId === PLUGIN_ENGINE_DEFAULT_MODEL) {
    if (engine.defaultModelAllowed === false) return null;
    title = labels.defaultModel;
    efforts = [];
  } else {
    const model = engine.models.find((candidate) => candidate.id === item.modelId);
    if (!model) return null;
    title = model.displayName;
    efforts = [...model.efforts];
    defaultEffort = model.defaultEffort;
  }
  const effort = resolvePluginEngineEffort(engine, item.modelId, item.effort);
  const deviceLabel = engine.deviceId ? (engine.deviceName ?? engine.deviceId) : null;
  const quotaLabel = labels.modelQuota?.(engine, item.modelId) ?? null;
  return {
    key: item.uid,
    providerId: engine.providerId,
    ...(engine.deviceId ? { deviceId: engine.deviceId } : {}),
    ...(engine.deviceId ? { remoteDevice: { deviceId: engine.deviceId, name: deviceLabel! } } : {}),
    modelId: item.modelId,
    title,
    subtitle: deviceLabel ? `${engine.name} · ${deviceLabel}` : engine.name,
    ...(quotaLabel ? { quotaLabel } : {}),
    engineName: engine.name,
    ...(engine.iconDataUrl ? { iconDataUrl: engine.iconDataUrl } : {}),
    effort,
    efforts,
    ...(defaultEffort ? { defaultEffort } : {}),
    effortLabel: effort ? labels.effort(effort) : '',
    selected: false,
    disabled: false,
    favorite: item,
  };
}

/** 插件引擎收藏行是否命中搜索词。 */
export function matchesPluginEngineFavoriteQuery(
  row: UnifiedMobilePluginEngineRow,
  query: string,
): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return [row.title, row.subtitle, row.engineName, row.remoteDevice?.name, row.modelId]
    .some((value) => value?.toLowerCase().includes(needle));
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
const controlledCache = new Map<string, CacheEntry>();
const controlledInFlight = new Map<string, Promise<void>>();
const controlledLastReadAt = new Map<string, number>();
const controlledLocationsCache = new Map<string, ControlledPluginEngineLocation[]>();
const controlledLocationsInFlight = new Map<string, Promise<ControlledPluginEngineLocation[]>>();
const controlledLocationsReadAt = new Map<string, number>();
const CONTROLLED_REREAD_MS = 15_000;
const listeners = new Set<() => void>();
let version = 0;

export interface ControlledPluginEngineLocation {
  agentDeviceId: string;
  name: string;
  favoriteSource?: ProviderShareFavoriteSource;
}

export function controlledPluginEngineCacheKey(controlledDeviceId: string, agentDeviceId: string): string {
  return JSON.stringify([controlledDeviceId, agentDeviceId]);
}

function readControlledFavoriteSource(value: unknown, agentDeviceId: string): ProviderShareFavoriteSource | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const owner = source.owner && typeof source.owner === 'object' && !Array.isArray(source.owner)
    ? source.owner as Record<string, unknown>
    : null;
  if (
    typeof source.shareId !== 'string' || !source.shareId
    || typeof source.memberId !== 'string' || !source.memberId
    || typeof source.providerId !== 'string' || !source.providerId
    || agentDeviceId !== `share:${source.shareId}`
    || (owner?.region !== 'cn' && owner?.region !== 'global')
  ) {
    return undefined;
  }
  return {
    shareId: source.shareId,
    memberId: source.memberId,
    providerId: source.providerId,
    owner: { region: owner.region },
  };
}

/** Parse task-host `maker:model-catalog:read` `{ op: 'locations' }` reply into remote plugin engine candidates. */
export function parseControlledModelLocations(
  controlledDeviceId: string,
  raw: unknown,
): ControlledPluginEngineLocation[] {
  const list = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as { locations?: unknown }).locations
    : undefined;
  if (!Array.isArray(list)) return [];
  const out: ControlledPluginEngineLocation[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const agentDeviceId = typeof record.agentDeviceId === 'string' ? record.agentDeviceId.trim() : '';
    if (!agentDeviceId || agentDeviceId === controlledDeviceId || seen.has(agentDeviceId)) continue;
    const favoriteSource = readControlledFavoriteSource(record.favoriteSource, agentDeviceId);
    const rawFavoriteProviderId = record.favoriteSource && typeof record.favoriteSource === 'object' && !Array.isArray(record.favoriteSource)
      && typeof (record.favoriteSource as Record<string, unknown>).providerId === 'string'
      ? (record.favoriteSource as Record<string, unknown>).providerId as string
      : undefined;
    // Built-in provider shares never offer plugin engines.
    if (isProviderShareAgentDeviceId(agentDeviceId) && rawFavoriteProviderId !== undefined && !isPluginEngineProviderId(rawFavoriteProviderId)) {
      continue;
    }
    seen.add(agentDeviceId);
    out.push({
      agentDeviceId,
      name: text(record.name, 120) ?? agentDeviceId,
      ...(favoriteSource ? { favoriteSource } : {}),
    });
  }
  return out;
}

/** Filter a remote source's engine list to engines opened for remote use with at least one permitted model. */
export function normalizeOfferedRemotePluginEngines(
  raw: unknown,
  meta: { deviceId: string; deviceName?: string; favoriteSource?: ProviderShareFavoriteSource },
): MobilePluginEngine[] {
  return normalizePluginEngines(raw)
    .filter((engine) =>
      isPluginEngineOfferedRemotely(engine)
      && (engine.models.length > 0 || engine.defaultModelAllowed !== false))
    .map((engine) => {
      const next: MobilePluginEngine = {
        ...engine,
        deviceId: meta.deviceId,
        ...(meta.deviceName ? { deviceName: meta.deviceName } : {}),
        ...(meta.favoriteSource ? { favoriteSource: meta.favoriteSource } : {}),
      };
      // Owner's local hidden preference does not hide remotely offered engines;
      // provider shares never expose the sharer's account usage.
      delete next.hidden;
      if (isProviderShareAgentDeviceId(meta.deviceId)) delete next.reportsUsage;
      return next;
    });
}

export function setCachedControlledPluginEngines(
  controlledDeviceId: string,
  agentDeviceId: string,
  engines: MobilePluginEngine[],
  supported: boolean,
): void {
  const key = controlledPluginEngineCacheKey(controlledDeviceId, agentDeviceId);
  const previous = controlledCache.get(key);
  if (previous && previous.supported === supported && sameEngines(previous.engines, engines)) return;
  controlledCache.set(key, { engines: engines.length ? engines : EMPTY_ENGINES, supported });
  publish();
}

export function getCachedControlledPluginEngines(
  controlledDeviceId: string | null | undefined,
  agentDeviceId: string | null | undefined,
): readonly MobilePluginEngine[] {
  if (!controlledDeviceId || !agentDeviceId) return EMPTY_ENGINES;
  return controlledCache.get(controlledPluginEngineCacheKey(controlledDeviceId, agentDeviceId))?.engines ?? EMPTY_ENGINES;
}

const EVICT_CONTROLLED_CATALOG_ERROR_CODES = new Set([
  'CHANNEL_NOT_ALLOWED',
  'DEVICE_LINK_CHANNEL_NOT_ALLOWED',
  'INVALID_PARAMS',
  'PRECONDITION_FAILED',
  'PERMISSION_DENIED',
  'NOT_FOUND',
]);

function shouldEvictControlledCatalogError(error: unknown): boolean {
  const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
  if (typeof code === 'string' && EVICT_CONTROLLED_CATALOG_ERROR_CODES.has(code)) {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error ?? '');
  const bracketCode = /^\[([A-Z_]+)\]/.exec(message)?.[1];
  if (bracketCode && EVICT_CONTROLLED_CATALOG_ERROR_CODES.has(bracketCode)) {
    return true;
  }
  for (const candidate of EVICT_CONTROLLED_CATALOG_ERROR_CODES) {
    if (message.includes(candidate)) return true;
  }
  return false;
}

function evictMissingControlledCatalogs(
  controlledDeviceId: string,
  allowedAgentDeviceIds: ReadonlySet<string>,
): boolean {
  let evicted = false;
  for (const [key, entry] of [...controlledCache.entries()]) {
    let pair: unknown;
    try {
      pair = JSON.parse(key);
    } catch {
      continue;
    }
    if (!Array.isArray(pair) || pair.length !== 2 || pair[0] !== controlledDeviceId) continue;
    const agentDeviceId = typeof pair[1] === 'string' ? pair[1] : '';
    if (allowedAgentDeviceIds.has(agentDeviceId)) continue;
    controlledCache.delete(key);
    controlledLastReadAt.delete(key);
    if (entry.engines.length > 0 || entry.supported) evicted = true;
  }
  return evicted;
}

/** Read one remote/shared source's plugin engines through the task computer (`maker:model-catalog:read`). */
export function loadControlledPluginEngines(
  controlledDeviceId: string,
  agentDeviceId: string,
  invoke: RemoteInvoke,
  options?: { force?: boolean; deviceName?: string; favoriteSource?: ProviderShareFavoriteSource },
): Promise<void> {
  ensureOwnerSubscription();
  const owner = getMobileAuthOwner();
  if (!owner.accountId || !controlledDeviceId || !agentDeviceId || isSharedTaskPeer(controlledDeviceId)) {
    return Promise.resolve();
  }
  const key = controlledPluginEngineCacheKey(controlledDeviceId, agentDeviceId);
  const existing = controlledInFlight.get(key);
  if (existing) return existing;
  const now = Date.now();
  const lastRead = controlledLastReadAt.get(key) ?? 0;
  if (!options?.force && controlledCache.has(key) && now - lastRead < CONTROLLED_REREAD_MS) {
    return Promise.resolve();
  }
  const run = invoke<unknown>(controlledDeviceId, 'maker:model-catalog:read', [{
    op: 'read',
    agentDeviceId,
    channel: 'maker:list-plugin-engines',
    args: [],
  }])
    .then((raw) => {
      if (!isMobileAuthOwnerCurrent(owner)) return;
      controlledLastReadAt.set(key, Date.now());
      const offered = normalizeOfferedRemotePluginEngines(raw, {
        deviceId: agentDeviceId,
        deviceName: options?.deviceName,
        favoriteSource: options?.favoriteSource,
      });
      setCachedControlledPluginEngines(controlledDeviceId, agentDeviceId, offered, true);
    })
    .catch((error: unknown) => {
      if (!isMobileAuthOwnerCurrent(owner)) return;
      controlledLastReadAt.set(key, Date.now());
      if (shouldEvictControlledCatalogError(error) || !controlledCache.has(key)) {
        setCachedControlledPluginEngines(controlledDeviceId, agentDeviceId, [], false);
      }
    })
    .finally(() => {
      if (controlledInFlight.get(key) === run) controlledInFlight.delete(key);
    });
  controlledInFlight.set(key, run);
  return run;
}

/** Prefetch a remote/shared plugin engine catalog once for task list icon resolution. */
export function prefetchControlledPluginEngineIcons(
  controlledDeviceId: string,
  agentDeviceId: string,
  invoke: RemoteInvoke,
): Promise<void> {
  return getCachedControlledPluginEngines(controlledDeviceId, agentDeviceId).length
    ? Promise.resolve()
    : loadControlledPluginEngines(controlledDeviceId, agentDeviceId, invoke);
}

function loadControlledPluginEngineLocations(
  controlledDeviceId: string,
  invoke: RemoteInvoke,
  force = false,
): Promise<ControlledPluginEngineLocation[]> {
  ensureOwnerSubscription();
  const owner = getMobileAuthOwner();
  if (!owner.accountId || !controlledDeviceId || isSharedTaskPeer(controlledDeviceId)) {
    return Promise.resolve([]);
  }
  const existing = controlledLocationsInFlight.get(controlledDeviceId);
  if (existing) return existing;
  const now = Date.now();
  const lastRead = controlledLocationsReadAt.get(controlledDeviceId) ?? 0;
  if (!force && controlledLocationsCache.has(controlledDeviceId) && now - lastRead < CONTROLLED_REREAD_MS) {
    return Promise.resolve(controlledLocationsCache.get(controlledDeviceId) ?? []);
  }
  const run = invoke<unknown>(controlledDeviceId, 'maker:model-catalog:read', [{ op: 'locations' }])
    .then((raw) => {
      if (!isMobileAuthOwnerCurrent(owner)) return [];
      const parsed = parseControlledModelLocations(controlledDeviceId, raw);
      const complete = !(
        raw && typeof raw === 'object' && !Array.isArray(raw)
        && (raw as { status?: unknown }).status === 'degraded'
      );
      controlledLocationsReadAt.set(controlledDeviceId, Date.now());
      const previous = controlledLocationsCache.get(controlledDeviceId);
      const changed = !previous || JSON.stringify(previous) !== JSON.stringify(parsed);
      if (changed) controlledLocationsCache.set(controlledDeviceId, parsed);
      const evicted = complete
        ? evictMissingControlledCatalogs(controlledDeviceId, new Set(parsed.map((loc) => loc.agentDeviceId)))
        : false;
      if (changed || evicted) publish();
      return parsed;
    })
    .catch((error: unknown) => {
      if (!isMobileAuthOwnerCurrent(owner)) return [];
      controlledLocationsReadAt.set(controlledDeviceId, Date.now());
      if (shouldEvictControlledCatalogError(error)) {
        const previous = controlledLocationsCache.get(controlledDeviceId);
        const changed = !previous || previous.length > 0;
        controlledLocationsCache.set(controlledDeviceId, []);
        const evicted = evictMissingControlledCatalogs(controlledDeviceId, new Set());
        if (changed || evicted) publish();
        return [];
      }
      if (!controlledLocationsCache.has(controlledDeviceId)) {
        controlledLocationsCache.set(controlledDeviceId, []);
      }
      return controlledLocationsCache.get(controlledDeviceId) ?? [];
    })
    .finally(() => {
      if (controlledLocationsInFlight.get(controlledDeviceId) === run) {
        controlledLocationsInFlight.delete(controlledDeviceId);
      }
    });
  controlledLocationsInFlight.set(controlledDeviceId, run);
  return run;
}

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

export function hasCachedPluginEngineCatalogue(deviceId: string | null | undefined): boolean {
  return !!deviceId && cache.has(deviceId);
}

/** Whether a local or same-account remote plugin engine declares `reportsUsage: true`. */
export function pluginEngineReportsUsage(
  engine: Pick<MobilePluginEngine, 'providerId' | 'reportsUsage' | 'deviceId'>,
): boolean {
  if (engine.reportsUsage === true) return true;
  if (!engine.deviceId || isProviderShareAgentDeviceId(engine.deviceId) || isSharedTaskPeer(engine.deviceId)) {
    return false;
  }
  return findPluginEngine(getCachedPluginEngines(engine.deviceId), engine.providerId)?.reportsUsage === true;
}

export function usePluginEngineCacheVersion(): number {
  return useSyncExternalStore(subscribe, getVersion, getVersion);
}

/** 退出账号 / 切换账号时清掉，不把上一个账号的电脑引擎带过去。 */
export function clearPluginEngineCache(): void {
  lastRefreshAt.clear();
  inFlight.clear();
  controlledInFlight.clear();
  controlledLastReadAt.clear();
  controlledLocationsInFlight.clear();
  controlledLocationsReadAt.clear();
  const hadData = cache.size > 0 || controlledCache.size > 0 || controlledLocationsCache.size > 0;
  if (!hadData) return;
  cache.clear();
  controlledCache.clear();
  controlledLocationsCache.clear();
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

/**
 * Remote & shared plugin engines available to a controlled task computer, read through that
 * computer's `maker:model-catalog:read` channel (matching Desktop `controlledPluginEngineSources`).
 */
export function useControlledRemotePluginEngines(input: {
  controlledDeviceId: string | null | undefined;
  enabled: boolean;
  /** True when the model picker is open and should discover all remote/shared sources. */
  discoverAll?: boolean;
  invoke: RemoteInvoke | null;
  remoteCatalogs?: readonly RemoteAgentCatalog[];
  keepDeviceIds?: readonly string[];
  connectionEpoch?: number;
}): {
  engines: readonly MobilePluginEngine[];
  settled: boolean;
  refresh(): void;
} {
  const snapshotVersion = useSyncExternalStore(subscribe, getVersion, getVersion);
  const controlledDeviceId = input.controlledDeviceId || '';
  const active = input.enabled && !!controlledDeviceId && !!input.invoke && !isSharedTaskPeer(controlledDeviceId);
  const discoverAll = input.discoverAll === true;
  const keepKey = (input.keepDeviceIds ?? []).filter(Boolean).join('\n');
  const [locationsSettled, setLocationsSettled] = useState(false);
  const remoteCatalogsRef = useRef(input.remoteCatalogs);
  remoteCatalogsRef.current = input.remoteCatalogs;

  const fetchAll = useCallback((force: boolean) => {
    if (!active || !input.invoke) return;
    const invoke = input.invoke;
    const keepIds = keepKey ? keepKey.split('\n') : [];
    const loadSources = async () => {
      const locations = discoverAll
        ? await loadControlledPluginEngineLocations(controlledDeviceId, invoke, force)
        : (controlledLocationsCache.get(controlledDeviceId) ?? []);
      const targets = new Map<string, ControlledPluginEngineLocation>();
      if (discoverAll) {
        for (const loc of locations) targets.set(loc.agentDeviceId, loc);
      }
      for (const id of keepIds) {
        if (id && id !== controlledDeviceId && !targets.has(id)) {
          const fromLoc = locations.find((loc) => loc.agentDeviceId === id);
          const fromCatalog = remoteCatalogsRef.current?.find((c) => c.deviceId === id);
          targets.set(id, fromLoc ?? {
            agentDeviceId: id,
            name: fromCatalog?.name ?? id,
            ...(fromCatalog?.favoriteSource ? { favoriteSource: fromCatalog.favoriteSource } : {}),
          });
        }
      }
      await Promise.all(
        [...targets.values()].map((loc) =>
          loadControlledPluginEngines(controlledDeviceId, loc.agentDeviceId, invoke, {
            force,
            deviceName: loc.name,
            favoriteSource: loc.favoriteSource,
          }),
        ),
      );
      setLocationsSettled(true);
    };
    void loadSources();
  }, [active, controlledDeviceId, discoverAll, input.invoke, keepKey]);

  useEffect(() => {
    if (!active) return;
    fetchAll(false);
  }, [active, fetchAll, input.connectionEpoch]);

  const refresh = useCallback(() => {
    fetchAll(true);
  }, [fetchAll]);

  const engines = useMemo(() => {
    if (!active) return EMPTY_ENGINES;
    const locations = controlledLocationsCache.get(controlledDeviceId) ?? [];
    const keepIds = keepKey ? keepKey.split('\n') : [];
    const catalogByDevice = new Map((input.remoteCatalogs ?? []).map((c) => [c.deviceId, c]));
    const orderedIds: string[] = [];
    const seen = new Set<string>();
    for (const loc of locations) {
      if (!seen.has(loc.agentDeviceId)) {
        seen.add(loc.agentDeviceId);
        orderedIds.push(loc.agentDeviceId);
      }
    }
    for (const id of keepIds) {
      if (id && id !== controlledDeviceId && !seen.has(id)) {
        seen.add(id);
        orderedIds.push(id);
      }
    }
    const locById = new Map(locations.map((loc) => [loc.agentDeviceId, loc]));
    const list: MobilePluginEngine[] = [];
    for (const agentDeviceId of orderedIds) {
      const cached = getCachedControlledPluginEngines(controlledDeviceId, agentDeviceId);
      if (cached.length === 0) continue;
      const catalog = catalogByDevice.get(agentDeviceId);
      // Skip offline sources unless kept by an active/pending task.
      const kept = keepIds.includes(agentDeviceId);
      if (catalog?.offline && !kept) continue;
      const loc = locById.get(agentDeviceId);
      const displayName = catalog?.name || loc?.name || agentDeviceId;
      const favoriteSource = catalog?.favoriteSource ?? loc?.favoriteSource;
      for (const engine of cached) {
        list.push({
          ...engine,
          deviceId: agentDeviceId,
          deviceName: displayName,
          ...(favoriteSource ? { favoriteSource } : {}),
        });
      }
    }
    return list;
  }, [active, controlledDeviceId, keepKey, input.remoteCatalogs, snapshotVersion]);

  return { engines, settled: !active || locationsSettled, refresh };
}

/** 任务列表等只读场景：已读到过的引擎(没读到过返回 null，调用方显示通用引擎标识)。 */
export function usePluginEngineFor(
  deviceId: string | null | undefined,
  providerId: string | null | undefined,
  agentDeviceId?: string | null,
): MobilePluginEngine | null {
  useSyncExternalStore(subscribe, getVersion, getVersion);
  if (agentDeviceId && deviceId && agentDeviceId !== deviceId) {
    const controlled = findPluginEngine(
      getCachedControlledPluginEngines(deviceId, agentDeviceId),
      providerId,
      agentDeviceId,
    );
    if (controlled) return controlled;
    if (!isProviderShareAgentDeviceId(agentDeviceId)) {
      return findPluginEngine(getCachedPluginEngines(agentDeviceId), providerId);
    }
    return null;
  }
  return findPluginEngine(getCachedPluginEngines(deviceId), providerId);
}
