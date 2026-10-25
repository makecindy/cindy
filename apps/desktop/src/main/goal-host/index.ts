import {createGoalControllerComposition} from '@cindy/app-runtime/goal/composition';
/**
 * goal-host 单例 + 启停 —— 镜像 scheduler-host/index.ts。
 *
 * 启动时机:与 scheduler 同一就绪点(maker 构造 + 全部 maker:* IPC 注册 + localDb
 * ensureReady 之后),由 bootstrap-electron 调 startGoalController。启动时 resume
 * 所有 active goal(重挂 listener、空闲则再踢一轮)。
 */

import { randomUUID } from 'node:crypto';

import type { Maker } from '@cindy/maker-core';

import { createLogger } from '../logger.js';
import {
  hasRestoredCodexQuota,
  acquirePendingAgentSwitchForDirectSend,
  isSessionInTurn,
  ensureGoalInputReady,
  isGoalInputBlocked,
  resolveSessionRuntimeRoute,
  stopActiveGoalTurnForClear,
} from '../maker-ipc/register.js';
import { isSessionSharedTaskActive } from '../device-link/sharedTaskDispatch.js';
import { createMessage } from '../localDb/ipc/messages.js';
import { readGoalSettings, writeGoalSettings } from '../maker-host/goal-settings-store.js';
import { getSessionRowSnapshot } from '../localDb/ipc/sessions.js';
import {
  readAccountUsageLimit,
  sessionUsesOtherMachineAccount,
  subscriptionFamilyOf,
} from '../usage/accountUsageLimit.js';
import { readClaudeAccountUsageSnapshot } from '../usage/claudeAccountUsage.js';
import { onCodexAutoResetRestored } from '../maker-ipc/usage.js';
import { GoalController } from './controller';
import { readTurnUsageResetAt } from './usageLimit.js';
import { restoreSessionForGoal } from './sessionRestore.js';
import { GoalStorage, type GoalDrizzleDb } from './storage';
import type { GoalStatusUpdate, SessionLike } from './types';

export interface StartGoalControllerDeps {
  maker: Maker;
  getDb: () => GoalDrizzleDb;
  /** 状态变化广播到 renderer(→ GOAL_STATUS_CHANGED)。 */
  broadcastStatus: (update: GoalStatusUpdate) => void;
  beforeDispatchUserTurn?: (sessionId: string) => void | Promise<void>;
  onUndispatchedUserTurn?: (sessionId: string) => void;
}

let _controller: GoalController | null = null;
onCodexAutoResetRestored(async providerId => {
  await _controller?.resumeRestoredQuota(id => hasRestoredCodexQuota(id, providerId));
});

/** Incremented on every resetGoalController call. attemptStartScheduler uses
 * this to bail out if a teardown raced its await. */
let _teardownGeneration = 0;

export function startGoalController(deps: StartGoalControllerDeps): GoalController {
  if (_controller) return _controller;
  const logger = createLogger('goal-host');
  const controller=createGoalControllerComposition({...deps,logger},{acquirePendingAgentSwitchForDirectSend,isSessionInTurn,ensureGoalInputReady,isGoalInputBlocked,stopActiveGoalTurnForClear,readGoalSettings,writeGoalSettings,createMessage,getSessionRowSnapshot,resolveSessionRuntimeRoute,subscriptionFamilyOf,sessionUsesOtherMachineAccount,readAccountUsageLimit,readClaudeAccountUsageSnapshot,isSessionSharedTaskActive,
 createController:input=>new GoalController(input),
 ensureSession:id=>restoreSessionForGoal(id,{maker:deps.maker,warn:(message,meta)=>logger.warn(message,meta)}),
 });
  _controller = controller;
  logger.info('[goal-host] started');
  // resumeActiveGoals 异步(storage 是 async proxy);fire-and-forget,失败非致命。
  void controller.resumeActiveGoals().catch((err) => {
    logger.warn('[goal-host] resumeActiveGoals failed (non-fatal)', { error: String(err) });
  });
  return controller;
}

/** null-safe 取单例 —— 在 startGoalController 之前调用(如审批 hook 早触发)返回 null。 */
export function getGoalController(): GoalController | null {
  return _controller;
}

/** 切账号 / 登出时调(与 resetScheduler 对齐;当前 bootstrap 不联动)。 */
export async function resetGoalController(): Promise<void> {
  const controller = _controller;
  _controller = null;
  _teardownGeneration++;
  if (controller) await controller.dispose();
}

/** Return current teardown generation. Callers that await across a teardown
 * boundary should compare before/after to detect stale continuations. */
export function getGoalTeardownGeneration(): number {
  return _teardownGeneration;
}
