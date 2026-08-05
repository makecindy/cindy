/**
 * modelMismatchBroadcaster —— 把「本轮模型被降级 / 替换」标记挂到该轮最后一条
 * assistant 消息上。
 *
 * 与 turnCostBroadcaster 平行的 per-message 维度模块:turn 结束时 register.ts
 * 用 turn start 的所选模型快照 + done 事件的 modelUsage delta 调
 * detectClaudeModelMismatch(shared 纯函数)判定;命中后本模块把
 * { modelMismatch: { selected, actual } } patch 进 messages.agent_meta
 * (免 migration,历史会话重开也能显示),落库成功后广播给所有窗口,
 * AssistantMessage 据此渲染降级提示行。
 *
 * 写库同样经 messagePersistBroadcaster 的 enqueueDurableWrite 串行 FIFO,
 * 先落库后广播,多窗口 / 后开窗口(历史加载读 agent_meta)同源同值。
 */

import { BrowserWindow } from 'electron';

import type { ModelMismatchInfo } from '../shared/modelMismatch.js';
import { patchMessageAgentMeta } from './localDb/ipc/messages.js';
import { enqueueDurableWrite } from './messagePersistBroadcaster.js';
import { createLogger } from './logger.js';
import { tapWindowBroadcast } from './device-link/broadcast-tap.js';

const log = createLogger('modelMismatchBroadcaster');

/** IPC channel: main → renderer 推单条消息的模型降级标记。 */
export const MESSAGE_MODEL_MISMATCH_CHANGED = 'usage:message-model-mismatch';

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
}

const defaultDeps: ModelMismatchDeps = {
  patchAgentMeta: patchMessageAgentMeta,
  enqueue: enqueueDurableWrite,
  broadcast(payload) {
    tapWindowBroadcast(MESSAGE_MODEL_MISMATCH_CHANGED, payload);
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send(MESSAGE_MODEL_MISMATCH_CHANGED, payload);
      }
    }
  },
};

/**
 * 把一条降级标记写到指定消息的 agent_meta 并广播。
 *
 * - selected / actual 任一为空直接跳过(判定函数不会产出,防御脏输入)。
 * - patch 返回 false(行不存在,典型 rewind 已删)→ 不广播。
 * - 失败只 warn,不影响事件循环(调用方 fire-and-forget)。
 */
export async function recordModelMismatchOnMessage(
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
  try {
    const patched = await deps.enqueue(`model-mismatch:${sessionId}:${clientId}`, () =>
      deps.patchAgentMeta(sessionId, clientId, { modelMismatch: mismatch }),
    );
    if (!patched) return;
    deps.broadcast({ sessionId, clientId, modelMismatch: mismatch });
  } catch (err) {
    log.warn('recordModelMismatchOnMessage failed:', err instanceof Error ? err.message : String(err));
  }
}
