/**
 * registerMakerForkIpc — maker:fork
 *
 * Stage 2 C2: 把老 local-db:sessions:fork 搬到 maker.* 命名空间。
 * 业务函数 (apps/desktop/src/main/maker-orchestration/fork.ts) 不变, 只是 IPC 入口换源。
 *
 * 错误码映射 (与老 local-db:sessions:fork 一致):
 *   SOURCE_NOT_FOUND / MESSAGE_NOT_FOUND  → NOT_FOUND
 *   NOT_USER_MESSAGE                       → INVALID_PARAMS
 *   SOURCE_NEVER_RAN / NO_PRIOR_ASSISTANT / CODEX_FORK_STATE_UNAVAILABLE → 同名透传
 *
 * fork 点支持 user / assistant 消息 (语义区别见 forkSessionAtMessage doc)。
 */

import { ipcMain } from 'electron';

import { createLogger } from '../logger.js';
import { forkSessionAtMessage, forkSessionStripEncrypted } from '../maker-orchestration/fork.js';
import { requireString, throwIpcError } from '../utils/ipcValidate.js';
import { emitSessionCreated } from '../localDb/ipc/sessionCreatedBroadcast.js';

import { MAKER_INVOKE } from './channels.js';

const log = createLogger('maker-ipc/fork');

/**
 * 广播「新会话已建」给所有窗口 + device-link tap(转发给订阅 `sessions` topic 的控制端)。
 * 统一走 emitSessionCreated，避免 fork 会话在被控端 / 其它控制端侧边栏凭空消失。
 */
function broadcastSessionCreated(sessionId: string): void {
  emitSessionCreated(sessionId);
}

export function registerMakerForkIpc(): void {
  ipcMain.handle(
    MAKER_INVOKE.FORK,
    async (
      _event: Electron.IpcMainInvokeEvent,
      sourceSessionId: unknown,
      messageClientId: unknown,
    ) => {
      const sid = requireString(sourceSessionId, 'sourceSessionId');
      const mid = requireString(messageClientId, 'messageClientId');
      try {
        const session = await forkSessionAtMessage(sid, mid);
        broadcastSessionCreated(session.id);
        return session;
      } catch (err) {
        const code = (err as { code?: string }).code;
        const msg = err instanceof Error ? err.message : String(err);
        log.warn('fork failed', { sourceSessionId: sid, messageClientId: mid, code, error: msg });
        switch (code) {
          case 'SOURCE_NOT_FOUND':
          case 'MESSAGE_NOT_FOUND':
            throwIpcError('NOT_FOUND', msg);
            break;
          case 'NOT_USER_MESSAGE':
            throwIpcError('INVALID_PARAMS', msg);
            break;
          case 'SOURCE_NEVER_RAN':
            throwIpcError('SOURCE_NEVER_RAN', '原会话尚未运行，无法 fork');
            break;
          case 'NO_PRIOR_ASSISTANT':
            throwIpcError('NO_PRIOR_ASSISTANT', '请在 AI 回复之后的提问上 fork');
            break;
          case 'CODEX_FORK_STATE_UNAVAILABLE':
            throwIpcError('CODEX_FORK_STATE_UNAVAILABLE', msg);
            break;
          case 'UNSUPPORTED_HISTORY':
            throwIpcError('FORK_UNSUPPORTED_HISTORY', msg);
            break;
          default:
            throw err;
        }
      }
    },
  );

  ipcMain.handle(
    MAKER_INVOKE.FORK_STRIP_ENCRYPTED,
    async (_event: Electron.IpcMainInvokeEvent, sourceSessionId: unknown) => {
      const sid = requireString(sourceSessionId, 'sourceSessionId');
      try {
        const session = await forkSessionStripEncrypted(sid);
        broadcastSessionCreated(session.id);
        return session;
      } catch (err) {
        const code = (err as { code?: string }).code;
        const msg = err instanceof Error ? err.message : String(err);
        log.warn('fork strip encrypted failed', { sourceSessionId: sid, code, error: msg });
        switch (code) {
          case 'SOURCE_NOT_FOUND':
            throwIpcError('NOT_FOUND', msg);
            break;
          case 'NOT_CODEX_SESSION':
          case 'REMOTE_NOT_SUPPORTED':
            throwIpcError('INVALID_PARAMS', msg);
            break;
          case 'SOURCE_NEVER_RAN':
            throwIpcError('SOURCE_NEVER_RAN', '原会话尚未运行，无法 fork');
            break;
          case 'CODEX_FORK_STATE_UNAVAILABLE':
            throwIpcError('CODEX_FORK_STATE_UNAVAILABLE', msg);
            break;
          case 'UNSUPPORTED_HISTORY':
            throwIpcError('FORK_UNSUPPORTED_HISTORY', msg);
            break;
          default:
            throw err;
        }
      }
    },
  );
}
