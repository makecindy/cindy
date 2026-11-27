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
type Detached = Map<string, number>;
interface BindingsState {
  bindings: Bindings;
  detached: Detached;
}

function emptyState(): BindingsState {
  return { bindings: new Map(), detached: new Map() };
}

function cloneState(state: BindingsState): BindingsState {
  return { bindings: new Map(state.bindings), detached: new Map(state.detached) };
}

function parseState(content: string | null): BindingsState {
  const out = emptyState();
  if (!content) return out;
  const parsed = JSON.parse(content) as { bindings?: unknown; detached?: unknown };
  const rawBindings = parsed?.bindings;
  if (rawBindings && typeof rawBindings === 'object' && !Array.isArray(rawBindings)) {
    for (const [sessionId, value] of Object.entries(rawBindings)) {
      const entry = binding(value);
      if (validSessionId(sessionId) && entry) out.bindings.set(sessionId, entry);
    }
  }
  const rawDetached = parsed?.detached;
  if (rawDetached && typeof rawDetached === 'object' && !Array.isArray(rawDetached)) {
    for (const [sessionId, value] of Object.entries(rawDetached)) {
      if (validSessionId(sessionId) && typeof value === 'number' && Number.isFinite(value) && !out.bindings.has(sessionId)) {
        out.detached.set(sessionId, value);
      }
    }
  }
  return out;
}

function readFrom(file: string): BindingsState {
  try {
    return parseState(readAtomicFileSync(file));
  } catch (error) {
    log.warn('model group session bindings unreadable; treating as none', { error: error instanceof Error ? error.name : 'unknown' });
    return emptyState();
  }
}

// Keep the current owner's bounded index. An in-flight read is shared by dispatches.
// Windows may have only the backup after an interrupted atomic replacement.
let dispatchIndex: { file: string; state: Promise<BindingsState> } | undefined;
let syncCache: { file: string; state: BindingsState } | undefined;
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

async function loadDispatchIndex(file: string): Promise<BindingsState> {
  const loaded = parseState(await readIfPresent(file) ?? await readIfPresent(`${file}.bak`));
  if (file === filePath()) syncCache = { file, state: cloneState(loaded) };
  return loaded;
}

async function readDispatchState(): Promise<BindingsState | null> {
  const file = filePath();
  if (!file) return null;
  while (file === filePath()) {
    if (dispatchIndex?.file !== file) dispatchIndex = { file, state: loadDispatchIndex(file) };
    const current = dispatchIndex;
    try {
      const state = await current.state;
      if (dispatchIndex === current && file === filePath()) return state;
    } catch (error) {
      if (dispatchIndex !== current) continue;
      dispatchIndex = undefined;
      log.warn('model group dispatch index unreadable', { error: error instanceof Error ? error.name : 'unknown' });
      return null;
    }
  }
  return null;
}

export async function readModelGroupBindingForDispatch(sessionId: string): Promise<ModelGroupSessionBinding | null> {
  if (!validSessionId(sessionId)) return null;
  const state = await readDispatchState();
  return state?.bindings.get(sessionId) ?? null;
}

export async function isModelGroupSessionDetachedForDispatch(sessionId: string): Promise<boolean> {
  if (!validSessionId(sessionId)) return false;
  const state = await readDispatchState();
  return state?.detached.has(sessionId) === true;
}

function writeTo(file: string, state: BindingsState): void {
  const newestBindings = [...state.bindings.entries()]
    .sort((a, b) => b[1].at - a[1].at)
    .slice(0, MODEL_GROUP_SESSION_BINDINGS_MAX);
  const newestDetached = [...state.detached.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MODEL_GROUP_SESSION_BINDINGS_MAX);
  const nextState: BindingsState = {
    bindings: new Map(newestBindings),
    detached: new Map(newestDetached),
  };
  try {
    atomicWriteFileSync(file, JSON.stringify({
      bindings: Object.fromEntries(newestBindings),
      ...(newestDetached.length > 0 ? { detached: Object.fromEntries(newestDetached) } : {}),
    }));
    dispatchIndex = { file, state: Promise.resolve(cloneState(nextState)) };
    syncCache = { file, state: nextState };
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
  const state = readFrom(file);
  state.bindings.set(sessionId, entry);
  state.detached.delete(sessionId);
  writeTo(file, state);
  notifyBindingChanged(sessionId);
}

/** 解除任务的智能路由托管绑定(保留当前模型，不再自动换源)；同时记下解除标记，避免伙伴会话回落主槽重新接管。 */
export function unbindModelGroupSession(sessionId: string, now: number = Date.now()): boolean {
  const file = filePath();
  if (!file || !validSessionId(sessionId)) return false;
  const state = readFrom(file);
  const hadBinding = state.bindings.delete(sessionId);
  const wasDetached = state.detached.has(sessionId);
  state.detached.set(sessionId, now);
  if (hadBinding || !wasDetached) {
    writeTo(file, state);
    notifyBindingChanged(sessionId);
  }
  return hadBinding;
}

/** 归档或删除任务时彻底清理托管绑定与解除标记，避免终态任务占用槽位。 */
export function clearModelGroupSessionState(sessionId: string): void {
  const file = filePath();
  if (!file || !validSessionId(sessionId)) return;
  const state = readFrom(file);
  const removedBinding = state.bindings.delete(sessionId);
  const removedDetached = state.detached.delete(sessionId);
  if (!removedBinding && !removedDetached) return;
  writeTo(file, state);
  notifyBindingChanged(sessionId);
}

export function isModelGroupSessionDetached(sessionId: string): boolean {
  const file = filePath();
  if (!file || !validSessionId(sessionId)) return false;
  if (syncCache?.file !== file) {
    syncCache = { file, state: readFrom(file) };
  }
  return syncCache.state.detached.has(sessionId);
}

export function readModelGroupSessionBinding(sessionId: string): ModelGroupSessionBinding | null {
  const file = filePath();
  if (!file || !validSessionId(sessionId)) return null;
  const state = readFrom(file);
  syncCache = { file, state };
  return state.bindings.get(sessionId) ?? null;
}

/** 供会话投影同步读取缓存中的任务托管绑定，避免高频读取重复碰磁盘。 */
export function peekModelGroupSessionBinding(sessionId: string): ModelGroupSessionBinding | null {
  const file = filePath();
  if (!file || !validSessionId(sessionId)) return null;
  if (syncCache?.file !== file) {
    syncCache = { file, state: readFrom(file) };
  }
  return syncCache.state.bindings.get(sessionId) ?? null;
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
