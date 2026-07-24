import { throwIpcError } from '../utils/ipcValidate.js';
import { MAKER_INVOKE } from './channels.js';
import type { IpcHandlerRegistry } from './ipcHandlerRegistry.js';

/** 精确停止只需要拿到 live session 的 stopBackgroundTask;拿不到 = 任务必然已死。 */
export interface StopAgentTaskHandlerDeps {
  getLiveSession(
    sessionId: string,
  ): { stopBackgroundTask(taskId: string): Promise<void> } | undefined;
}

/**
 * 注册单个后台任务的精确停止入口(消息流任务卡 / 状态栏的停止按钮)。
 *
 * 与 STOP_SESSION_BACKGROUND_TASKS(关闭整个 agent 进程的会话级止损)不同:本入口
 * 只停指定 taskId,当前 turn 与其他后台任务不受影响。幂等语义:会话未加载(子进程
 * 不存在,后台任务必然已死)或任务已到终态 → 直接成功;不支持(旧 SDK / 旧远端
 * daemon / 非 claude-code agent)→ UNSUPPORTED_CAPABILITY,按钮不得假装成功。
 */
export function registerStopAgentTaskHandler(
  registry: IpcHandlerRegistry,
  deps: StopAgentTaskHandlerDeps,
): void {
  registry.handle(
    MAKER_INVOKE.STOP_AGENT_TASK,
    async (_event, sessionId: unknown, taskId: unknown) => {
      if (typeof sessionId !== 'string' || !sessionId) {
        throwIpcError('INVALID_PARAMS', 'sessionId required');
      }
      if (typeof taskId !== 'string' || !taskId) {
        throwIpcError('INVALID_PARAMS', 'taskId required');
      }

      const session = deps.getLiveSession(sessionId);
      if (!session) {
        return { ok: true as const };
      }
      try {
        await session.stopBackgroundTask(taskId);
      } catch (e) {
        // NotSupportedError(Session 层)与 claude handle 的 'not supported' 明文
        // 都归一到 UNSUPPORTED_CAPABILITY;其余(stopTask RPC 失败等)走 INTERNAL,
        // 不把内部堆栈原样透出。
        const message = e instanceof Error ? e.message : String(e);
        if ((e instanceof Error && e.name === 'NotSupportedError') || /not supported/i.test(message)) {
          throwIpcError('UNSUPPORTED_CAPABILITY', 'stopBackgroundTask is not supported for this session');
        }
        throwIpcError('INTERNAL', `failed to stop background task: ${message}`);
      }
      return { ok: true as const };
    },
  );
}
