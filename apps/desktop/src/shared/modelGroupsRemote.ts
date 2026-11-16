/**
 * `model-groups:remote`(packages/device-link/src/modelGroups.ts)的请求与回包：在一台电脑上给同账号的另一台电脑
 * 开新任务时，用那台电脑自己的模式。两端都是 Desktop，结构在这里一起维护。
 *
 * - `list`：读那台当前账号的模式(只有用户建的内容，不含额度与凭证)。
 * - `resolve`：请那台按它自己的模式、额度与例外为这次新建选一个来源。只做真正的选路，不提供预览；
 *   不接受运行位置限定(进行中的任务不经这里)。
 * - `commit`：任务在那台建好后提交这次选择(推进「轮流」、记进「最近的选择」)，并可把第一条消息下方那行说明
 *   交给那台写进任务记录。说明的文字由发起端按自己的语言写好，那台只按固定结构收下。
 *
 * 产品规则见 docs/product-rules/model-groups.md「在另一台电脑上开的新任务」。
 */
import {
  MODEL_GROUP_LIMITS,
  modelGroupAgentDeviceId,
  normalizeModelGroupsConfig,
  sanitizeModelGroupSelection,
  type ModelGroupAppliedException,
  type ModelGroupResolveResult,
  type ModelGroupSelection,
  type ModelGroupsConfig,
  type ModelGroupTraceEntry,
  type ModelGroupTraceQuota,
} from './modelGroups.js';

/** 第一条消息下方那行说明，与本机写的 `agentMeta.pluginModelRoute`(source: model-group)同一结构。 */
export interface ModelGroupRemoteNote {
  pluginName: string;
  outcome: 'routed' | 'kept';
  modelName: string;
  effort?: string;
  reason?: string;
  why?: 'unavailable-route';
}

export type ModelGroupsRemoteRequest =
  | { action: 'list' }
  | { action: 'resolve'; selection: ModelGroupSelection; context?: { hasImages: true } }
  | { action: 'commit'; decisionId: string; note?: { sessionId: string } & ModelGroupRemoteNote };

/** 说明里各段文字的上限：模型名连同「供应商 · 电脑」、原因与例外都在一行里，足够长又不让对方写进大段内容。 */
export const MODEL_GROUP_REMOTE_NOTE_LIMITS = { name: 200, reason: 600, effort: MODEL_GROUP_LIMITS.effort, sessionId: 256 } as const;

const REMOTE_INVALID = '[INVALID_PARAMS] invalid model group request';

function text(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.trim() && value.length <= max ? value : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function parseNote(raw: unknown): ({ sessionId: string } & ModelGroupRemoteNote) | null {
  const value = record(raw);
  if (!value) return null;
  const sessionId = text(value.sessionId, MODEL_GROUP_REMOTE_NOTE_LIMITS.sessionId);
  const pluginName = text(value.pluginName, MODEL_GROUP_REMOTE_NOTE_LIMITS.name);
  const modelName = text(value.modelName, MODEL_GROUP_REMOTE_NOTE_LIMITS.name);
  const outcome = value.outcome === 'routed' || value.outcome === 'kept' ? value.outcome : null;
  if (!sessionId || !pluginName || !modelName || !outcome) return null;
  const effort = value.effort === undefined ? undefined : text(value.effort, MODEL_GROUP_REMOTE_NOTE_LIMITS.effort);
  const reason = value.reason === undefined ? undefined : text(value.reason, MODEL_GROUP_REMOTE_NOTE_LIMITS.reason);
  if (effort === null || reason === null) return null;
  if (value.why !== undefined && value.why !== 'unavailable-route') return null;
  return {
    sessionId, pluginName, outcome, modelName,
    ...(effort ? { effort } : {}),
    ...(reason ? { reason } : {}),
    ...(value.why === 'unavailable-route' ? { why: 'unavailable-route' as const } : {}),
  };
}

/** 被控那台收到的请求；结构不对一律拒绝(错误前缀给发起端看，不带请求内容)。 */
export function parseModelGroupsRemoteRequest(raw: unknown): ModelGroupsRemoteRequest {
  const value = record(raw);
  if (value?.action === 'list') return { action: 'list' };
  if (value?.action === 'resolve') {
    const selection = sanitizeModelGroupSelection(value.selection);
    if (!selection) throw new Error(REMOTE_INVALID);
    const context = record(value.context);
    return { action: 'resolve', selection, ...(context?.hasImages === true ? { context: { hasImages: true } } : {}) };
  }
  if (value?.action === 'commit') {
    const decisionId = text(value.decisionId, 64);
    if (!decisionId) throw new Error(REMOTE_INVALID);
    if (value.note === undefined) return { action: 'commit', decisionId };
    const note = parseNote(value.note);
    if (!note) throw new Error(REMOTE_INVALID);
    return { action: 'commit', decisionId, note };
  }
  throw new Error(REMOTE_INVALID);
}

/** 发起端读到的模式列表；结构不对按读不到处理(抛错)，不当成没有模式。 */
export function parseModelGroupsRemoteList(raw: unknown): ModelGroupsConfig {
  const value = record(raw);
  if (!value || !record(value.config)) throw new Error('model groups list malformed');
  return normalizeModelGroupsConfig(value.config);
}

const AGENT_KINDS = new Set(['cc', 'codex', 'pi']);

function parseQuota(raw: unknown): ModelGroupTraceQuota | null {
  const value = record(raw);
  if (!value || typeof value.usedPercent !== 'number' || typeof value.windowMs !== 'number') return null;
  return {
    usedPercent: value.usedPercent,
    resetAtMs: typeof value.resetAtMs === 'number' ? value.resetAtMs : null,
    windowMs: value.windowMs,
  };
}

function parseTrace(raw: unknown): ModelGroupTraceEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item): ModelGroupTraceEntry[] => {
    const value = record(item);
    if (!value || !AGENT_KINDS.has(value.agentKind as string) || typeof value.providerId !== 'string' || typeof value.model !== 'string'
      || typeof value.state !== 'string' || typeof value.why !== 'string') return [];
    const agentDeviceId = value.agentDeviceId === undefined ? undefined : modelGroupAgentDeviceId(value.agentDeviceId);
    if (agentDeviceId === null) return [];
    return [{
      agentKind: value.agentKind as ModelGroupTraceEntry['agentKind'],
      providerId: value.providerId,
      model: value.model,
      ...(agentDeviceId ? { agentDeviceId } : {}),
      modelName: typeof value.modelName === 'string' ? value.modelName : value.model,
      sourceName: typeof value.sourceName === 'string' ? value.sourceName : value.providerId,
      state: value.state as ModelGroupTraceEntry['state'],
      why: value.why as ModelGroupTraceEntry['why'],
      quota: parseQuota(value.quota),
      ...(typeof value.limitedUntilMs === 'number' ? { limitedUntilMs: value.limitedUntilMs } : {}),
    }];
  });
}

