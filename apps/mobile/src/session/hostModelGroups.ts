/**
 * 被控电脑的模型组(model-groups.md §6.3)：手机在那台电脑上新建任务、给进行中的任务换模型时列出那台的模式
 * 与合并后的供应商路由；选路、提交记录、记绑定、解绑与写说明都由那台电脑做，手机只把结果用到创建参数或换模型上。
 *
 * 读取按需：进入页面时每台电脑读一次，15 秒内复用上次的答案；那台是旧版本(没有该 channel)时 5 分钟内不再问，
 * 之后再问一次：那台升级后不必重开 App 就能看到它的模式。
 * 缓存按账号与登录代次隔离：换账号时清空，旧账号的迟到结果不写入。
 */
import { useEffect, useMemo, useState } from 'react';
import type { TFunction } from 'i18next';

import { getMobileAuthOwner, isMobileAuthOwnerCurrent, subscribeMobileAuthOwner } from '@/auth/authOwnerGeneration';
import type { MobileMakerTransport as MakerTransport } from '@/device-link/mobileMakerTransport';
import type { CompanionModelGroup } from './companionProfileData';
import type { NewSessionDraft } from './newSession';
import {
  parseHostModelGroupsPayload,
  type HostModelGroupsPayload,
} from './sourceRouteProviders';
import type { RemoteSessionModelGroupBinding } from './types';
import type { UnifiedMobileModelGroupOptions } from './UnifiedModelPickerSheet';

export type HostModelGroup = CompanionModelGroup;
export type { HostModelGroupsPayload } from './sourceRouteProviders';

const REREAD_MS = 15_000;
const UNSUPPORTED_REREAD_MS = 5 * 60_000;
const BIND_AWAIT_BUDGET_MS = 2_000;

interface CacheEntry {
  payload: HostModelGroupsPayload | null;
  unsupported: boolean;
  readAt: number;
  pending?: Promise<void>;
}

const cache = new Map<string, CacheEntry>();
subscribeMobileAuthOwner(() => cache.clear());

/** 当前账号下这台电脑的缓存键；没登录或正在换账号时为 null(不读、不显示)。 */
function cacheKey(deviceId: string): string | null {
  const owner = getMobileAuthOwner();
  return owner.accountKey && !owner.switching ? `${owner.accountKey}\u0000${owner.generation}\u0000${deviceId}` : null;
}

/** 测试用。 */
export function resetHostModelGroupsCacheForTests(): void {
  cache.clear();
}

type ModelGroupsTransport = Pick<MakerTransport, 'listModelGroups'>;

export function readHostModelGroups(deviceId: string, maker: ModelGroupsTransport): Promise<void> {
  const key = cacheKey(deviceId);
  if (!key) return Promise.resolve();
  const owner = getMobileAuthOwner();
  const entry = cache.get(key) ?? { payload: null, unsupported: false, readAt: 0 };
  cache.set(key, entry);
  if (entry.pending) return entry.pending;
  const reuseFor = entry.unsupported ? UNSUPPORTED_REREAD_MS : REREAD_MS;
  if (entry.readAt > 0 && Date.now() - entry.readAt < reuseFor) return Promise.resolve();
  entry.readAt = Date.now();
  const run = maker.listModelGroups()
    .then((raw) => {
      // 读取期间换了账号：这份答案属于旧账号，不写入(换账号时缓存已清空)。
      if (!isMobileAuthOwnerCurrent(owner)) return;
      if (raw === null) {
        entry.unsupported = true;
        entry.payload = null;
        return;
      }
      entry.unsupported = false;
      entry.payload = parseHostModelGroupsPayload(raw) ?? { groups: [], sourceRoutes: [], expandedRoutes: [] };
    })
    // 连不上时保留上一次的答案。
    .catch(() => undefined)
    .finally(() => { entry.pending = undefined; });
  entry.pending = run;
  return run;
}

