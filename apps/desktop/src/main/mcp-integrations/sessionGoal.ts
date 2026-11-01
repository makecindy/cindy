import type { LiziMcpSessionContext, SessionGoalCallbacks } from '@cindy/mcps';
import {
  GoalControllerInputError,
  GoalControllerDisposedError,
  GoalSessionRestoreError,
  GoalUpdateSupersededError,
  type GoalController,
} from '../goal-host/controller.js';
import { assertTaskActionCurrent, captureTaskActionSyncGuard, isTaskActionRevoked } from '../maker-ipc/taskActionAuthorization.js';

/** Reuse GoalController edits and its persistence/broadcast lifecycle without dispatching user input. */
export function createSessionGoalCallbacks(deps: {
  getController(): Pick<GoalController, 'getStatus' | 'updateGoal'> | null;
  isCurrentSession(context: LiziMcpSessionContext): boolean;
  withAccess<T>(sessionId: string, operation: (assertCurrent: () => Promise<void>) => Promise<T>): Promise<T>;
}): SessionGoalCallbacks {
  const run = async (context: LiziMcpSessionContext, objective?: string) => {
    if (!context.sessionId) return { ok: false as const, errorCode: 'NO_SESSION_CONTEXT', message: '当前调用没有绑定 Cindy 任务。' };
    const sessionId = context.sessionId;
    const actionGuard = objective === undefined ? undefined : captureTaskActionSyncGuard();
    const assertSessionCurrent = () => {
      if (!deps.isCurrentSession(context)) throw new GoalControllerDisposedError();
    };
    try {
      assertSessionCurrent();
      return await deps.withAccess(sessionId, async (assertCurrent) => {
        const controller = deps.getController();
        if (!controller) return { ok: false as const, errorCode: 'HOST_NOT_READY', message: '目标服务尚未就绪，请稍后重试。' };
        await assertCurrent();
        if (objective !== undefined) await assertTaskActionCurrent();
        assertSessionCurrent();
        if (deps.getController() !== controller) throw new GoalControllerDisposedError();
        const assertMutationCurrent = () => {
          actionGuard?.();
          assertSessionCurrent();
          if (deps.getController() !== controller) throw new GoalControllerDisposedError();
        };
        const goal = objective === undefined
          ? await controller.getStatus(sessionId)
          : await controller.updateGoal(sessionId, { objective }, assertMutationCurrent);
        await assertCurrent();
        actionGuard?.();
        assertSessionCurrent();
        if (deps.getController() !== controller) throw new GoalControllerDisposedError();
        return { ok: true as const, goal };
      });
    } catch (error) {
      if (error instanceof GoalControllerInputError)
        return { ok: false as const, errorCode: 'INVALID_ARGS', message: error.message };
      if (isTaskActionRevoked(error) || error instanceof GoalSessionRestoreError || error instanceof GoalUpdateSupersededError || error instanceof GoalControllerDisposedError)
        return { ok: false as const, errorCode: 'PRECONDITION_FAILED', message: '目标状态已变化，请先用 get_goal 重新读取再决定是否重试。' };
      return { ok: false as const, errorCode: 'INTERNAL', message: '无法确认目标操作结果，请先用 get_goal 查询再决定是否重试。' };
    }
  };
  return {
    get: (context) => run(context),
    update: async (context, objective) => {
      const result = await run(context, objective);
      if (!result.ok) return result;
      if (!result.goal)
        return { ok: false, errorCode: 'GOAL_NOT_FOUND', message: '当前任务没有目标，请先在 Cindy 中开启目标模式。' };
      return { ok: true, goal: result.goal };
    },
  };
}
