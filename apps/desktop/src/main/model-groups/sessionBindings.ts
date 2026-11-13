/**
 * 哪个任务是经哪条路线建的：<userData>/owners/<账号>/model-group-session-bindings.json，
 * `{ bindings: { [任务 id]: { selection, pickedKey, at } } }`，最多保留最新的 MODEL_GROUP_SESSION_BINDINGS_MAX 条。
 * 只记组的 id 与选中的候选(引擎 + 供应商连接 ID + 模型，以及不在本机时的运行位置)，不记消息、任务标题、账号或凭证。
 * 账号作用域未提交时不读不写；文件坏了按没有记录处理，下次写入覆盖。旧版经模式建的记录读取时丢弃。
 * 用途：任务撞上配额时，提示「换到同一条路线里的下一个来源继续」(model-groups.md §6.1)。
 */
import {
  MODEL_GROUP_LIMITS,
  sanitizeModelGroupSelection,
  type ModelGroupSelection,
} from '../../shared/modelGroups.js';
import { createLogger } from '../logger.js';
import { activeDataOwnerId, ownerScopedPath } from '../ownerContext.js';
import { atomicWriteFileSync, readAtomicFileSync } from '../utils/atomicWriteFile.js';

const log = createLogger('model-group-session-bindings');

const FILE_NAME = 'model-group-session-bindings.json';
export const MODEL_GROUP_SESSION_BINDINGS_MAX = 2000;
const SESSION_ID_MAX = 256;
/** 候选键 = 引擎、供应商连接 ID、模型，另一台电脑或分享来的再加运行位置；各段上限与配置相同。 */
const PICKED_KEY_MAX = MODEL_GROUP_LIMITS.field * 3 + 16;

export interface ModelGroupSessionBinding {
  selection: ModelGroupSelection;
  /** 当前用着的候选：modelGroupCandidateKey。 */
  pickedKey: string;
  at: number;
}

function filePath(): string | null {
  return activeDataOwnerId() ? ownerScopedPath(FILE_NAME) : null;
}

function validSessionId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= SESSION_ID_MAX;
}

function binding(value: unknown): ModelGroupSessionBinding | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const selection = sanitizeModelGroupSelection(raw.selection);
  const pickedKey = typeof raw.pickedKey === 'string' && raw.pickedKey && raw.pickedKey.length <= PICKED_KEY_MAX
    ? raw.pickedKey
    : null;
  const at = typeof raw.at === 'number' && Number.isFinite(raw.at) ? raw.at : null;
  return selection && pickedKey && at !== null ? { selection, pickedKey, at } : null;
}

function readFrom(file: string): Map<string, ModelGroupSessionBinding> {
  const out = new Map<string, ModelGroupSessionBinding>();
  try {
    const content = readAtomicFileSync(file);
    if (!content) return out;
    const parsed = JSON.parse(content) as { bindings?: unknown };
    const raw = parsed?.bindings;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
    for (const [sessionId, value] of Object.entries(raw as Record<string, unknown>)) {
      const entry = binding(value);
      if (validSessionId(sessionId) && entry) out.set(sessionId, entry);
    }
  } catch (error) {
    log.warn('model group session bindings unreadable; treating as none', { error: error instanceof Error ? error.name : 'unknown' });
  }
  return out;
}

function writeTo(file: string, bindings: Map<string, ModelGroupSessionBinding>): void {
  const newest = [...bindings.entries()]
    .sort((a, b) => b[1].at - a[1].at)
    .slice(0, MODEL_GROUP_SESSION_BINDINGS_MAX);
  try {
    atomicWriteFileSync(file, JSON.stringify({ bindings: Object.fromEntries(newest) }));
  } catch (error) {
    log.warn('model group session binding not saved', { error: error instanceof Error ? error.name : 'unknown' });
  }
}

/** 记下(或改写)这个任务来自哪个组、现在用着哪个候选。写盘失败只记日志。 */
export function bindModelGroupSession(
  sessionId: string,
  selection: ModelGroupSelection,
  pickedKey: string,
  now: number = Date.now(),
): void {
  const file = filePath();
  const entry = binding({ selection, pickedKey, at: now });
  if (!file || !validSessionId(sessionId) || !entry) return;
  const bindings = readFrom(file);
  bindings.set(sessionId, entry);
  writeTo(file, bindings);
}

export function readModelGroupSessionBinding(sessionId: string): ModelGroupSessionBinding | null {
  const file = filePath();
  if (!file || !validSessionId(sessionId)) return null;
  return readFrom(file).get(sessionId) ?? null;
}

export function clearModelGroupSessionBinding(sessionId: string): void {
  const file = filePath();
  if (!file || !validSessionId(sessionId)) return;
  const bindings = readFrom(file);
  if (!bindings.delete(sessionId)) return;
  writeTo(file, bindings);
}