/** 被控电脑的完整路由载荷(含可选合并供应商路由)；null = 还没读到、读不到，或那台不支持模型组。 */
export function useHostModelGroupsPayload(
  deviceId: string | null | undefined,
  maker: ModelGroupsTransport | null | undefined,
  enabled: boolean,
): HostModelGroupsPayload | null {
  const [, setVersion] = useState(0);
  // 换账号：缓存已清空，重新渲染为「还没读到」，再按新账号读。
  const [ownerGeneration, setOwnerGeneration] = useState(() => getMobileAuthOwner().generation);
  useEffect(() => subscribeMobileAuthOwner(() => setOwnerGeneration(getMobileAuthOwner().generation)), []);
  useEffect(() => {
    if (!enabled || !deviceId || !maker) return;
    let cancelled = false;
    void readHostModelGroups(deviceId, maker).then(() => { if (!cancelled) setVersion((value) => value + 1); });
    return () => { cancelled = true; };
  }, [enabled, deviceId, maker, ownerGeneration]);
  return enabled && deviceId ? cachedHostModelGroupsPayload(deviceId) : null;
}

/** 被控电脑的模式列表；null = 还没读到、读不到，或那台不支持模型组。 */
export function useHostModelGroups(
  deviceId: string | null | undefined,
  maker: ModelGroupsTransport | null | undefined,
  enabled: boolean,
): HostModelGroup[] | null {
  return useHostModelGroupsPayload(deviceId, maker, enabled)?.groups ?? null;
}

/** 上次读到的那台电脑的完整路由载荷；没读到或不支持时为 null。 */
export function cachedHostModelGroupsPayload(deviceId: string): HostModelGroupsPayload | null {
  const key = cacheKey(deviceId);
  const entry = key ? cache.get(key) : undefined;
  return entry && !entry.unsupported ? entry.payload : null;
}

/** 上次读到的那台电脑的模式；没读到或不支持时为 null。 */
export function cachedHostModelGroups(deviceId: string): HostModelGroup[] | null {
  return cachedHostModelGroupsPayload(deviceId)?.groups ?? null;
}

/** 来源数 · 选法 · 推理强度，与电脑上选择器里模型组那一行同一写法。 */
export function hostModelGroupHint(group: HostModelGroup, t: TFunction): string {
  return [t('models.modelGroups.sourceCount', { count: group.sources }), group.strategy ? t(`models.modelGroups.strategy.${group.strategy}`) : '',
    group.effort ? t(`models.options.effortLevels.${group.effort}`, { defaultValue: group.effort }) : ''].filter(Boolean).join(' · ');
}

/** 选择器里「模型组」与合并供应商路由配置；两者都没有且无托管态时不传。 */
export function useHostModelGroupPickerOptions(
  groups: readonly HostModelGroup[] | null,
  activeId: string | null,
  onSelect: (id: string) => Promise<boolean> | boolean,
  t: TFunction,
  extra?: Partial<Omit<UnifiedMobileModelGroupOptions, 'rows' | 'onSelect'>>,
): UnifiedMobileModelGroupOptions | undefined {
  return useMemo(() => {
    const rows = (groups ?? []).map((group) => ({
      id: group.id,
      title: group.name,
      subtitle: hostModelGroupHint(group, t),
      selected: group.id === activeId,
    }));
    const hasExtra = Boolean(
      extra?.managedMeta
      || (extra?.sourceRoutesPayload && extra.sourceRoutesPayload.sourceRoutes.length > 0),
    );
    if (rows.length === 0 && !hasExtra) return undefined;
    return {
      rows,
      onSelect,
      ...extra,
    };
  }, [groups, activeId, onSelect, t, extra]);
}

// —— 选路结果(那台电脑送来的，按不可信数据收) ——

export type HostModelGroupAgentKind = 'cc' | 'codex' | 'pi';

export interface HostModelGroupRoute {
  agentKind: HostModelGroupAgentKind;
  providerId: string;
  model: string;
  agentDeviceId?: string;
  effort?: string;
  fastMode?: true | 'ultrafast';
}

export type HostModelGroupResult = {
  decisionId?: string;
  groupName: string;
} & (
  | {
      outcome: 'routed';
      route: HostModelGroupRoute;
      modelName: string;
      sourceName: string;
      why: string;
      quota: { usedPercent: number; resetAtMs: number | null } | null;
      limitedUntilMs: number | null;
      exceptions: Array<{ type: 'image' | 'imageFallback' | 'hours'; viaRouteName?: string }>;
    }
  | { outcome: 'missing' | 'unavailable' });

