/**
 * turnCostBroadcaster — 把 per-turn 费用挂到该轮最后一条 assistant 消息上。
 *
 * 与 usageBroadcaster(今日维度)/ sessionSpendBroadcaster(session 维度)平行,
 * 本模块管"per-message 维度":turn 结束时 register.ts 算出该轮费用(Claude 为 SDK
 * 实报 delta;Codex 为 token × modelPricing 折算),调 recordTurnCostOnMessage 把
 * { turnCostUsd, turnCostIsEstimate } patch 进 messages.agent_meta(免 migration,
 * 历史会话重开也能显示),落库成功后广播给所有窗口刷新 MessageActionBar。
 *
 * 算不出金额的轮次走 recordTurnUsageOnMessage:只落 turnUsageDetails,让 UI 退回
 * 显示本轮 token。没有报价的成因很多(网关目录整体不下发价格、模型不在价表、
 * 订阅轮估值也 miss),但对用户来说"这一格空着"都是同一种坏体验 —— 钱算不出来
 * 不代表用量算不出来,token 明细在这些路径上本就已经算好,只是此前被丢掉了。
 * 该路径不碰任何账本字段(daily_spend / sessions.total_cost_usd / turnCost),
 * 没有钱就不记账。
 *
 * 写库经 messagePersistBroadcaster 的 enqueueDurableWrite 串行 FIFO:该消息的
 * createMessage 在 done 同步路径已入队,patch 后入队 → 顺序天然正确(Codex 异步
 * 折算晚到也成立)。先落库后广播,保证多窗口 / 后开窗口(走历史加载读 agent_meta)
 * 同源同值。
 */

import { BrowserWindow } from 'electron';
import type { SendOrigin } from '@cindy/maker-core';

import type { MessageTurnCostPayload } from '../shared/turnCostPayload.js';
import {
  mergeTurnUsageDetailsForMessage,
  normalizeTurnUsageDetails,
  type TurnUsageDetails,
} from '../shared/turnUsageDetails.js';
import {
  patchMessageAgentMetaWithResult,
  readPriorUserRoundCost,
  type MessageAgentMetaPatchResult,
} from './localDb/ipc/messages.js';
import { enqueueDurableWrite } from './messagePersistBroadcaster.js';
import { createLogger } from './logger.js';
import * as broadcastTap from './device-link/broadcast-tap.js';
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
type OwnerScope = ReturnType<typeof broadcastTap.captureDataOwnerBroadcastScope> | null;

/** IPC channel: main → renderer 推单条消息的 per-turn 费用。 */
export const MESSAGE_TURN_COST_CHANGED = 'usage:message-turn-cost';

// payload 契约的正本在 shared(跨进程协议不放 main —— 否则 renderer 的类型图会反向
// 依赖 main 实现模块,把 Electron / DB / 调度器副作用拖进 renderer 工具链)。这里再导出
// 一次,既有 import 路径不变。
export type { MessageTurnCostPayload } from '../shared/turnCostPayload.js';

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
  /** Optional owner-aware broadcast used by production; test doubles may omit it. */
  broadcastWithOwnerScope?(
    payload: MessageTurnCostPayload,
    ownerScope: OwnerScope,
  ): void;
}

function captureOwnerScope(): OwnerScope {
  return broadcastTap.captureDataOwnerBroadcastScope?.() ?? null;
}

function isOwnerScopeCurrent(scope: OwnerScope): boolean {
  return scope === null || broadcastTap.isDataOwnerBroadcastScopeCurrent?.(scope) !== false;
}

function broadcastTurnCostPayload(payload: MessageTurnCostPayload, ownerScope: OwnerScope): void {
  if (ownerScope === null) {
    broadcastTap.tapWindowBroadcast(MESSAGE_TURN_COST_CHANGED, payload);
  } else {
    broadcastTap.tapWindowBroadcast(
      MESSAGE_TURN_COST_CHANGED,
      payload,
      ownerScope.ownerStamp,
    );
  }
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      if (ownerScope === null) {
        win.webContents.send(MESSAGE_TURN_COST_CHANGED, payload);
      } else {
        win.webContents.send(MESSAGE_TURN_COST_CHANGED, payload, ownerScope.ownerStamp);
      }
    }
  }
}

