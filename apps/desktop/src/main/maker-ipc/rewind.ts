/**
 * registerMakerRewindIpc — maker:rewind:preview / maker:rewind:commit
 *
 * Stage 2 C2: 把老 cc-agent:rewind:* 两个 handler 搬到 maker.* 命名空间。
 * 业务函数 (apps/desktop/src/main/maker-orchestration/rewind.ts) 不变, 只是 IPC 入口换源。
 *
 * 错误码透传: SESSION_NOT_FOUND / MESSAGE_NOT_FOUND / NOT_USER_MESSAGE /
 *           NO_PRIOR_ASSISTANT / SESSION_RUNNING / NO_LIVE_QUERY
 */

import { ipcMain } from 'electron';

import { createLogger } from '../logger.js';
import { previewRewindAtMessage, commitRewindAtMessage } from '../maker-orchestration/rewind.js';
import { getGoalController } from '../goal-host/index.js';
import { isIpcError, type IpcErrorCode } from '../../shared/ipc-errors.js';
import { requireString, throwIpcError } from '../utils/ipcValidate.js';

import { MAKER_INVOKE } from './channels.js';
import { withSessionInputStoppedForRewind } from './register.js';
import { agentHandoffPending } from './agentHandoffPendingSingleton.js';

const log = createLogger('maker-ipc/rewind');
const STOPPED_REWIND_RETRY_MS = 100;
const STOPPED_REWIND_TIMEOUT_MS = 15_000;

async function commitAfterStopping(
  sessionId: string,
  clientId: string,
  opts: { requireLatestUser: boolean },
) {
  const deadline = Date.now() + STOPPED_REWIND_TIMEOUT_MS;
  while (true) {
    try {
      return await commitRewindAtMessage(sessionId, clientId, opts);
    } catch (err) {
      if (!isIpcError(err) || err.code !== 'SESSION_RUNNING' || Date.now() >= deadline) {
        throw err;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, STOPPED_REWIND_RETRY_MS));
    }
  }
}

function wrapErr(err: unknown): never {
  const code: IpcErrorCode = isIpcError(err) ? err.code : 'INTERNAL';
  const msg = err instanceof Error ? err.message : String(err);
  throwIpcError(code, msg);
}

export function registerMakerRewindIpc(): void {
  ipcMain.handle(
    MAKER_INVOKE.REWIND_PREVIEW,
    async (
      _event: Electron.IpcMainInvokeEvent,
      sessionId: unknown,
      clientId: unknown,
    ) => {
      const sid = requireString(sessionId, 'sessionId');
      const cid = requireString(clientId, 'clientId');
      try {
        return await previewRewindAtMessage(sid, cid);
      } catch (err) {
        log.warn('rewind:preview failed', { sid, cid, error: String(err) });
        wrapErr(err);
      }
    },
  );

  ipcMain.handle(
    MAKER_INVOKE.REWIND_COMMIT,
    async (
      _event: Electron.IpcMainInvokeEvent,
      sessionId: unknown,
      clientId: unknown,
      opts?: unknown,
    ) => {
      const sid = requireString(sessionId, 'sessionId');
      const cid = requireString(clientId, 'clientId');
      // edit-last-message 专用可选项:要求 target 必须是会话最新 user 消息,
      // 在 main 侧权威校验(renderer 的切片判定有 TOCTOU 窗口)。普通 Rewind
      // 不传 → 保持"可回到任意历史消息"的既有语义。
      const requireLatestUser =
        !!opts && typeof opts === 'object' &&
        (opts as { requireLatestUser?: unknown }).requireLatestUser === true;
      const stopIfRunning =
        !!opts && typeof opts === 'object' &&
        (opts as { stopIfRunning?: unknown }).stopIfRunning === true;
      try {
        // Normal Rewind owns stop -> authoritative idle -> commit as one main
        // transaction. Edit-last-message keeps its existing direct orchestration.
        const result = stopIfRunning
          ? await withSessionInputStoppedForRewind(sid, () =>
              commitAfterStopping(sid, cid, { requireLatestUser }))
          : await commitRewindAtMessage(sid, cid, { requireLatestUser });
        // 回滚后缓存的待注入交接 / fork 来源标记都是按截断前的历史算出来的,丢弃它,
        // 让下次 send 按回滚后的现状重新判定——被回滚掉的正是当初携带来源标记的那一轮时,
        // DB 侧判定会自动重新 arm(它按 rewind_at 过滤)。
        agentHandoffPending.clear(sid);
        // 回滚后会话历史被截断,active 目标若继续就会对着变化后的上下文跑 —— 暂停它
        // (保留计数,用户 review 后可 resume)。fire-and-forget,失败不阻塞 rewind。
        void getGoalController()?.pauseGoal(sid, 'paused: conversation rewound').catch(() => {});
        return result;
      } catch (err) {
        log.warn('rewind:commit failed', { sid, cid, error: String(err) });
        wrapErr(err);
      }
    },
  );
}