export interface HostModelGroupSwitchOffer {
  selection: { type: 'route'; id: string };
  groupName: string;
  agentKind: HostModelGroupAgentKind;
  providerId: string;
  model: string;
  agentDeviceId?: string;
  effort?: string;
  fastMode?: true | 'ultrafast';
  modelName: string;
  sourceName: string;
  crossEngine: boolean;
  crossLocation?: boolean;
}

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const str = (value: unknown, max: number): string => (typeof value === 'string' ? value.trim().slice(0, max) : '');
const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const fastModeOf = (value: unknown): true | 'ultrafast' | undefined =>
  value === true || value === 'ultrafast' ? value : undefined;

export function parseHostModelGroupResult(raw: unknown): HostModelGroupResult | null {
  const value = record(raw);
  if (!value) return null;
  const groupName = str(value.groupName, 40);
  const decisionId = str(value.decisionId, 64);
  const base = { groupName, ...(decisionId ? { decisionId } : {}) };
  if (value.outcome === 'missing' || value.outcome === 'unavailable') return { ...base, outcome: value.outcome };
  if (value.outcome !== 'routed') return null;
  const route = record(value.route);
  const agentKind = route?.agentKind;
  const providerId = str(route?.providerId, 256);
  const model = str(route?.model, 256);
  if ((agentKind !== 'cc' && agentKind !== 'codex' && agentKind !== 'pi') || !providerId || !model) return null;
  const agentDeviceId = str(route?.agentDeviceId, 256);
  const effort = str(route?.effort, 32);
  const fastMode = fastModeOf(route?.fastMode);
  const quota = record(value.quota);
  const used = num(quota?.usedPercent);
  const picked = Array.isArray(value.trace)
    ? value.trace.map(record).find((entry) => entry?.state === 'picked')
    : undefined;
  const exceptions = (Array.isArray(value.exceptions) ? value.exceptions : []).slice(0, 8).flatMap((item) => {
    const entry = record(item);
    const type = entry?.type;
    if (type !== 'image' && type !== 'imageFallback' && type !== 'hours') return [];
    const via = str(entry?.viaRouteName, 40);
    return [{ type, ...(via ? { viaRouteName: via } : {}) } as const];
  });
  return {
    ...base,
    outcome: 'routed',
    route: {
      agentKind,
      providerId,
      model,
      ...(agentDeviceId ? { agentDeviceId } : {}),
      ...(effort ? { effort } : {}),
      ...(fastMode ? { fastMode } : {}),
    },
    modelName: str(value.modelName, 256) || model,
    sourceName: str(value.sourceName, 256) || providerId,
    // Newer hosts send the real reason in `pickWhy` and an older stand-in in `why` for apps that predate it.
    why: str(value.pickWhy, 32) || str(value.why, 32),
    quota: used === null ? null : { usedPercent: used, resetAtMs: num(quota?.resetAtMs) },
    limitedUntilMs: num(picked?.limitedUntilMs),
    exceptions,
  };
}

export function parseHostModelGroupSessionBinding(raw: unknown): RemoteSessionModelGroupBinding | null {
  const value = record(raw);
  if (!value) return null;
  const selection = record(value.selection);
  const id = str(selection?.id, 128);
  const routeName = str(value.routeName, 80);
  if (selection?.type !== 'route' || !id || !routeName) return null;
  const parentId = str(value.parentId, 64);
  const parentName = str(value.parentName, 40);
  return {
    selection: { type: 'route', id },
    routeName,
    ...(parentId ? { parentId } : {}),
    ...(parentName ? { parentName } : {}),
    ...(value.isSourceRoute === true ? { isSourceRoute: true as const } : {}),
    autoSwitch: value.autoSwitch !== false,
    ...(value.pendingSwitch === true ? { pendingSwitch: true as const } : {}),
  };
}

