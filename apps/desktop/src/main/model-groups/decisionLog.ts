/**
 * 模型组「最近的选择」的本机记录：<userData>/owners/<账号>/model-group-decisions.json，`{ decisions: [...] }`，
 * 最新在前、最多 MODEL_GROUP_DECISIONS_MAX 条。只记组、选中的模型与来源(含运行位置)、原因和当时的额度，
 * 不记消息、任务标题、账号或凭证。账号作用域未提交时不读不写。文件坏了按没有记录处理，下次写入覆盖。
 * 旧版经模式(2026-11-11 并入路线)留下的条目读取时丢弃。
 */
import {
  MODEL_GROUP_DECISIONS_MAX,
  type ModelGroupDecision,
} from '../../shared/modelGroupDecisions.js';
import type {
  ModelGroupAgentKind,
  ModelGroupResolveResult,
  ModelGroupSelection,
  ModelGroupTraceQuota,
  ModelGroupTraceWhy,
} from '../../shared/modelGroups.js';
import { createLogger } from '../logger.js';
import { activeDataOwnerId, ownerScopedPath } from '../ownerContext.js';
import { atomicWriteFileSync, readAtomicFileSync } from '../utils/atomicWriteFile.js';

const log = createLogger('model-group-decisions');

const FILE_NAME = 'model-group-decisions.json';
const FIELD_MAX = 256;
const WHY: readonly ModelGroupTraceWhy[] = [
  'expiring', 'order', 'rotate', 'cheapest', 'cheapestFree', 'only', 'soonest', 'standby',
  'off', 'unavailable', 'limited', 'tight', 'noVision',
];

function filePath(): string | null {
  return activeDataOwnerId() ? ownerScopedPath(FILE_NAME) : null;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value.slice(0, FIELD_MAX) : undefined;
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function quota(value: unknown): ModelGroupTraceQuota | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const usedPercent = finite(raw.usedPercent);
  const windowMs = finite(raw.windowMs);
  if (usedPercent === null || windowMs === null) return null;
  return { usedPercent, resetAtMs: finite(raw.resetAtMs), windowMs };
}

function agentKind(value: unknown): ModelGroupAgentKind | undefined {
  return value === 'cc' || value === 'codex' || value === 'pi' ? value : undefined;
}

/** 读盘与写盘的同一道归一：坏条目丢弃，其余照常显示。 */
function decision(value: unknown): ModelGroupDecision | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const at = finite(raw.at);
  const groupId = text(raw.groupId);
  const groupName = text(raw.groupName);
  const groupType = raw.groupType === 'route' ? raw.groupType : null;
  const outcome = raw.outcome === 'routed' || raw.outcome === 'unavailable' ? raw.outcome : null;
  if (at === null || !groupId || !groupName || !groupType || !outcome) return null;
  const entry: ModelGroupDecision = { at, groupType, groupId, groupName, outcome };
  if (outcome === 'routed') {
    const kind = agentKind(raw.agentKind);
    const why = WHY.find((item) => item === raw.why);
    if (kind) entry.agentKind = kind;
    for (const key of ['providerId', 'model', 'agentDeviceId', 'modelName', 'sourceName'] as const) {
      const field = text(raw[key]);
      if (field) entry[key] = field;
    }
    const effort = text(raw.effort);
    if (effort) entry.effort = effort.slice(0, 32);
    if (why) entry.why = why;
    entry.quota = quota(raw.quota);
    const until = finite(raw.limitedUntilMs);
    if (until !== null) entry.limitedUntilMs = until;
  }
  return entry;
}

function readFrom(file: string): ModelGroupDecision[] {
  try {
    const content = readAtomicFileSync(file);
    if (!content) return [];
    const parsed = JSON.parse(content) as { decisions?: unknown };
    if (!Array.isArray(parsed?.decisions)) return [];
    return parsed.decisions
      .map(decision)
      .filter((item): item is ModelGroupDecision => !!item)
      .sort((a, b) => b.at - a.at)
      .slice(0, MODEL_GROUP_DECISIONS_MAX);
  } catch (error) {
    log.warn('model group decisions unreadable; showing none', { error: error instanceof Error ? error.name : 'unknown' });
    return [];
  }
}

/** 当前账号最近的选择，最新在前。 */
export function readModelGroupDecisions(): ModelGroupDecision[] {
  const file = filePath();
  return file ? readFrom(file) : [];
}

/**
 * 记下一次解析的结果。组已被删除（missing）不记；只看会选谁的预览（dryRun）由调用方别调。
 * 写盘失败只记日志，不影响新任务。
 */
export function recordModelGroupDecision(
  selection: ModelGroupSelection,
  result: ModelGroupResolveResult,
  now: number = Date.now(),
): void {
  if (result.outcome === 'missing') return;
  const file = filePath();
  if (!file) return;
  const base = { at: now, groupType: selection.type, groupId: selection.id, groupName: result.groupName };
  const next = decision(result.outcome === 'routed'
    ? {
        ...base,
        outcome: 'routed',
        agentKind: result.route.agentKind,
        providerId: result.route.providerId,
        model: result.route.model,
        agentDeviceId: result.route.agentDeviceId,
        modelName: result.modelName,
        sourceName: result.sourceName,
        effort: result.route.effort,
        why: result.why,
        quota: result.quota,
        limitedUntilMs: result.trace.find((entry) => entry.state === 'picked')?.limitedUntilMs ?? null,
      }
    : { ...base, outcome: 'unavailable' });
  if (!next) return;
  try {
    const decisions = [next, ...readFrom(file)].slice(0, MODEL_GROUP_DECISIONS_MAX);
    atomicWriteFileSync(file, JSON.stringify({ decisions }));
  } catch (error) {
    log.warn('model group decision not saved', { error: error instanceof Error ? error.name : 'unknown' });
  }
}
