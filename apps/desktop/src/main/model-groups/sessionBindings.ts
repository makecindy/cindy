/**
 * 哪个任务是经哪条路线建的：<userData>/owners/<账号>/model-group-session-bindings.json，
 * `{ bindings: { [任务 id]: { selection, pickedKey, at } } }`，最多保留最新的 MODEL_GROUP_SESSION_BINDINGS_MAX 条。
 * 只记组的 id 与选中的候选(引擎 + 供应商连接 ID + 模型，以及不在本机时的运行位置)，不记消息、任务标题、账号或凭证。
 * 账号作用域未提交时不读不写；文件坏了按没有记录处理，下次写入覆盖。旧版经模式建的记录读取时丢弃。
 * 用途：任务撞上配额时，提示「换到同一条路线里的下一个来源继续」(model-groups.md §6.1)。
 */
import { readFile } from 'node:fs/promises';
import {
  findModelGroupRoute,
  MODEL_GROUP_LIMITS,
  modelGroupAutoSwitchOn,
  modelGroupCandidateKey,
  sanitizeModelGroupSelection,
  type ModelGroupAgentKind,
  type ModelGroupsConfig,
  type ModelGroupSelection,
  type ModelGroupSessionBindingView,
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
  try {
    return activeDataOwnerId() ? ownerScopedPath(FILE_NAME) : null;
  } catch {
    return null;
  }
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

type Bindings = Map<string, ModelGroupSessionBinding>;

function parseBindings(content: string | null): Bindings {
  const out: Bindings = new Map();
  if (!content) return out;
  const raw = (JSON.parse(content) as { bindings?: unknown })?.bindings;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [sessionId, value] of Object.entries(raw)) {
    const entry = binding(value);
    if (validSessionId(sessionId) && entry) out.set(sessionId, entry);
  }
  return out;
}

function readFrom(file: string): Bindings {
  try {
    return parseBindings(readAtomicFileSync(file));
  } catch (error) {
    log.warn('model group session bindings unreadable; treating as none', { error: error instanceof Error ? error.name : 'unknown' });
    return new Map();
  }
}

// Keep the current owner's bounded index. An in-flight read is shared by dispatches.
// Windows may have only the backup after an interrupted atomic replacement.
let dispatchIndex: { file: string; entries: Promise<Bindings> } | undefined;
let syncCache: { file: string; entries: Bindings } | undefined;
const bindingListeners = new Set<(sessionId: string) => void>();

export function subscribeModelGroupSessionBindings(listener: (sessionId: string) => void): () => void {
  bindingListeners.add(listener);
  return () => { bindingListeners.delete(listener); };
}

function notifyBindingChanged(sessionId: string): void {
  for (const listener of bindingListeners) {
    try {
      listener(sessionId);
    } catch (error) {
      log.warn('model group binding listener failed', { sessionId, error: error instanceof Error ? error.message : String(error) });
    }
  }
}

async function readIfPresent(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function loadDispatchIndex(file: string): Promise<Bindings> {
  const loaded = parseBindings(await readIfPresent(file) ?? await readIfPresent(`${file}.bak`));
  if (file === filePath()) syncCache = { file, entries: new Map(loaded) };
  return loaded;
}

export async function readModelGroupBindingForDispatch(sessionId: string): Promise<ModelGroupSessionBinding | null> {
  const file = filePath();
  if (!file || !validSessionId(sessionId)) return null;
  while (file === filePath()) {
    if (dispatchIndex?.file !== file) dispatchIndex = { file, entries: loadDispatchIndex(file) };
    const current = dispatchIndex;
    try {
      const entries = await current.entries;
      if (dispatchIndex === current && file === filePath()) return entries.get(sessionId) ?? null;
    } catch (error) {
      if (dispatchIndex !== current) continue;
      dispatchIndex = undefined;
      log.warn('model group dispatch index unreadable', { error: error instanceof Error ? error.name : 'unknown' });
      return null;
    }
  }
  return null;
}

function writeTo(file: string, bindings: Map<string, ModelGroupSessionBinding>): void {
  const newest = [...bindings.entries()]
    .sort((a, b) => b[1].at - a[1].at)
    .slice(0, MODEL_GROUP_SESSION_BINDINGS_MAX);
  const nextMap = new Map(newest);
  try {
    atomicWriteFileSync(file, JSON.stringify({ bindings: Object.fromEntries(newest) }));
    dispatchIndex = { file, entries: Promise.resolve(new Map(nextMap)) };
    syncCache = { file, entries: nextMap };
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
  notifyBindingChanged(sessionId);
}

/** 解除任务的智能路由托管绑定(保留当前模型，不再自动换源)；原本没绑定时返回 false。 */
export function unbindModelGroupSession(sessionId: string): boolean {
  const file = filePath();
  if (!file || !validSessionId(sessionId)) return false;
  const bindings = readFrom(file);
  if (!bindings.delete(sessionId)) return false;
  writeTo(file, bindings);
  notifyBindingChanged(sessionId);
  return true;
}

export function readModelGroupSessionBinding(sessionId: string): ModelGroupSessionBinding | null {
  const file = filePath();
  if (!file || !validSessionId(sessionId)) return null;
  const bindings = readFrom(file);
  syncCache = { file, entries: bindings };
  return bindings.get(sessionId) ?? null;
}

/** 供会话投影同步读取缓存中的任务托管绑定，避免高频读取重复碰磁盘。 */
export function peekModelGroupSessionBinding(sessionId: string): ModelGroupSessionBinding | null {
  const file = filePath();
  if (!file || !validSessionId(sessionId)) return null;
  if (syncCache?.file !== file) {
    syncCache = { file, entries: readFrom(file) };
  }
  return syncCache.entries.get(sessionId) ?? null;
}

export function projectModelGroupSessionBinding(params: {
  binding: ModelGroupSessionBinding | null;
  config: ModelGroupsConfig;
  current?: { agentKind?: string | null; providerId?: string | null; model?: string | null; agentDeviceId?: string | null } | null;
  pending?: { agentKind?: string | null; providerId?: string | null; model?: string | null; agentDeviceId?: string | null } | null;
}): ModelGroupSessionBindingView | null {
  const { binding: entry, config, current, pending } = params;
  if (!entry) return null;
  const route = findModelGroupRoute(config, entry.selection);
  if (!route) return null;
  const matches = (target?: { agentKind?: string | null; providerId?: string | null; model?: string | null; agentDeviceId?: string | null } | null) => {
    if (!target || !target.providerId || !target.model) return false;
    const kind = target.agentKind === 'claude-code' ? 'cc' : target.agentKind;
    if (kind !== 'cc' && kind !== 'codex' && kind !== 'pi') return false;
    return modelGroupCandidateKey({
      agentKind: kind as ModelGroupAgentKind,
      providerId: target.providerId,
      model: target.model,
      agentDeviceId: target.agentDeviceId || undefined,
    }) === entry.pickedKey;
  };
  const matchedCurrent = matches(current);
  const matchedPending = !matchedCurrent && matches(pending);
  if (!matchedCurrent && !matchedPending) return null;
  return {
    selection: entry.selection,
    routeName: route.parent?.name ?? route.name,
    ...(route.parent ? { parentId: route.parent.id, parentName: route.parent.name, isSourceRoute: true as const } : {}),
    autoSwitch: modelGroupAutoSwitchOn(route),
    ...(matchedPending ? { pendingSwitch: true as const } : {}),
  };
}