export function parseHostModelGroupSwitchOffer(raw: unknown): HostModelGroupSwitchOffer | null {
  const value = record(raw);
  if (!value) return null;
  const selection = record(value.selection);
  const id = str(selection?.id, 128);
  const groupName = str(value.groupName, 80);
  const agentKind = value.agentKind;
  const providerId = str(value.providerId, 256);
  const model = str(value.model, 256);
  if (
    selection?.type !== 'route' || !id || !groupName
    || (agentKind !== 'cc' && agentKind !== 'codex' && agentKind !== 'pi')
    || !providerId || !model
  ) {
    return null;
  }
  const agentDeviceId = str(value.agentDeviceId, 256);
  const effort = str(value.effort, 32);
  const fastMode = fastModeOf(value.fastMode);
  return {
    selection: { type: 'route', id },
    groupName,
    agentKind,
    providerId,
    model,
    ...(agentDeviceId ? { agentDeviceId } : {}),
    ...(effort ? { effort } : {}),
    ...(fastMode ? { fastMode } : {}),
    modelName: str(value.modelName, 256) || model,
    sourceName: str(value.sourceName, 256) || providerId,
    crossEngine: value.crossEngine === true,
    ...(value.crossLocation === true ? { crossLocation: true } : {}),
  };
}

/** 读取被控电脑为出错任务算出的「同路由下一个可用来源」提议。 */
export function useHostModelGroupSwitchOffer(
  sessionId: string | null | undefined,
  enabled: boolean,
  maker: Pick<MakerTransport, 'getModelGroupSwitchOffer'> | null | undefined,
  refreshKey: string,
): HostModelGroupSwitchOffer | null {
  const [offer, setOffer] = useState<HostModelGroupSwitchOffer | null>(null);
  useEffect(() => {
    if (!enabled || !sessionId || !maker) {
      setOffer(null);
      return;
    }
    let cancelled = false;
    void maker.getModelGroupSwitchOffer(sessionId)
      .then((raw) => {
        if (!cancelled) setOffer(parseHostModelGroupSwitchOffer(raw));
      })
      .catch(() => {
        if (!cancelled) setOffer(null);
      });
    return () => { cancelled = true; };
  }, [enabled, sessionId, maker, refreshKey]);
  return offer;
}

/**
 * 选到了来源：这次新建按它建(引擎、模型、来源、推理强度、Fast、运行位置)，不走插件引擎；
 * 没选到时原样返回草稿(沿用原来的模型)。
 */
export function applyHostModelGroupRoute(draft: NewSessionDraft, result: HostModelGroupResult | null): NewSessionDraft {
  if (result?.outcome !== 'routed') return draft;
  const { route } = result;
  const next: NewSessionDraft = {
    ...draft,
    agentKind: route.agentKind === 'cc' ? 'claude-code' : route.agentKind,
    model: route.model,
    providerId: route.providerId,
    effort: route.effort ?? '',
    fastMode: route.fastMode ?? false,
    pluginEngine: null,
  };
  if (route.agentDeviceId) next.agentDeviceId = route.agentDeviceId;
  else delete next.agentDeviceId;
  return next;
}

/** 请那台电脑按它的模式选；失败(连不上、旧版本、坏结果)返回 null，调用方沿用原来的模型。 */
export async function resolveHostModelGroup(
  maker: Pick<MakerTransport, 'resolveModelGroup'>,
  id: string,
  context?: { hasImages?: boolean; effort?: string; fastMode?: boolean | 'ultrafast' },
  location?: { agentDeviceId: string | null; sshHostId?: string },
): Promise<HostModelGroupResult | null> {
  try {
    return parseHostModelGroupResult(await maker.resolveModelGroup({
      selection: { type: 'route', id },
      ...(context ? { context } : {}),
      ...(location ? { location } : {}),
    }));
  } catch {
    return null;
  }
}

function formatReset(ms: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(ms);
}