const defaultDeps: TurnCostDeps = {
  patchAgentMeta: patchMessageAgentMetaWithResult,
  applyScheduleRunCostChange: applyScheduleRunCostMetaChange,
  readPriorUserRoundCost,
  enqueue: enqueueDurableWrite,
  broadcast(payload) {
    broadcastTurnCostPayload(payload, null);
  },
  broadcastWithOwnerScope(payload, ownerScope) {
    broadcastTurnCostPayload(payload, ownerScope);
  },
};

async function patchAgentMetaPreservingTurnDuration(
  deps: Pick<TurnCostDeps, 'patchAgentMeta'>,
  sessionId: string,
  clientId: string,
  patch: Record<string, unknown>,
  turnUsageDetails: TurnUsageDetails | null | undefined,
): Promise<{
  result: MessageAgentMetaPatchResult;
  turnUsageDetails: TurnUsageDetails | null | undefined;
} | null> {
  const first = await deps.patchAgentMeta(sessionId, clientId, patch);
  if (!first) return null;
  if (!turnUsageDetails) return { result: first, turnUsageDetails };

  const previousUsage = normalizeTurnUsageDetails(first.previous.turnUsageDetails);
  if (!previousUsage) return { result: first, turnUsageDetails };
  const mergedUsage = mergeTurnUsageDetailsForMessage(previousUsage, turnUsageDetails);
  const needsMergePatch =
    (turnUsageDetails.totalTokens <= 0 && previousUsage.totalTokens > 0) ||
    (turnUsageDetails.outputTokens <= 0 && previousUsage.outputTokens > 0) ||
    (previousUsage.turnDurationMs ?? 0) > (turnUsageDetails.turnDurationMs ?? 0);
  if (!needsMergePatch) return { result: first, turnUsageDetails };
  const second = await deps.patchAgentMeta(sessionId, clientId, {
    turnUsageDetails: mergedUsage,
  });
  // The first patch already persisted the segment cost/usage. If the message
  // is rewound between the two writes, keep the original success semantics so
  // ledger side effects and broadcasts are not silently skipped.
  if (!second) return { result: first, turnUsageDetails };
  return {
    result: { previous: first.previous, next: second.next },
    turnUsageDetails: mergedUsage,
  };
}

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
    turnCostIsCustomProvider?: boolean;
    turnCostProviderId?: string | null;
  },
  deps: TurnCostDeps = defaultDeps,
): Promise<boolean> {
  const {
    sessionId,
    clientId,
    money,
    turnUsageDetails,
    turnOrigin,
    turnCostIsCustomProvider,
    turnCostProviderId,
  } = args;
  if (!sessionId || !clientId) return false;
  const normalized = normalizeRegionalMoney(money);
  if (!normalized || normalized.amount < 1e-10) return false;
  const ownerScope = captureOwnerScope();
  try {
    let userTurnMoney = normalized;
    let userTurnCostIsEstimate = normalized.kind === 'value-estimate';
    let persistedTurnUsageDetails = turnUsageDetails;
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
      if (typeof turnCostIsCustomProvider === 'boolean') {
        patch.turnCostIsCustomProvider = turnCostIsCustomProvider;
      }
      if (turnCostProviderId !== undefined) patch.turnCostProviderId = turnCostProviderId;
      if (turnUsageDetails) patch.turnUsageDetails = turnUsageDetails;
      const patchedMeta = await patchAgentMetaPreservingTurnDuration(
        deps,
        sessionId,
        clientId,
        patch,
        turnUsageDetails,
      );
      if (!patchedMeta) return null;
      const { result } = patchedMeta;
      persistedTurnUsageDetails = patchedMeta.turnUsageDetails;
      try {
        await deps.applyScheduleRunCostChange(result.previous, result.next);
      } catch (err) {
        // 消息上的 runId + 单段费用已经持久化，后续读取仍可据此恢复；不阻断消息费用展示。
        log.warn('schedule run cost update failed:', err instanceof Error ? err.message : String(err));
      }
      return result;
    });
    if (!patched) return false;
    // The patch and scheduler ledger side effect are already durable.  An
    // owner switch only suppresses the stale renderer/device-link broadcast;
    // report success so scheduler fallback cannot charge the same segment
    // again.
    if (!isOwnerScopeCurrent(ownerScope)) return true;
    const payload: MessageTurnCostPayload = {
      sessionId,
      clientId,
      ...(typeof turnCostIsCustomProvider === 'boolean'
        ? { turnCostIsCustomProvider }
        : {}),
      ...(turnCostProviderId !== undefined ? { turnCostProviderId } : {}),
      turnMoney: normalized,
      ...(normalized.currency === 'USD' ? { turnCostUsd: normalized.amount } : {}),
      turnCostIsEstimate: normalized.kind === 'value-estimate',
      userTurnMoney,
      ...(userTurnMoney.currency === 'USD' ? { userTurnCostUsd: userTurnMoney.amount } : {}),
      userTurnCostIsEstimate,
      ...(persistedTurnUsageDetails ? { turnUsageDetails: persistedTurnUsageDetails } : {}),
    };
    try {
      if (deps.broadcastWithOwnerScope) {
        deps.broadcastWithOwnerScope(payload, ownerScope);
      } else {
        deps.broadcast(payload);
      }
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

/**
 * 无金额路径:落库 + 广播,外加读一次本用户轮的既有累计(见
 * recordTurnUsageOnMessage 对 userTurnMoney 的处理)。不动 scheduler 账本。
 */
export type TurnUsageDeps = Pick<
  TurnCostDeps,
  | 'patchAgentMeta'
  | 'enqueue'
  | 'broadcast'
  | 'broadcastWithOwnerScope'
  | 'readPriorUserRoundCost'
>;

/**
 * 算不出金额时,把本轮 token 明细挂到该轮最后一条 assistant 上。
 *
 * 与 recordTurnCostOnMessage 的区别是**不为当前 segment 记账**:不写 turnCost /
 * turnCostUsd,也不调 applyScheduleRunCostChange —— 账本只接受真实计费,这里提供的是
 * 用量事实。
 *
 * 但「本用户轮此前已经产生的费用」必须继续显示。一次用户请求可能含多个 SDK segment
 * (自动续跑):前面的 segment 有真实费用、最后一个 segment 缺报价走本函数时,若只写
 * turnUsageDetails,收尾那条消息的操作栏会退回显示 token,把这一轮已经花掉的钱藏起来
 * —— 而 readPriorUserRoundCost 的契约本来就是「让收尾消息承载整轮总额」。所以这里读一次
 * 往轮累计,有则连同 userTurnCost 一起投影到消息与 payload(仍不含当前无价 segment)。
 *
 * turnUsageDetails 为空时直接跳过。0 token 的最终 continuation 仍可携带整轮耗时，
 * 并与该消息先前已落下的 token 明细合并。
 */
export async function recordTurnUsageOnMessage(
  args: {
    sessionId: string;
    clientId: string;
    turnUsageDetails?: TurnUsageDetails | null;
    turnCostIsCustomProvider?: boolean;
    turnCostProviderId?: string | null;
  },
  deps: TurnUsageDeps = defaultDeps,
): Promise<boolean> {
  const {
    sessionId,
    clientId,
    turnUsageDetails,
    turnCostIsCustomProvider,
    turnCostProviderId,
  } = args;
  if (!sessionId || !clientId || !turnUsageDetails) return false;
  const ownerScope = captureOwnerScope();
  try {
    let persistedTurnUsageDetails = turnUsageDetails;
    const outcome = await deps.enqueue(`turn-usage:${sessionId}:${clientId}`, async () => {
      // 与 recordTurnCostOnMessage 同一条 durable FIFO,所以这里看得到本用户轮此前
      // 每个 segment 已落库的费用。
      const prior = await deps.readPriorUserRoundCost(sessionId, clientId);
      const userTurnMoney =
        prior.money && prior.money.amount > 0 ? prior.money : null;
      const patch: Record<string, unknown> = { turnUsageDetails };
      if (typeof turnCostIsCustomProvider === 'boolean') {
        patch.turnCostIsCustomProvider = turnCostIsCustomProvider;
      }
      if (turnCostProviderId !== undefined) patch.turnCostProviderId = turnCostProviderId;
      if (userTurnMoney) {
        patch.userTurnCost = userTurnMoney;
        patch.userTurnCostIsEstimate = prior.hasEstimatedValue;
        if (userTurnMoney.currency === 'USD') {
          patch.userTurnCostUsd = userTurnMoney.amount;
        }
      }
      const patchedMeta = await patchAgentMetaPreservingTurnDuration(
        deps,
        sessionId,
        clientId,
        patch,
        turnUsageDetails,
      );
      if (!patchedMeta) return null;
      persistedTurnUsageDetails = patchedMeta.turnUsageDetails ?? turnUsageDetails;
      return { userTurnMoney, userTurnCostIsEstimate: prior.hasEstimatedValue };
    });
    if (!outcome) return false;
    // Usage metadata is durable even when the captured owner became stale;
    // skip only the old-owner broadcast and keep the successful result.
    if (!isOwnerScopeCurrent(ownerScope)) return true;
    try {
      const { userTurnMoney, userTurnCostIsEstimate } = outcome;
      const payload: MessageTurnCostPayload = {
        sessionId,
        clientId,
        ...(typeof turnCostIsCustomProvider === 'boolean'
          ? { turnCostIsCustomProvider }
          : {}),
        ...(turnCostProviderId !== undefined ? { turnCostProviderId } : {}),
        turnUsageDetails: persistedTurnUsageDetails,
        ...(userTurnMoney
          ? {
              userTurnMoney,
              ...(userTurnMoney.currency === 'USD'
                ? { userTurnCostUsd: userTurnMoney.amount }
                : {}),
              userTurnCostIsEstimate,
            }
          : {}),
      };
      if (deps.broadcastWithOwnerScope) {
        deps.broadcastWithOwnerScope(payload, ownerScope);
      } else {
        deps.broadcast(payload);
      }
    } catch (err) {
      // 明细已落库,后开窗口走历史加载仍能读到;广播失败不影响持久事实。
      log.warn(
        'recordTurnUsageOnMessage broadcast failed:',
        err instanceof Error ? err.message : String(err),
      );
    }
    return true;
  } catch (err) {
    log.warn(
      'recordTurnUsageOnMessage failed:',
      err instanceof Error ? err.message : String(err),
    );
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
    turnCostIsCustomProvider?: boolean;
    turnCostProviderId?: string | null;
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
      turnUsageDetails: args.turnUsageDetails,
      turnCostIsCustomProvider: args.turnCostIsCustomProvider,
    });
  } catch (err) {
    log.warn('recordSchedulerTurnCost fallback failed:', err instanceof Error ? err.message : String(err));
    return null;
  }
}

/**
 * Codex done.data.usage → computeGatewayTurnCost 的 TurnTokenDeltas 入参映射。
 * Provider 的 completionTokens 已包含 reasoning 子集，这里不再重复相加。
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

/** Pi done.data.usage → unified turn token fields. */
export function piUsageToTokens(usage: {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}): { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreateTokens: number } {
  return {
    inputTokens: Number(usage.inputTokens) || 0,
    outputTokens: Number(usage.outputTokens) || 0,
    cacheReadTokens: Number(usage.cacheReadTokens) || 0,
    cacheCreateTokens: Number(usage.cacheCreationTokens) || 0,
  };
}
