/**
 * 被控电脑的模型组(model-groups.md §6.3)：手机在那台电脑上新建任务、给进行中的任务换模型时列出那台的模式；
 * 选路、提交记录、记绑定与写说明都由那台电脑做，手机只把结果用到创建参数或换模型上。
 *
 * 读取按需：进入页面时每台电脑读一次，15 秒内复用上次的答案；那台是旧版本(没有该 channel)时 5 分钟内不再问，
 * 之后再问一次：那台升级后不必重开 App 就能看到它的模式。
 */
import { useEffect, useMemo, useState } from 'react';
import type { TFunction } from 'i18next';

import type { MobileMakerTransport as MakerTransport } from '@/device-link/mobileMakerTransport';
import { parseCompanionModelGroups, type CompanionModelGroup } from './companionProfileData';
import type { NewSessionDraft } from './newSession';
import type { UnifiedMobileModelGroupOptions } from './UnifiedModelPickerSheet';

export type HostModelGroup = CompanionModelGroup;

const REREAD_MS = 15_000;
const UNSUPPORTED_REREAD_MS = 5 * 60_000;

interface CacheEntry {
  groups: HostModelGroup[] | null;
  unsupported: boolean;
  readAt: number;
  pending?: Promise<void>;
}

const cache = new Map<string, CacheEntry>();

/** 测试用。 */
export function resetHostModelGroupsCacheForTests(): void {
  cache.clear();
}

type ModelGroupsTransport = Pick<MakerTransport, 'listModelGroups'>;

export function readHostModelGroups(deviceId: string, maker: ModelGroupsTransport): Promise<void> {
  const entry = cache.get(deviceId) ?? { groups: null, unsupported: false, readAt: 0 };
  cache.set(deviceId, entry);
  if (entry.pending) return entry.pending;
  const reuseFor = entry.unsupported ? UNSUPPORTED_REREAD_MS : REREAD_MS;
  if (entry.readAt > 0 && Date.now() - entry.readAt < reuseFor) return Promise.resolve();
  entry.readAt = Date.now();
  const run = maker.listModelGroups()
    .then((raw) => {
      if (raw === null) {
        entry.unsupported = true;
        entry.groups = null;
        return;
      }
      entry.unsupported = false;
      entry.groups = parseCompanionModelGroups(raw) ?? [];
    })
    // 连不上时保留上一次的答案。
    .catch(() => undefined)
    .finally(() => { entry.pending = undefined; });
  entry.pending = run;
  return run;
}

/** 被控电脑的模式；null = 还没读到、读不到，或那台不支持模型组。 */
export function useHostModelGroups(
  deviceId: string | null | undefined,
  maker: ModelGroupsTransport | null | undefined,
  enabled: boolean,
): HostModelGroup[] | null {
  const [, setVersion] = useState(0);
  useEffect(() => {
    if (!enabled || !deviceId || !maker) return;
    let cancelled = false;
    void readHostModelGroups(deviceId, maker).then(() => { if (!cancelled) setVersion((value) => value + 1); });
    return () => { cancelled = true; };
  }, [enabled, deviceId, maker]);
  return enabled && deviceId ? cachedHostModelGroups(deviceId) : null;
}

/** 上次读到的那台电脑的模式；没读到或不支持时为 null。 */
export function cachedHostModelGroups(deviceId: string): HostModelGroup[] | null {
  const entry = cache.get(deviceId);
  return entry && !entry.unsupported ? entry.groups : null;
}

/** 来源数 · 选法 · 推理强度，与电脑上选择器里模型组那一行同一写法。 */
export function hostModelGroupHint(group: HostModelGroup, t: TFunction): string {
  return [t('models.modelGroups.sourceCount', { count: group.sources }), t(`models.modelGroups.strategy.${group.strategy}`),
    group.effort ? t(`models.options.effortLevels.${group.effort}`, { defaultValue: group.effort }) : ''].filter(Boolean).join(' · ');
}

/** 选择器里「模型组」那一段；没有模式时不传。 */
export function useHostModelGroupPickerOptions(
  groups: readonly HostModelGroup[] | null,
  activeId: string | null,
  onSelect: (id: string) => Promise<boolean> | boolean,
  t: TFunction,
): UnifiedMobileModelGroupOptions | undefined {
  return useMemo(() => (groups && groups.length > 0
    ? {
        rows: groups.map((group) => ({ id: group.id, title: group.name, subtitle: hostModelGroupHint(group, t), selected: group.id === activeId })),
        onSelect,
      }
    : undefined), [groups, activeId, onSelect, t]);
}

// —— 选路结果(那台电脑送来的，按不可信数据收) ——

export type HostModelGroupAgentKind = 'cc' | 'codex' | 'pi';

export interface HostModelGroupRoute {
  agentKind: HostModelGroupAgentKind;
  providerId: string;
  model: string;
  agentDeviceId?: string;
  effort?: string;
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

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const str = (value: unknown, max: number): string => (typeof value === 'string' ? value.trim().slice(0, max) : '');
const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

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
    route: { agentKind, providerId, model, ...(agentDeviceId ? { agentDeviceId } : {}), ...(effort ? { effort } : {}) },
    modelName: str(value.modelName, 256) || model,
    sourceName: str(value.sourceName, 256) || providerId,
    why: str(value.why, 32),
    quota: used === null ? null : { usedPercent: used, resetAtMs: num(quota?.resetAtMs) },
    limitedUntilMs: num(picked?.limitedUntilMs),
    exceptions,
  };
}

/**
 * 选到了来源：这次新建按它建(引擎、模型、来源、推理强度、运行位置)，不带 Fast、不走插件引擎；
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
    fastMode: false,
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
  context?: { hasImages?: boolean },
  location?: { agentDeviceId: string | null },
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
    case 'order': case 'rotate': case 'only': case 'cheapest': case 'cheapestFree':
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
 * 全部尽力而为：失败只影响撞配额时的提议与那行说明，任务照常。
 */
export function applyHostModelGroupResult(
  maker: ApplyTransport,
  sessionId: string,
  groupId: string,
  result: HostModelGroupResult | null,
  note: Record<string, unknown> | null,
): void {
  if (!result) return;
  if (result.decisionId) void maker.commitModelGroupDecision(result.decisionId).catch(() => undefined);
  if (result.outcome === 'routed') {
    const { route } = result;
    void maker.bindModelGroupSession({
      sessionId,
      selection: { type: 'route', id: groupId },
      route: {
        agentKind: route.agentKind, providerId: route.providerId, model: route.model,
        ...(route.agentDeviceId ? { agentDeviceId: route.agentDeviceId } : {}),
      },
    }).catch(() => undefined);
  }
  if (note) void maker.writeModelGroupRouteNote({ sessionId, note }).catch(() => undefined);
}
