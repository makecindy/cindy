/**
 * apps/desktop/src/main/maker-ipc/goal.ts
 *
 * maker:goal:* IPC handler 注册 + GoalController → renderer 状态广播。
 *
 * 设计(对齐 schedule.ts):
 *   - eager 注册:registerGoalHandlers() 在 registerMakerIpcsAfterSplash 内一次性挂,
 *     不依赖 GoalController 实例;handler 内 getGoalController() 取单例(invoke 时
 *     controller 已由 startGoalController 启动)。
 *   - 错误走 throwIpcError(规则 13),不裸 throw。
 *   - 设目标的主入口是 desktop 命令 /goal(commands/builtins.ts → 直接调
 *     controller.setGoal);GOAL_SET IPC 是给 renderer 主动设目标的备用入口。
 */

import { ipcMain, BrowserWindow } from 'electron';

import { createLogger } from '../logger.js';
import { throwIpcError, requireString, requireObject } from '../utils/ipcValidate.js';
import {
  GoalControllerInputError,
  GoalSessionRestoreError,
  GoalUpdateSupersededError,
} from '../goal-host/controller.js';
import { getGoalController } from '../goal-host/index.js';
import { tapWindowBroadcast } from '../device-link/broadcast-tap.js';
import type { GoalUpdatePatch, GoalStatusUpdate } from '../goal-host/types.js';
import { MAKER_INVOKE, MAKER_PUSH } from './channels.js';

const log = createLogger('maker-ipc:goal');

type GoalLimitPatchKey = 'maxTurns' | 'budgetTokens' | 'noProgressLimit';

function throwGoalControllerIpcError(error: unknown): never {
  if (error instanceof GoalControllerInputError) {
    throwIpcError('INVALID_PARAMS', error.message);
  }
  if (
    error instanceof GoalSessionRestoreError ||
    error instanceof GoalUpdateSupersededError
  ) {
    throwIpcError('PRECONDITION_FAILED', error.message);
  }
  throw error;
}

async function readGoalStatusForIpc(
  controller: NonNullable<ReturnType<typeof getGoalController>>,
  sessionId: string,
) {
  try {
    return await controller.getStatus(sessionId);
  } catch {
    throwIpcError('INTERNAL', 'failed to read goal status');
  }
}

function readOptionalLimit(value: unknown, name: GoalLimitPatchKey, patch: GoalUpdatePatch): void {
  if (value === undefined) return;
  if (value === null || typeof value === 'number') {
    patch[name] = value;
    return;
  }
  throwIpcError('INVALID_PARAMS', `${name} must be a number or null`);
}

/** 读一个必填但可空的上限(GOAL_SET 的 limits 三项)。number|null 直接返回,其它拒绝。 */
function readLimitValue(value: unknown, name: string): number | null {
  if (value === null) return null;
  if (typeof value === 'number') return value;
  throwIpcError('INVALID_PARAMS', `${name} must be a number or null`);
}

/** 广播 goal 状态变化到所有本地窗口(GoalController.emitStatus 经 startGoalController 接到这里)。 */
export function broadcastGoalStatus(update: GoalStatusUpdate): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try {
      win.webContents.send(MAKER_PUSH.GOAL_STATUS_CHANGED, update);
    } catch (e) {
      log.warn(`broadcast goal status failed: ${String(e)}`);
    }
  }
  // 旁路给 device-link 控制端(桌面 / 手机):payload 顶层 sessionId → session:<id> topic,
  // 打开该远程会话的控制端(GoalIndicator / 目标模式状态)据此实时刷新。无控制链路时是 O(1) no-op。
  tapWindowBroadcast(MAKER_PUSH.GOAL_STATUS_CHANGED, update);
}

