/**
 * turnCostBroadcaster — 把 per-turn 费用挂到该轮最后一条 assistant 消息上。
 *
 * 与 usageBroadcaster(今日维度)/ sessionSpendBroadcaster(session 维度)平行,
 * 本模块管"per-message 维度":turn 结束时 register.ts 算出该轮费用(Claude 为 SDK
 * 实报 delta;Codex 为 token × modelPricing 折算),调 recordTurnCostOnMessage 把
 * { turnCostUsd, turnCostIsEstimate } patch 进 messages.agent_meta(免 migration,
 * 历史会话重开也能显示),落库成功后广播给所有窗口刷新 MessageActionBar。
 *
 * 写库经 messagePersistBroadcaster 的 enqueueDurableWrite 串行 FIFO:该消息的
 * createMessage 在 done 同步路径已入队,patch 后入队 → 顺序天然正确(Codex 异步
 * 折算晚到也成立)。先落库后广播,保证多窗口 / 后开窗口(走历史加载读 agent_meta)
 * 同源同值。
 */

import { BrowserWindow } from 'electron';
import type { SendOrigin } from '@cindy/maker-core';

import type { TurnUsageDetails } from '../shared/turnUsageDetails.js';
import {
  patchMessageAgentMetaWithResult,
  readPriorUserRoundCost,
  type MessageAgentMetaPatchResult,
} from './localDb/ipc/messages.js';
import { enqueueDurableWrite } from './messagePersistBroadcaster.js';
import { createLogger } from './logger.js';
import { tapWindowBroadcast } from './device-link/broadcast-tap.js';
import {
  applyScheduleRunCostMetaChange,
  recordScheduleRunCostDirect,
} from './scheduler-host/runCostLedger.js';
import {
  addCompatibleRegionalMoney,
  normalizeRegionalMoney,
  type RegionalMoney,
} from '../shared/regionalMoney.js';

const log = createLogger('turnCostBroadcaster');

/** IPC channel: main → renderer 推单条消息的 per-turn 费用。 */
export const MESSAGE_TURN_COST_CHANGED = 'usage:message-turn-cost';

export interface MessageTurnCostPayload {
  sessionId: string;
  /** 该轮最后一条 assistant 的 messages.client_id。 */
  clientId: string;
  turnMoney: RegionalMoney;
  turnCostUsd?: number;
  turnCostIsEstimate: boolean;
  /** User-visible cumulative cost from the latest real user prompt through this message. */
  userTurnMoney: RegionalMoney;
  userTurnCostUsd?: number;
  /** True when any segment in userTurnCostUsd is a subscription-value estimate. */
  userTurnCostIsEstimate: boolean;
  /** 本轮 token/cache 明细;旧消息或取不到 usage 时缺省。 */
  turnUsageDetails?: TurnUsageDetails;
}

/** 测试注入用依赖(patch / broadcast 可替换,免 Electron / sqlite)。 */
export interface TurnCostDeps {
  patchAgentMeta(
    sessionId: string,
    clientId: string,
    patch: Record<string, unknown>,
  ): Promise<MessageAgentMetaPatchResult | null>;
  applyScheduleRunCostChange(
    previous: Record<string, unknown>,
    next: Record<string, unknown>,
  ): Promise<void>;
  readPriorUserRoundCost(sessionId: string, clientId: string): Promise<{
    money: RegionalMoney | null;
    costUsd: number;
    hasEstimatedValue: boolean;
  }>;
  enqueue<T>(label: string, fn: () => Promise<T> | T): Promise<T>;
  broadcast(payload: MessageTurnCostPayload): void;
}

const defaultDeps: TurnCostDeps = {
  patchAgentMeta: patchMessageAgentMetaWithResult,
  applyScheduleRunCostChange: applyScheduleRunCostMetaChange,
  readPriorUserRoundCost,
  enqueue: enqueueDurableWrite,
  broadcast(payload) {
    tapWindowBroadcast(MESSAGE_TURN_COST_CHANGED, payload);
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send(MESSAGE_TURN_COST_CHANGED, payload);
      }
    }
  },
};

/**
 * 把一笔 SDK 分段费用写到指定消息，并同时写入从本轮用户消息累计的展示费用。
 *
 * - costUsd 非法 / 极小(与 sessionSpendBroadcaster 同阈值)直接跳过 —— 绝不写 $0。
 * - patch 返回 false(行不存在,典型 rewind 已删)→ 不广播。
 * - 失败只 warn,不影响事件循环(调用方 fire-and-forget)。
 */
