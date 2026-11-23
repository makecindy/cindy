/**
 * 模型组在任务里写的那一行说明(model-groups.md §6)：用了哪个模型和来源、为什么；里面没有能用的模型时写明沿用了原来的模型。
 * 新任务(界面)与定时任务(主进程)共用这一份文字，两边写出来一样。只用传进来的翻译函数，不依赖界面。
 */
import type {
  ModelGroupAppliedException,
  ModelGroupResolveResult,
  ModelGroupRouteNote,
  ModelGroupTraceEntry,
} from './modelGroups.js';

/** 主进程与界面的翻译函数都满足这个形状。 */
export type ModelGroupTranslate = (key: string, values?: Record<string, unknown>) => string;

/** 按运行位置(另一台电脑或分享)取名字；本机来源不调用。 */
export type ModelGroupLocationName = (agentDeviceId: string) => string;

/** 说明卡的内容，与「让插件选」的说明卡同形(手机端同样能读)。 */
export type ModelGroupRouteNoteBody = ModelGroupRouteNote;

function formatReset(ms: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(ms);
}

/** 一个候选为什么被选中、没轮到或被跳过；任务里的说明与设置页「试一下」共用。 */
export function modelGroupWhyText(
  entry: Pick<ModelGroupTraceEntry, 'why' | 'quota' | 'limitedUntilMs'>,
  t: ModelGroupTranslate,
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
export function modelGroupExceptionText(exceptions: readonly ModelGroupAppliedException[] | undefined, t: ModelGroupTranslate): string {
  return (exceptions ?? []).map((item) => (item.type === 'hours'
    ? t('modelGroups.why.exceptionHours', { name: item.viaRouteName ?? '' })
    : t(`modelGroups.why.${item.type === 'image' ? 'exceptionImage' : 'exceptionImageFallback'}`))).join(t('modelGroups.why.separator'));
}

/**
 * 来源的名字：本机就是供应商名；另一台电脑或分享来的写成「供应商 · 那台电脑」，与模型选择器里远程那几行的写法相同。
 */
export function modelGroupSourceLabel(
  entry: { sourceName: string; agentDeviceId?: string | null },
  locationName: ModelGroupLocationName,
  t: ModelGroupTranslate,
): string {
  return entry.agentDeviceId
    ? t('newChat.modelSelector.unified.railRemoteProvider', { provider: entry.sourceName, device: locationName(entry.agentDeviceId) })
    : entry.sourceName;
}

/** 说明卡内容；组已被删除时不写(返回 null)。 */
export function buildModelGroupRouteNote(
  result: ModelGroupResolveResult | null,
  keptModelName: string,
  t: ModelGroupTranslate,
  locale: string,
  locationName: ModelGroupLocationName,
): ModelGroupRouteNoteBody | null {
  if (!result || result.outcome === 'missing') return null;
  if (result.outcome !== 'routed') {
    return { pluginName: result.groupName, outcome: 'kept', modelName: keptModelName, why: 'unavailable-route', source: 'model-group' };
  }
  return {
    pluginName: result.groupName,
    outcome: 'routed',
    modelName: `${result.modelName} · ${modelGroupSourceLabel({ sourceName: result.sourceName, agentDeviceId: result.route.agentDeviceId }, locationName, t)}`,
    ...(result.route.effort ? { effort: result.route.effort } : {}),
    reason: [
      modelGroupExceptionText(result.exceptions, t),
      modelGroupWhyText({ why: result.why, quota: result.quota, limitedUntilMs: result.trace.find((entry) => entry.state === 'picked')?.limitedUntilMs }, t, locale),
    ].filter(Boolean).join(t('modelGroups.why.separator')),
    source: 'model-group',
  };
}