/**
 * 发起端读到的选路结果。运行位置是那台电脑视角的(省略 = 那台自己)，原样交给那台建任务。
 * 结构不对时抛错：调用方按「这次没选成」停下，不静默改用原来的模型或本机的模式。
 */
export function parseModelGroupsRemoteResolve(raw: unknown): ModelGroupResolveResult {
  const value = record(raw);
  const groupName = typeof value?.groupName === 'string' ? value.groupName : null;
  const decisionId = typeof value?.decisionId === 'string' && value.decisionId.length <= 64 ? value.decisionId : undefined;
  if (!value || groupName === null) throw new Error('model group result malformed');
  const trace = parseTrace(value.trace);
  if (value.outcome === 'missing' || value.outcome === 'unavailable') {
    return { ...(decisionId ? { decisionId } : {}), outcome: value.outcome, groupName, trace };
  }
  const route = record(value.route);
  if (value.outcome !== 'routed' || !route || !AGENT_KINDS.has(route.agentKind as string)
    || typeof route.providerId !== 'string' || !route.providerId || route.providerId.length > MODEL_GROUP_LIMITS.field
    || typeof route.model !== 'string' || !route.model || route.model.length > MODEL_GROUP_LIMITS.field
    || typeof value.modelName !== 'string' || typeof value.sourceName !== 'string' || typeof value.why !== 'string') {
    throw new Error('model group result malformed');
  }
  const agentDeviceId = route.agentDeviceId === undefined || route.agentDeviceId === null ? undefined : modelGroupAgentDeviceId(route.agentDeviceId);
  const effort = route.effort === undefined ? undefined : text(route.effort, MODEL_GROUP_LIMITS.effort);
  if (agentDeviceId === null || effort === null) throw new Error('model group result malformed');
  const exceptions = Array.isArray(value.exceptions)
    ? value.exceptions.flatMap((item): ModelGroupAppliedException[] => {
        const entry = record(item);
        if (!entry || (entry.type !== 'image' && entry.type !== 'imageFallback' && entry.type !== 'hours')) return [];
        return [{ type: entry.type, ...(typeof entry.viaRouteName === 'string' ? { viaRouteName: entry.viaRouteName } : {}) }];
      })
    : [];
  return {
    ...(decisionId ? { decisionId } : {}),
    outcome: 'routed',
    groupName,
    route: {
      agentKind: route.agentKind as ModelGroupTraceEntry['agentKind'],
      providerId: route.providerId,
      model: route.model,
      ...(agentDeviceId ? { agentDeviceId } : {}),
      ...(effort ? { effort } : {}),
    },
    modelName: value.modelName,
    sourceName: value.sourceName,
    why: value.why as ModelGroupTraceEntry['why'],
    quota: parseQuota(value.quota),
    trace,
    ...(exceptions.length ? { exceptions } : {}),
  };
}
