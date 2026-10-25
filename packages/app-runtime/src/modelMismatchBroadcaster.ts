

import type { ModelMismatchInfo } from '@cindy/model-providers/modelMismatch';
import type {DbLogger} from '@cindy/runtime-db/logging';import type {OwnerBroadcastTap,BroadcastLocal,DataOwnerBroadcastScope} from './ownerBroadcast.js';import type {createMessageService} from './messageService.js';import type {createMessagePersistence} from './messagePersistBroadcaster.js';export interface ModelMismatchBroadcasterHost extends Pick<ReturnType<typeof createMessageService>,'patchMessageAgentMeta'>,Pick<ReturnType<typeof createMessagePersistence>,'enqueueDurableWrite'> {createLogger(name:string):DbLogger;broadcastTap:OwnerBroadcastTap;broadcastLocal:BroadcastLocal;}

type OwnerScope = DataOwnerBroadcastScope | null;

export interface MessageModelMismatchPayload {
  sessionId: string;
  /** 该轮最后一条 assistant 的 messages.client_id。 */
  clientId: string;
  modelMismatch: ModelMismatchInfo;
}

/** 测试注入用依赖(patch / broadcast 可替换,免 Electron / sqlite)。 */
export interface ModelMismatchDeps {
  patchAgentMeta(
    sessionId: string,
    clientId: string,
    patch: Record<string, unknown>,
  ): Promise<boolean>;
  enqueue<T>(label: string, fn: () => Promise<T> | T): Promise<T>;
  broadcast(payload: MessageModelMismatchPayload): void;
  /** Optional owner-aware broadcast used by production; test doubles may omit it. */
  broadcastWithOwnerScope?(
    payload: MessageModelMismatchPayload,
    ownerScope: OwnerScope,
  ): void;
}
export function createModelMismatchBroadcaster(host:ModelMismatchBroadcasterHost) {
const {patchMessageAgentMeta,enqueueDurableWrite,createLogger,broadcastTap,broadcastLocal}=host;


const log = createLogger('modelMismatchBroadcaster');

/** IPC channel: main → renderer 推单条消息的模型降级标记。 */
const MESSAGE_MODEL_MISMATCH_CHANGED = 'usage:message-model-mismatch';

function captureOwnerScope(): OwnerScope {
  return broadcastTap.captureDataOwnerBroadcastScope?.() ?? null;
}

function isOwnerScopeCurrent(scope: OwnerScope): boolean {
  return scope === null || broadcastTap.isDataOwnerBroadcastScopeCurrent?.(scope) !== false;
}

function broadcastModelMismatchPayload(
  payload: MessageModelMismatchPayload,
  ownerScope: OwnerScope,
): void {
  if (ownerScope === null) {
    broadcastTap.tapWindowBroadcast(MESSAGE_MODEL_MISMATCH_CHANGED, payload);
  } else {
    broadcastTap.tapWindowBroadcast(
      MESSAGE_MODEL_MISMATCH_CHANGED,
      payload,
      ownerScope.ownerStamp,
    );
  }
  if(ownerScope===null)broadcastLocal(MESSAGE_MODEL_MISMATCH_CHANGED,payload);else broadcastLocal(MESSAGE_MODEL_MISMATCH_CHANGED,payload,ownerScope.ownerStamp);
}

const defaultDeps: ModelMismatchDeps = {
  patchAgentMeta: patchMessageAgentMeta,
  enqueue: enqueueDurableWrite,
  broadcast(payload) {
    broadcastModelMismatchPayload(payload, null);
  },
  broadcastWithOwnerScope(payload, ownerScope) {
    broadcastModelMismatchPayload(payload, ownerScope);
  },
};

/**
 * 把一条降级标记写到指定消息的 agent_meta 并广播。
 *
 * - selected / actual 任一为空直接跳过(判定函数不会产出,防御脏输入)。
 * - patch 返回 false(行不存在,典型 rewind 已删)→ 不广播。
 * - 失败只 warn,不影响事件循环(调用方 fire-and-forget)。
 */
async function recordModelMismatchOnMessage(
  args: {
    sessionId: string;
    clientId: string;
    mismatch: ModelMismatchInfo;
  },
  deps: ModelMismatchDeps = defaultDeps,
): Promise<void> {
  const { sessionId, clientId, mismatch } = args;
  if (!sessionId || !clientId) return;
  if (!mismatch?.selected || !mismatch.actual) return;
  const ownerScope = captureOwnerScope();
  try {
    const patched = await deps.enqueue(`model-mismatch:${sessionId}:${clientId}`, () =>
      deps.patchAgentMeta(sessionId, clientId, { modelMismatch: mismatch }),
    );
    if (!patched || !isOwnerScopeCurrent(ownerScope)) return;
    const payload = { sessionId, clientId, modelMismatch: mismatch };
    if (deps.broadcastWithOwnerScope) {
      deps.broadcastWithOwnerScope(payload, ownerScope);
    } else {
      deps.broadcast(payload);
    }
  } catch (err) {
    log.warn('recordModelMismatchOnMessage failed:', err instanceof Error ? err.message : String(err));
  }
}
return {
  MESSAGE_MODEL_MISMATCH_CHANGED,
  recordModelMismatchOnMessage
};
}
