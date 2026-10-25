
import type { SendOrigin } from '@cindy/maker-core';

import type { MessageTurnCostPayload } from '@cindy/maker-shared/turn-cost-payload';

// payload 契约的正本在 shared(跨进程协议不放 main —— 否则 renderer 的类型图会反向
// 依赖 main 实现模块,把 Electron / DB / 调度器副作用拖进 renderer 工具链)。这里再导出
// 一次,既有 import 路径不变。
export type { MessageTurnCostPayload } from '@cindy/maker-shared/turn-cost-payload';
import type {DbClient} from '@cindy/runtime-db';
 import type {DbLogger} from '@cindy/runtime-db/logging';
 import type {createRegionalMoney,RegionalMoney,MoneyCurrency} from '@cindy/maker-shared/regional-money';
 import type {OwnerBroadcastTap,BroadcastLocal,DataOwnerBroadcastScope} from './ownerBroadcast.js';import type {createTurnUsageDetails,TurnUsageDetails} from '@cindy/maker-shared/turn-usage-details';
 import type {createMessageService,MessageAgentMetaPatchResult} from './messageService.js';
 import type {createMessagePersistence} from './messagePersistBroadcaster.js';
 import type {createScheduleRunCostLedger} from './runCostLedger.js';
 export interface TurnCostBroadcasterHost extends Pick<ReturnType<typeof createRegionalMoney>,'addCompatibleRegionalMoney'|'normalizeRegionalMoney'>,
 Pick<ReturnType<typeof createTurnUsageDetails>,'mergeTurnUsageDetailsForMessage'|'normalizeTurnUsageDetails'>,
 Pick<ReturnType<typeof createMessageService>,'patchMessageAgentMetaWithResult'|'readPriorUserRoundCost'>,
 Pick<ReturnType<typeof createMessagePersistence>,'enqueueDurableWrite'>,
 Pick<ReturnType<typeof createScheduleRunCostLedger>,'applyScheduleRunCostMetaChange'|'recordScheduleRunCostDirect'> {
 createLogger(name:string):DbLogger;broadcastLocal:BroadcastLocal;broadcastTap:OwnerBroadcastTap;
 }

type OwnerScope = DataOwnerBroadcastScope | null;

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

export interface SchedulerTurnCostFallbackDeps {
  recordOnMessage: ReturnType<typeof createTurnCostBroadcaster>['recordTurnCostOnMessage'];
  recordDirect: ReturnType<typeof createScheduleRunCostLedger>['recordScheduleRunCostDirect'];
}
export function createTurnCostBroadcaster(host:TurnCostBroadcasterHost) {
const {createLogger,broadcastLocal,broadcastTap,mergeTurnUsageDetailsForMessage,normalizeTurnUsageDetails,patchMessageAgentMetaWithResult,readPriorUserRoundCost,enqueueDurableWrite,applyScheduleRunCostMetaChange,recordScheduleRunCostDirect,addCompatibleRegionalMoney,normalizeRegionalMoney}=host;


const log = createLogger('turnCostBroadcaster');

/** IPC channel: main → renderer 推单条消息的 per-turn 费用。 */
const MESSAGE_TURN_COST_CHANGED = 'usage:message-turn-cost';

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
  {
      if (ownerScope === null) {
        broadcastLocal(MESSAGE_TURN_COST_CHANGED, payload);
      } else {
        broadcastLocal(MESSAGE_TURN_COST_CHANGED, payload, ownerScope.ownerStamp);
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
async function recordTurnCostOnMessage(
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
async function recordTurnUsageOnMessage(
  args: {
    sessionId: string;
    clientId: string;
    turnUsageDetails?: TurnUsageDetails | null;
  },
  deps: TurnUsageDeps = defaultDeps,
): Promise<boolean> {
  const { sessionId, clientId, turnUsageDetails } = args;
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

const defaultSchedulerTurnCostFallbackDeps: SchedulerTurnCostFallbackDeps = {
  recordOnMessage: recordTurnCostOnMessage,
  recordDirect: recordScheduleRunCostDirect,
};

/**
 * 记录一笔 scheduler turn 费用：优先写 assistant message；消息路径无法写入时按 runId
 * 直接归因，保证会话费用与自动化费用不会因纯 tool turn 分叉。
 */
async function recordSchedulerTurnCost(
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
 * Provider 的 completionTokens 已包含 reasoning 子集，这里不再重复相加。
 * 写缓存独立传递；旧版 done 未声明时按 0 兼容。
 */
function codexUsageToTokens(usage: {
  promptTokens?: number;
  completionTokens?: number;
  reasoningTokens?: number;
  cachedTokens?: number;
  cacheCreationTokens?: number;
}): { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreateTokens: number } {
  return {
    inputTokens: usage.promptTokens || 0,
    outputTokens: usage.completionTokens || 0,
    cacheReadTokens: usage.cachedTokens || 0,
    cacheCreateTokens: usage.cacheCreationTokens || 0,
  };
}

/** Pi done.data.usage → unified turn token fields. */
function piUsageToTokens(usage: {
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
return {
  MESSAGE_TURN_COST_CHANGED,
  broadcastTurnCostPayload,
  recordTurnCostOnMessage,
  recordTurnUsageOnMessage,
  recordSchedulerTurnCost,
  codexUsageToTokens,
  piUsageToTokens
};
}