export async function recordTurnCostOnMessage(
  args: {
    sessionId: string;
    clientId: string;
    money: RegionalMoney;
    turnUsageDetails?: TurnUsageDetails | null;
    turnOrigin?: SendOrigin;
  },
  deps: TurnCostDeps = defaultDeps,
): Promise<boolean> {
  const { sessionId, clientId, money, turnUsageDetails, turnOrigin } = args;
  if (!sessionId || !clientId) return false;
  const normalized = normalizeRegionalMoney(money);
  if (!normalized || normalized.amount < 1e-10) return false;
  try {
    let userTurnMoney = normalized;
    let userTurnCostIsEstimate = normalized.kind === 'value-estimate';
    const patched = await deps.enqueue(`turn-cost:${sessionId}:${clientId}`, async () => {
      // This runs in the durable FIFO after prior assistant cost patches, so
      // the query sees every earlier segment of this user round.
      const prior = await deps.readPriorUserRoundCost(sessionId, clientId);
      userTurnMoney = prior.money
        ? (addCompatibleRegionalMoney([prior.money, normalized], normalized.currency) ??
          normalized)
        : normalized;
      userTurnCostIsEstimate =
        (prior.money?.currency === userTurnMoney.currency &&
          prior.hasEstimatedValue) ||
        (normalized.currency === userTurnMoney.currency &&
          normalized.kind === 'value-estimate');
      const patch: Record<string, unknown> = {
        // Keep the raw segment immutable: daily/session/model accounting and
        // scheduler summaries consume this field and must never see a running
        // user-round total.
        turnCost: normalized,
        turnCostIsEstimate: normalized.kind === 'value-estimate',
        userTurnCost: userTurnMoney,
        userTurnCostIsEstimate,
      };
      if (normalized.currency === 'USD') {
        patch.turnCostUsd = normalized.amount;
      }
      if (userTurnMoney.currency === 'USD') {
        patch.userTurnCostUsd = userTurnMoney.amount;
      }
      if (turnOrigin?.kind === 'scheduler' && typeof turnOrigin.runId === 'string' && turnOrigin.runId) {
        patch.origin = turnOrigin;
      }
      if (turnUsageDetails) patch.turnUsageDetails = turnUsageDetails;
      const result = await deps.patchAgentMeta(sessionId, clientId, patch);
      if (!result) return null;
      try {
        await deps.applyScheduleRunCostChange(result.previous, result.next);
      } catch (err) {
        // 消息上的 runId + 单段费用已经持久化，后续读取仍可据此恢复；不阻断消息费用展示。
        log.warn('schedule run cost update failed:', err instanceof Error ? err.message : String(err));
      }
      return result;
    });
    if (!patched) return false;
    try {
      deps.broadcast({
        sessionId,
        clientId,
        turnMoney: normalized,
        ...(normalized.currency === 'USD'
          ? { turnCostUsd: normalized.amount }
          : {}),
        turnCostIsEstimate: normalized.kind === 'value-estimate',
        userTurnMoney,
        ...(userTurnMoney.currency === 'USD'
          ? { userTurnCostUsd: userTurnMoney.amount }
          : {}),
        userTurnCostIsEstimate,
        ...(turnUsageDetails ? { turnUsageDetails } : {}),
      });
    } catch (err) {
      // The message cost is already durable; a broadcast failure must not
      // make scheduler fallback record the same segment a second time.
      log.warn('recordTurnCostOnMessage broadcast failed:', err instanceof Error ? err.message : String(err));
    }
    return true;
  } catch (err) {
    log.warn('recordTurnCostOnMessage failed:', err instanceof Error ? err.message : String(err));
    return false;
  }
}

export interface SchedulerTurnCostFallbackDeps {
  recordOnMessage: typeof recordTurnCostOnMessage;
  recordDirect: typeof recordScheduleRunCostDirect;
}

const defaultSchedulerTurnCostFallbackDeps: SchedulerTurnCostFallbackDeps = {
  recordOnMessage: recordTurnCostOnMessage,
  recordDirect: recordScheduleRunCostDirect,
};

/**
 * 记录一笔 scheduler turn 费用：优先写 assistant message；消息路径无法写入时按 runId
 * 直接归因，保证会话费用与自动化费用不会因纯 tool turn 分叉。
 */
export async function recordSchedulerTurnCost(
  args: {
    sessionId: string;
    clientId?: string;
    money: RegionalMoney;
    turnUsageDetails?: TurnUsageDetails | null;
    turnOrigin?: SendOrigin;
  },
  deps: SchedulerTurnCostFallbackDeps = defaultSchedulerTurnCostFallbackDeps,
): Promise<string | null> {
  const { clientId, turnOrigin } = args;
  if (clientId) {
    const recorded = await deps.recordOnMessage({
      ...args,
      clientId,
    });
    if (recorded) return null;
  }
  if (
    turnOrigin?.kind !== 'scheduler' ||
    typeof turnOrigin.runId !== 'string' ||
    !turnOrigin.runId
  ) {
    return null;
  }
  try {
    return await deps.recordDirect({
      runId: turnOrigin.runId,
      money: args.money,
    });
  } catch (err) {
    log.warn('recordSchedulerTurnCost fallback failed:', err instanceof Error ? err.message : String(err));
    return null;
  }
}

/**
 * Codex done.data.usage → computeGatewayTurnCost 的 TurnTokenDeltas 入参映射。
 * Codex translator 已把 reasoning 合并进 completionTokens, 这里不再重复相加。
 * Codex 无 cache 写入概念, cacheCreateTokens 恒 0。
 */
export function codexUsageToTokens(usage: {
  promptTokens?: number;
  completionTokens?: number;
  reasoningTokens?: number;
  cachedTokens?: number;
}): { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreateTokens: number } {
  return {
    inputTokens: usage.promptTokens || 0,
    outputTokens: usage.completionTokens || 0,
    cacheReadTokens: usage.cachedTokens || 0,
    cacheCreateTokens: 0,
  };
}