export function registerGoalHandlers(): void {
  // 设目标(renderer 备用入口;命令路径走 commands/builtins.ts)。新建/编辑都直接生效并续跑。
  ipcMain.handle(MAKER_INVOKE.GOAL_SET, async (_e, input: unknown) => {
    const obj = requireObject(input, 'goal');
    const sessionId = requireString(obj.sessionId, 'sessionId');
    const objective = requireString(obj.objective, 'objective');
    if (!objective.trim()) throwIpcError('INVALID_PARAMS', 'objective must not be empty');
    // 可选 limits(GUI 新建弹窗高级设置)。三项各 number|null;缺省 → controller 走系统默认。
    let limits: { maxTurns: number | null; budgetTokens: number | null; noProgressLimit: number | null } | undefined;
    if (obj.limits !== undefined) {
      const lim = requireObject(obj.limits, 'limits');
      limits = {
        maxTurns: readLimitValue(lim.maxTurns, 'maxTurns'),
        budgetTokens: readLimitValue(lim.budgetTokens, 'budgetTokens'),
        noProgressLimit: readLimitValue(lim.noProgressLimit, 'noProgressLimit'),
      };
    }
    const controller = getGoalController();
    if (!controller) throwIpcError('INTERNAL', 'goal controller not started');
    try {
      await controller.setGoal({ sessionId, objective, ...(limits ? { limits } : {}) });
    } catch (err) {
      throwGoalControllerIpcError(err);
    }
    return { ok: true };
  });

  // 用户清除目标(GoalIndicator ✕ 按钮)。
  ipcMain.handle(MAKER_INVOKE.GOAL_CLEAR, async (_e, sessionId: unknown) => {
    const id = requireString(sessionId, 'sessionId');
    await getGoalController()?.clearGoal(id);
    return { ok: true };
  });

  // 取当前状态(useGoalStatus hook 挂载时拉一次 = 用户打开该会话)。无 goal 返回 null。
  ipcMain.handle(MAKER_INVOKE.GOAL_GET_STATUS, async (_e, sessionId: unknown) => {
    const id = requireString(sessionId, 'sessionId');
    const controller = getGoalController();
    if (!controller) throwIpcError('INTERNAL', 'goal controller not started');
    let status = await readGoalStatusForIpc(controller, id);
    // Dormant recovery may synchronously converge an apparently active Goal to
    // blocked. Wait for storage/session recovery and re-read so this invoke
    // response cannot overwrite the newer status push with a stale active
    // snapshot. Actual turn dispatch stays detached: PI prompt acceptance may
    // legitimately wait through long compaction and must not hold a read query.
    if (status?.status === 'active') {
      try {
        await controller.resumeOnOpen(id, { waitForDispatch: false });
      } catch (error) {
        if (
          error instanceof GoalControllerInputError ||
          error instanceof GoalSessionRestoreError ||
          error instanceof GoalUpdateSupersededError
        ) {
          throwGoalControllerIpcError(error);
        }
        throwIpcError('INTERNAL', 'failed to restore goal status');
      }
      status = await readGoalStatusForIpc(controller, id);
    }
    return status;
  });

  // 暂停 active 目标(GoalIndicator ⏸ 按钮)。非 active 是 no-op,不报错。
  ipcMain.handle(MAKER_INVOKE.GOAL_PAUSE, async (_e, sessionId: unknown) => {
    const id = requireString(sessionId, 'sessionId');
    await getGoalController()?.pauseGoal(id);
    return { ok: true };
  });

  // 恢复 paused/blocked 目标(GoalIndicator ▶ 按钮 / resume-on-open 确认)。
  // 保留计数继续;终态/active 是 no-op。
  ipcMain.handle(MAKER_INVOKE.GOAL_RESUME, async (_e, sessionId: unknown) => {
    const id = requireString(sessionId, 'sessionId');
    try {
      await getGoalController()?.resumeGoal(id);
    } catch (error) {
      throwGoalControllerIpcError(error);
    }
    return { ok: true };
  });

  ipcMain.handle(MAKER_INVOKE.GOAL_UPDATE, async (_e, input: unknown) => {
    const obj = requireObject(input, 'goal');
    const sessionId = requireString(obj.sessionId, 'sessionId');
    const rawPatch = requireObject(obj.patch, 'patch');
    const patch: GoalUpdatePatch = {};
    if (rawPatch.objective !== undefined) {
      patch.objective = requireString(rawPatch.objective, 'objective');
    }
    readOptionalLimit(rawPatch.maxTurns, 'maxTurns', patch);
    readOptionalLimit(rawPatch.budgetTokens, 'budgetTokens', patch);
    readOptionalLimit(rawPatch.noProgressLimit, 'noProgressLimit', patch);
    const controller = getGoalController();
    if (!controller) throwIpcError('INTERNAL', 'goal controller not started');
    try {
      const updated = await controller.updateGoal(sessionId, patch);
      if (!updated) throwIpcError('GOAL_NOT_FOUND', 'goal not found');
      return { ok: true };
    } catch (err) {
      throwGoalControllerIpcError(err);
    }
  });

  log.info('goal IPC handlers registered');
}
