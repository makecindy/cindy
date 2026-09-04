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

import { ipcMain, BrowserWindow, type IpcMainInvokeEvent } from 'electron';

import { createLogger } from '../logger.js';
import { throwIpcError, requireString, requireObject } from '../utils/ipcValidate.js';
import {
  GoalControllerInputError,
  GoalSessionRestoreError,
  GoalUpdateSupersededError,
  GoalControllerDisposedError,
} from '../goal-host/controller.js';
import { getGoalController } from '../goal-host/index.js';
import { tapWindowBroadcast } from '../device-link/broadcast-tap.js';
import type { GoalUpdatePatch, GoalStatusUpdate } from '../goal-host/types.js';
import { MAKER_INVOKE, MAKER_PUSH } from './channels.js';

const log = createLogger('maker-ipc:goal');

export interface GoalHandlerLifecycleDeps {
  isDeviceLinkInvoke(): boolean;
  withSessionLock<T>(sessionId: string, task: () => Promise<T>): Promise<T>;
  assertSessionActive(sessionId: string): Promise<void>;
  /**
   * 根据真实 event.sender 判定调用是否来自本地副窗口(secondary app window)。
   * 本地副窗口承载的也是完整会话(含 GoalIndicator),其 resume/update/clear 与远程
   * 副窗口一样必须走 active-session fence,不能信任 renderer 自报的窗口身份。
   * device-link 合成 event 的 sender 为空,由 requireActiveSession 标记驱动,二者互补。
   */
  isSecondaryWindowEvent?(event: IpcMainInvokeEvent): boolean;
}

const NOOP_GOAL_LIFECYCLE_DEPS: GoalHandlerLifecycleDeps = {
  isDeviceLinkInvoke: () => false,
  withSessionLock: async (_sessionId, task) => task(),
  assertSessionActive: async (_sessionId) => undefined,
};

type GoalLimitPatchKey = 'maxTurns' | 'budgetTokens' | 'noProgressLimit';

/**
 * 识别 lifecycle fence 里 `assertSessionActive` 对已归档/非 active 会话抛出的
 * PRECONDITION_FAILED(消息以 `SESSION_NOT_ACTIVE:` 开头,见 register.ts)。
 * GOAL_GET_STATUS 对副窗口遇到这种情况降级为"返回恢复前快照、不 resumeOnOpen",
 * 而不是把读取变成报错;其它 PRECONDITION_FAILED(目标控制器真实失败)仍向上抛。
 */
function isSessionNotActiveError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'PRECONDITION_FAILED' &&
    error instanceof Error &&
    error.message.includes('SESSION_NOT_ACTIVE')
  );
}

