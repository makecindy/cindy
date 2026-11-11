/**
 * 模型组在界面这一侧的读写：设置页改完后，选择器不用重开就能看到；新任务发出前把选中的一项解析成具体模型，
 * 并在第一条消息下方写一行用了谁、为什么。配置的事实源在主进程(main/model-groups)。
 */
import { useEffect, useSyncExternalStore } from 'react';
import type { TFunction } from 'i18next';

import type { PluginModelRouteNote } from '@/lib/ccAgent.types';
import { createLogger } from '@/lib/logger';

import {
  MODEL_GROUPS_DEFAULTS,
  type ModelGroupAppliedException,
  type ModelGroupResolveRequest,
  type ModelGroupResolveResult,
  type ModelGroupSelection,
  type ModelGroupsConfig,
  type ModelGroupTraceEntry,
} from '../../../shared/modelGroups';

const log = createLogger('model-groups');

let current: ModelGroupsConfig = MODEL_GROUPS_DEFAULTS;
let loaded = false;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

function publish(next: ModelGroupsConfig): void {
  current = next;
  loaded = true;
  for (const listener of listeners) listener();
}

export function refreshModelGroups(): Promise<void> {
  loading ??= window.electronAPI.modelGroups.get()
    .then(publish)
    .catch((err: unknown) => log.warn('model groups unavailable', err))
    .finally(() => { loading = null; });
  return loading;
}

export async function saveModelGroups(next: ModelGroupsConfig): Promise<ModelGroupsConfig> {
  const saved = await window.electronAPI.modelGroups.set(next);
  publish(saved);
  return saved;
}

/** 当前账号的模型组；每次挂载重新读一次，覆盖换账号和别的窗口里的修改。 */
export function useModelGroups(enabled = true): { config: ModelGroupsConfig; loaded: boolean } {
  const config = useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    () => current,
  );
  useEffect(() => { if (enabled) void refreshModelGroups(); }, [enabled]);
  return { config: enabled ? config : MODEL_GROUPS_DEFAULTS, loaded };
}

export async function resolveModelGroup(
  selection: ModelGroupSelection,
  context?: ModelGroupResolveRequest['context'],
): Promise<ModelGroupResolveResult | null> {
  try {
    return await window.electronAPI.modelGroups.resolve({ selection, ...(context ? { context } : {}) });
  } catch (err) {
    log.warn('model group resolve failed', err);
    return null;
  }
}

function formatReset(ms: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(ms);
}

/** 一个候选为什么被选中、没轮到或被跳过；任务里的说明与设置页「试一下」共用。 */
export function modelGroupWhyText(
  entry: Pick<ModelGroupTraceEntry, 'why' | 'quota' | 'limitedUntilMs'>,
  t: TFunction,
  locale: string,
): string {
  const left = entry.quota ? Math.max(0, Math.round(100 - entry.quota.usedPercent)) : null;
  const reset = entry.quota?.resetAtMs ? formatReset(entry.quota.resetAtMs, locale) : null;
  if (entry.why === 'expiring') {
    return left !== null && reset
      ? t('modelGroups.why.expiringQuota', { left, reset })
      : t('modelGroups.why.expiring');
  }
  if (entry.why === 'limited' || entry.why === 'soonest') {
    return entry.limitedUntilMs
      ? t(`modelGroups.why.${entry.why}Until`, { reset: formatReset(entry.limitedUntilMs, locale) })
      : t(`modelGroups.why.${entry.why}`);
  }
  if (entry.why === 'standby' && left !== null && reset) return t('modelGroups.why.standbyQuota', { left, reset });
  return t(`modelGroups.why.${entry.why}`);
}

/** 起作用的例外，用一句话说明；改走路线与按图片筛可以同时出现。 */
export function modelGroupExceptionText(exceptions: readonly ModelGroupAppliedException[] | undefined, t: TFunction): string {
  return (exceptions ?? []).map((item) => (item.type === 'hours'
    ? t('modelGroups.why.exceptionHours', { name: item.viaRouteName ?? '' })
    : t(`modelGroups.why.${item.type === 'image' ? 'exceptionImage' : 'exceptionImageFallback'}`))).join(t('modelGroups.why.separator'));
}

/**
 * 第一条消息下方的一行说明，沿用「让插件选」的说明卡(手机端同样能读)：routed 写用了哪个模型和来源、为什么；
 * 里面没有能用的模型时写明沿用了原来的模型。组已被删除时不写。
 */
export function writeModelGroupRouteNote(
  sessionId: string,
  result: ModelGroupResolveResult | null,
  keptModelName: string,
  t: TFunction,
  locale: string,
): void {
  if (!result || result.outcome === 'missing') return;
  const note: PluginModelRouteNote = result.outcome === 'routed'
    ? {
        pluginName: result.groupName,
        outcome: 'routed',
        modelName: `${result.modelName} · ${result.sourceName}`,
        ...(result.route.effort ? { effort: result.route.effort } : {}),
        reason: [
          modelGroupExceptionText(result.exceptions, t),
          modelGroupWhyText({ why: result.why, quota: result.quota, limitedUntilMs: result.trace.find((entry) => entry.state === 'picked')?.limitedUntilMs }, t, locale),
        ].filter(Boolean).join(t('modelGroups.why.separator')),
        source: 'model-group',
      }
    : { pluginName: result.groupName, outcome: 'kept', modelName: keptModelName, why: 'unavailable-route', source: 'model-group' };
  const { messages } = window.electronAPI.localDb;
  void (async () => {
    // 首条消息由 main 在开跑时才落库：等到后把说明定在它之后 1ms，排在首条消息下面、回复上面。
    let createdAt: number | undefined;
    for (let attempt = 0; attempt < 40 && createdAt === undefined; attempt += 1) {
      const rows = await messages.list(sessionId, { limit: 10 }).catch(() => null);
      const user = Array.isArray(rows)
        ? (rows as Array<{ role?: unknown; createdAt?: unknown }>).find((row) => row.role === 'user')
        : undefined;
      const userAt = typeof user?.createdAt === 'string' ? Date.parse(user.createdAt) : Number.NaN;
      if (Number.isFinite(userAt)) createdAt = userAt + 1;
      else await new Promise((resolve) => setTimeout(resolve, 250));
    }
    await messages.create(sessionId, {
      clientId: `model-group-route:${sessionId}`,
      role: 'assistant',
      content: '',
      agentMeta: { pluginModelRoute: note },
      ...(createdAt !== undefined ? { createdAt: new Date(createdAt).toISOString() } : {}),
    });
  })().catch((err: unknown) => log.warn('model group route note failed', err));
}