/** 为什么选它：与电脑上任务里的说明同一组措辞(只有选中时会出现的那些)。 */
function whyText(result: Extract<HostModelGroupResult, { outcome: 'routed' }>, t: TFunction, locale: string): string {
  const left = result.quota ? Math.max(0, Math.round(100 - result.quota.usedPercent)) : null;
  const reset = result.quota?.resetAtMs ? formatReset(result.quota.resetAtMs, locale) : null;
  switch (result.why) {
    case 'expiring':
      return left !== null && reset
        ? t('models.modelGroups.why.expiringQuota', { left, reset })
        : t('models.modelGroups.why.expiring');
    case 'soonest':
      return result.limitedUntilMs
        ? t('models.modelGroups.why.soonestUntil', { reset: formatReset(result.limitedUntilMs, locale) })
        : t('models.modelGroups.why.soonest');
    case 'headroom':
      return left !== null ? t('models.modelGroups.why.headroomQuota', { left }) : t('models.modelGroups.why.headroom');
    case 'order': case 'rotate': case 'only': case 'cheapest': case 'cheapestFree': case 'drain': case 'drainNext': case 'weighted':
      return t(`models.modelGroups.why.${result.why}`);
    default:
      return '';
  }
}

function exceptionText(result: Extract<HostModelGroupResult, { outcome: 'routed' }>, t: TFunction): string {
  return result.exceptions.map((item) => (item.type === 'hours'
    ? t('models.modelGroups.why.exceptionHours', { name: item.viaRouteName ?? '' })
    : t(`models.modelGroups.why.${item.type === 'image' ? 'exceptionImage' : 'exceptionImageFallback'}`))).join(t('models.modelGroups.why.separator'));
}

/**
 * 任务里那一行说明(与电脑上同一张说明卡)：选到了写模型 · 来源和原因；没有能用的来源写沿用了原来的模型；
 * 模式已被删除时不写。deviceName 给另一台电脑或分享来的来源起名。
 */
export function buildHostModelGroupRouteNote(
  result: HostModelGroupResult | null,
  keptModelName: string,
  t: TFunction,
  locale: string,
  deviceName: (agentDeviceId: string) => string,
): Record<string, unknown> | null {
  if (!result || result.outcome === 'missing') return null;
  if (result.outcome !== 'routed') {
    return { pluginName: result.groupName, outcome: 'kept', modelName: keptModelName, why: 'unavailable-route', source: 'model-group' };
  }
  const source = result.route.agentDeviceId
    ? t('models.modelGroups.sourceOnDevice', { provider: result.sourceName, device: deviceName(result.route.agentDeviceId) })
    : result.sourceName;
  const reason = [exceptionText(result, t), whyText(result, t, locale)].filter(Boolean).join(t('models.modelGroups.why.separator'));
  return {
    pluginName: result.groupName,
    outcome: 'routed',
    modelName: `${result.modelName} · ${source}`,
    ...(result.route.effort ? { effort: result.route.effort } : {}),
    ...(reason ? { reason } : {}),
    source: 'model-group',
  };
}

type ApplyTransport = Pick<MakerTransport, 'commitModelGroupDecision' | 'bindModelGroupSession' | 'writeModelGroupRouteNote'>;

/**
 * 任务已在那台电脑上建好(或已换到选出的来源)：请那台提交这次选路、记下任务用着谁，必要时写说明。
 * 返回的 Promise 最多等待 2 秒完成绑定落盘，避免首轮派发与绑定竞争；超时或失败不阻断任务。
 */
export function applyHostModelGroupResult(
  maker: ApplyTransport,
  sessionId: string,
  groupId: string,
  result: HostModelGroupResult | null,
  note: Record<string, unknown> | null,
): Promise<void> {
  if (!result) return Promise.resolve();
  if (result.decisionId) void maker.commitModelGroupDecision(result.decisionId).catch(() => undefined);
  let bindTask: Promise<void> = Promise.resolve();
  if (result.outcome === 'routed') {
    const { route } = result;
    bindTask = Promise.resolve(maker.bindModelGroupSession({
      sessionId,
      selection: { type: 'route', id: groupId },
      route: {
        agentKind: route.agentKind, providerId: route.providerId, model: route.model,
        ...(route.agentDeviceId ? { agentDeviceId: route.agentDeviceId } : {}),
      },
    })).catch(() => undefined);
  }
  if (note) void maker.writeModelGroupRouteNote({ sessionId, note }).catch(() => undefined);
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, BIND_AWAIT_BUDGET_MS);
    void bindTask.finally(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}