function throwGoalControllerIpcError(error: unknown): never {
  if (error instanceof GoalControllerInputError) {
    throwIpcError('INVALID_PARAMS', error.message);
  }
  if (
    error instanceof GoalSessionRestoreError ||
    error instanceof GoalUpdateSupersededError ||
    error instanceof GoalControllerDisposedError
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

export function registerGoalHandlers(
  lifecycle: GoalHandlerLifecycleDeps = NOOP_GOAL_LIFECYCLE_DEPS,
): void {
  // 加 route lock + 持久化 active 复核的两条触发路径(对齐 register.ts 手工派发口径):
  //   1. device-link 合成 event 的 sender 为空,无法用窗口归属判定,由原始 renderer 经隧道
  //      args 透传的 requireActiveSession 显式驱动;
  //   2. 本地副窗口(GoalIndicator 所在的 secondary app window)由真实 event.sender 反查,
  //      无需 renderer 自报标记,一律 fence——reviewer P2:此前本地副窗 resume/update 绕过门禁。
  // primary remote task(主窗口)不带标记且 sender 为主窗,保持"向已归档任务发命令可恢复
  // 任务"的历史语义。fence 持锁期间调 controller 续跑(setGoal→fireTurn、
  // resumeGoal、resumeOnOpen→acquirePendingAgentSwitch)会再次取同一把非重入
  // route 锁,因此把 fenced 标志透传给 controller(sessionRouteLockHeld),
  // 由 holder 跳过二次加锁,避免自死锁(#3262 review P2)。
  const runWithLifecycleGuard = <T>(
    sessionId: string,
    event: IpcMainInvokeEvent,
    task: (fenced: boolean) => Promise<T>,
    requireActiveSession?: boolean,
  ): Promise<T> => {
    const isSecondaryWindow = lifecycle.isSecondaryWindowEvent?.(event) ?? false;
    const mustFence =
      (lifecycle.isDeviceLinkInvoke() && requireActiveSession === true) || isSecondaryWindow;
    if (!mustFence) return task(false);
    return lifecycle.withSessionLock(sessionId, async () => {
      await lifecycle.assertSessionActive(sessionId);
      return task(true);
    });
  };

  // 设目标(renderer 备用入口;命令路径走 commands/builtins.ts)。新建/编辑都直接生效并续跑。
  ipcMain.handle(MAKER_INVOKE.GOAL_SET, async (e, input: unknown) => {
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
      await runWithLifecycleGuard(
        sessionId,
        e,
        (fenced) =>
          controller.setGoal({
            sessionId,
            objective,
            ...(limits ? { limits } : {}),
            // fence 已持有 route 锁:让 controller 内的 pending-agent-switch
            // 走 holder 的 sessionRouteLockHeld 分支,不重复加锁(#3262 P2)。
            ...(fenced ? { sessionRouteLockHeld: true } : {}),
          }),
        obj.requireActiveSession === true,
      );
    } catch (err) {
      throwGoalControllerIpcError(err);
    }
    return { ok: true };
  });

  // 用户清除目标(GoalIndicator ✕ 按钮)。第一个参数保持裸 sessionId 字符串的 wire
  // 形态(append-only 协议兼容;旧被控端 / 本机按钮发裸字符串,按 requireString 解析,
  // 多余尾参被忽略);副窗口经隧道时在第二参带 { requireActiveSession: true },此时
  // 才在 device-link 下走 route lock + 持久化 active 复核(与 GOAL_SET 同口径)。
  // primary remote 不带标记,保留"向已归档任务发命令可恢复任务"的历史语义。
  ipcMain.handle(
    MAKER_INVOKE.GOAL_CLEAR,
    async (e, sessionId: unknown, fenceOpts?: unknown) => {
      const id = requireString(sessionId, 'sessionId');
      const requireActiveSession =
        fenceOpts !== null &&
        typeof fenceOpts === 'object' &&
        (fenceOpts as { requireActiveSession?: boolean }).requireActiveSession === true;
      await runWithLifecycleGuard(
        id,
        e,
        () => getGoalController()?.clearGoal(id) ?? Promise.resolve(),
        requireActiveSession,
      );
      return { ok: true };
    },
  );

  // 取当前状态(useGoalStatus hook 挂载时拉一次 = 用户打开该会话)。无 goal 返回 null。
  // 第一参保持裸 sessionId 字符串的 wire 形态(append-only 协议兼容;旧被控端 / 本机
  // hook 发裸字符串,多余尾参被忽略);副窗口经隧道时在第二参带 { requireActiveSession:
  // true },此时 resumeOnOpen(有副作用:会重建 Agent session 并可能续跑 dormant goal)
  // 与 GOAL_RESUME/CLEAR 同口径走 route lock + 持久化 active 复核——reviewer P2:副窗口
  // 归档后这个"读取"入口此前能把已归档任务重新拉起。本地副窗口由真实 event.sender 自动
  // fence,无需 renderer 标记;primary remote / 主窗口不带标记,保留 resume-on-open 的
  // 历史语义(打开主窗口会话本就允许 dormant 恢复)。
  ipcMain.handle(
    MAKER_INVOKE.GOAL_GET_STATUS,
    async (e, sessionId: unknown, fenceOpts?: unknown) => {
      const id = requireString(sessionId, 'sessionId');
      const requireActiveSession =
        fenceOpts !== null &&
        typeof fenceOpts === 'object' &&
        (fenceOpts as { requireActiveSession?: boolean }).requireActiveSession === true;
      const controller = getGoalController();
      if (!controller) throwIpcError('INTERNAL', 'goal controller not started');
      let status = await readGoalStatusForIpc(controller, id);
      // Dormant recovery may synchronously converge an apparently active Goal to
      // blocked. Wait for storage/session recovery and re-read so this invoke
      // response cannot overwrite the newer status push with a stale active
      // snapshot. Actual turn dispatch stays detached: PI prompt acceptance may
      // legitimately wait through long compaction and must not hold a read query.
      //
      // resumeOnOpen 有副作用(重建 Agent session / 续跑 dormant goal),必须在
      // lifecycle fence 内执行:副窗口 + 已归档任务时 assertSessionActive 失败,
      // 这里降级为直接返回当前 status(归档任务无 active goal → 通常 null),既不
      // 重新激活任务,也不把"读取"变成对 renderer 的报错。
      if (status?.status === 'active') {
        try {
          await runWithLifecycleGuard(
            id,
            e,
            (fenced) =>
              controller.resumeOnOpen(id, {
                waitForDispatch: false,
                // fence 持锁时透传,跳过 resumeOnOpen 内的二次加锁(#3262 P2)。
                ...(fenced ? { sessionRouteLockHeld: true } : {}),
              }),
            requireActiveSession,
          );
        } catch (error) {
          // 副窗口 fence 判定会话已归档:放弃 resumeOnOpen,返回恢复前快照即可。
          if (isSessionNotActiveError(error)) return status;
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
    },
  );

  // 暂停 active 目标(GoalIndicator ⏸ 按钮)。非 active 是 no-op,不报错。
  ipcMain.handle(MAKER_INVOKE.GOAL_PAUSE, async (_e, sessionId: unknown) => {
    const id = requireString(sessionId, 'sessionId');
    await getGoalController()?.pauseGoal(id);
    return { ok: true };
  });

  // 恢复 paused/blocked 目标(GoalIndicator ▶ 按钮 / resume-on-open 确认)。
  // 保留计数继续;终态/active 是 no-op。第一个参数保持裸 sessionId 字符串的 wire
  // 形态(append-only 协议兼容;旧被控端 / 本机按钮发裸字符串,按 requireString 解析,
  // 多余尾参被忽略);副窗口经隧道时在第二参带 { requireActiveSession: true },此时
  // 才在 device-link 下走 route lock + 持久化 active 复核(与 GOAL_CLEAR 同口径)。
  // primary remote 不带标记,保留"向已归档任务发命令可恢复任务"的历史语义。
  ipcMain.handle(
    MAKER_INVOKE.GOAL_RESUME,
    async (e, sessionId: unknown, fenceOpts?: unknown) => {
      const id = requireString(sessionId, 'sessionId');
      const requireActiveSession =
        fenceOpts !== null &&
        typeof fenceOpts === 'object' &&
        (fenceOpts as { requireActiveSession?: boolean }).requireActiveSession === true;
      try {
        await runWithLifecycleGuard(
          id,
          e,
          (fenced) =>
            // fence 持锁时传 sessionRouteLockHeld,让 resumeGoal→fireTurn 跳过
            // 二次获取同一把 route 锁(#3262 P2);非 fence 路径保持无 opts 裸调用。
            getGoalController()?.resumeGoal(
              id,
              ...(fenced ? [{ sessionRouteLockHeld: true }] : []),
            ) ?? Promise.resolve(),
          requireActiveSession,
        );
      } catch (error) {
        throwGoalControllerIpcError(error);
      }
      return { ok: true };
    },
  );

  ipcMain.handle(MAKER_INVOKE.GOAL_UPDATE, async (e, input: unknown) => {
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
      // 与 GOAL_SET 同口径:device-link 显式带 requireActiveSession,或真实 sender 是本地
      // 副窗口(reviewer P2:本地副窗 GoalIndicator resume/update 此前绕过门禁)时,加 route
      // lock + 持久化 active 复核;主窗口 / primary remote 不带标记且非副窗,保留"编辑已归档
      // 任务目标可重新激活任务"的历史语义。
      const updated = await runWithLifecycleGuard(
        sessionId,
        e,
        // fence 持锁时透传 sessionRouteLockHeld:updateGoal 改 paused/blocked
        // 目标的 objective 会内部调 resumeGoal→fireTurn,需跳过二次加锁(#3262)。
        (fenced) =>
          controller.updateGoal(
            sessionId,
            patch,
            ...(fenced ? [{ sessionRouteLockHeld: true }] : []),
          ),
        obj.requireActiveSession === true,
      );
      if (!updated) throwIpcError('GOAL_NOT_FOUND', 'goal not found');
      return { ok: true };
    } catch (err) {
      throwGoalControllerIpcError(err);
    }
  });

  log.info('goal IPC handlers registered');
}
