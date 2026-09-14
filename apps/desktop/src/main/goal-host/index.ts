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
  acquirePendingAgentSwitchForDirectSend,
  isSessionInTurn,
  stopActiveGoalTurnForClear,
} from '../maker-ipc/register.js';
import { createMessage } from '../localDb/ipc/messages.js';
import { readGoalSettings, writeGoalSettings } from '../maker-host/goal-settings-store.js';
import { readClaudeAccountUsageSnapshot } from '../usage/claudeAccountUsage.js';
import { readCodexAccountUsageSnapshot } from '../usageBroadcaster.js';
import { GoalController } from './controller';
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

/** Incremented on every resetGoalController call. attemptStartScheduler uses
 * this to bail out if a teardown raced its await. */
let _teardownGeneration = 0;

export function startGoalController(deps: StartGoalControllerDeps): GoalController {
  if (_controller) return _controller;
  const logger = createLogger('goal-host');
  const storage = new GoalStorage(deps.getDb);
  const controller = new GoalController({
    storage,
    getSession: (id): SessionLike | undefined => deps.maker.getSession(id),
    // 确保会话活着:已活直接返回;未活按存档 SessionMeta resume(spawn agent),
    // 仿 scheduler 心跳。修"开了对话没发消息 → goal 发不出第一轮"的根因。
    ensureSession: (id): Promise<SessionLike | undefined> =>
      restoreSessionForGoal(id, {
        maker: deps.maker,
        warn: (message, meta) => logger.warn(message, meta),
      }),
    acquirePendingAgentSwitch: acquirePendingAgentSwitchForDirectSend,
    isSessionInTurn,
    stopActiveGoalTurn: stopActiveGoalTurnForClear,
    beforeDispatchUserTurn: deps.beforeDispatchUserTurn,
    onUndispatchedUserTurn: deps.onUndispatchedUserTurn,
    emitStatus: deps.broadcastStatus,
    // 护栏默认从 goal-settings-store 读(系统默认 + 用户 override,规则 20);新建 goal
    // 时直接采用最新默认值。
    getDefaults: () => readGoalSettings(),
    // 预留给未来 settings UI;当前 /goal 流程不写全局默认 override。
    persistGoalSettingsOverride: (limits) => writeGoalSettings(limits),
    logger,
    // 首轮落一条干净的目标文案(对话起点);发给模型的仍是完整 directive(在
    // controller.fireTurn 里)。不打 agentMeta.origin —— guard f 区分 goal/user turn
    // 靠事件的 turnOrigin,持久化消息无需重复标记(且 AgentMeta.origin 当前不含 'goal')。
    persistUserMessage: async (sessionId, content, opts) => {
      await createMessage(sessionId, {
        clientId: randomUUID(),
        role: 'user',
        content,
        // /goal 目标设定/更新 → 标记该消息,renderer 在气泡上方渲「目标 / 目标已更新」徽标。
        ...(opts?.goalObjective ? { agentMeta: { goalObjective: opts.goalObjective } } : {}),
      });
    },
    // 达成时落一条持久记录(空 content + agentMeta.goalCompletion),renderer 渲成
    // "目标已达成 · N 轮 · 耗时 X"分隔条。与 persistUserMessage 对称:起点落目标、
    // 终点落达成。agentMeta 是持久 JSON,不进 prompt(规则 10 安全)。
    persistGoalCompletion: async (sessionId, summary) => {
      await createMessage(sessionId, {
        clientId: randomUUID(),
        role: 'assistant',
        content: '',
        agentMeta: { goalCompletion: summary },
      });
    },
    // 主动配额检测:读对应 agent 的账号用量快照(codex 走 account_usage 事件落库的
    // snapshot、claude 走 LiteLLM 轮询),判 limited + 取 resetAt(unix ms)。
    getAccountLimit: async (agentKind) => {
      if (agentKind === 'codex') {
        const snap = await readCodexAccountUsageSnapshot().catch(() => null);
        if (!snap) return null;
        // 取"已用满(>=100%)窗口里最晚的"重置;都没满则取两窗口里最晚的(宁晚勿早)。
        // 不能一律取 primary —— 当限流来自周 / 次要窗口时 primary 重置更早,会让目标早醒、
        // 反复撞同一限额,直到次要窗口真正恢复(reviewer #354)。
        const windows = [snap.primary, snap.secondary].filter(
          (w): w is NonNullable<typeof w> => !!w && typeof w.resetsAt === 'number',
        );
        const exhausted = windows.filter((w) => w.usedPercent >= 100);
        const pool = exhausted.length > 0 ? exhausted : windows;
        const resetsAtSec = pool.length > 0 ? Math.max(...pool.map((w) => w.resetsAt as number)) : null;
        return {
          limited: snap.rateLimitReachedType != null,
          resetAtMs: resetsAtSec != null ? resetsAtSec * 1000 : null,
        };
      }
      if (agentKind === 'claude-code') {
        const snap = readClaudeAccountUsageSnapshot();
        if (!snap) return null;
        const parsed = snap.budgetResetAt ? Date.parse(snap.budgetResetAt) : Number.NaN;
        return {
          limited: snap.maxBudget > 0 && snap.spend >= snap.maxBudget,
          resetAtMs: Number.isFinite(parsed) ? parsed : null,
        };
      }
      return null;
    },
    // usageLimited 到点自动续跑时,落一条"用量已恢复,继续目标"提示(渲染成 system card)。
    persistGoalNotice: async (sessionId, kind) => {
      await createMessage(sessionId, {
        clientId: randomUUID(),
        role: 'assistant',
        content: '',
        agentMeta: { goalNotice: kind },
      });
    },
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
