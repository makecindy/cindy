import { throwIpcError } from '../utils/ipcValidate.js';
import { MAKER_INVOKE } from './channels.js';
import type { IpcHandlerRegistry } from './ipcHandlerRegistry.js';

/** “全部停止”只依赖会话关闭与后台活动清账，避免被任何运行态快照拦截。 */
export interface StopSessionBackgroundTasksHandlerDeps {
  closeSession(sessionId: string): Promise<void>;
  clearBackgroundActivity(sessionId: string): void;
  noteSessionReset(sessionId: string): void;
  notifyGoalStop(sessionId: string): void | Promise<void>;
}

/**
 * 注册会话级强制停止入口。
 *
 * closeSession 会终止当前 turn、常驻 Claude Code 进程及其后台子代理；会话元数据仍保留，
 * 用户下次发送消息时可按原 session resume。这里刻意不检查 isTurnRunning()：这个入口是
 * renderer/main 状态不一致或后台自动续跑时的最终止损手段，必须始终可用。
 */
export function registerStopSessionBackgroundTasksHandler(
  registry: IpcHandlerRegistry,
  deps: StopSessionBackgroundTasksHandlerDeps,
): void {
  registry.handle(
    MAKER_INVOKE.STOP_SESSION_BACKGROUND_TASKS,
    async (_event, sessionId: unknown) => {
      if (typeof sessionId !== 'string') {
        throwIpcError('INVALID_PARAMS', 'sessionId required');
      }

      deps.noteSessionReset(sessionId);
      // notifyGoalStop 调用同步摘 listener/timer，paused 落库可与紧急 close 并行；
      // 不能让存储等待挡住最终止损。
      let goalPause: Promise<void>;
      try {
        goalPause = Promise.resolve(deps.notifyGoalStop(sessionId));
      } catch (error) {
        goalPause = Promise.reject(error);
      }
      const [closeResult, goalPauseResult] = await Promise.allSettled([
        deps.closeSession(sessionId),
        goalPause,
      ]);
      if (closeResult.status === 'fulfilled') {
        // closed 事件的统一清理也会清账；这里显式清一次，确保 renderer 立即收到熄灭广播。
        deps.clearBackgroundActivity(sessionId);
      }
      // close 是主要止损动作：两边同时失败时保留它的原始错误；Goal pause 自身已经
      // 在 register.ts 记录了可诊断日志。任一边失败都不得向 renderer 谎报成功。
      if (closeResult.status === 'rejected') throw closeResult.reason;
      if (goalPauseResult.status === 'rejected') throw goalPauseResult.reason;
      return { ok: true as const };
    },
  );
}
