
import { sql } from 'drizzle-orm';

import { sessions } from '@cindy/runtime-db/schema';
import type {DbClient} from '@cindy/runtime-db';
 import type {DbLogger} from '@cindy/runtime-db/logging';
 import type {createRegionalMoney,RegionalMoney,MoneyCurrency} from '@cindy/maker-shared/regional-money';
 import type {OwnerBroadcastTap,BroadcastLocal,DataOwnerBroadcastScope} from './ownerBroadcast.js';export interface SessionSpendBroadcasterHost extends Pick<ReturnType<typeof createRegionalMoney>,'addRegionalMoney'|'legacyUsdMoney'|'normalizeRegionalMoney'> {
 getDbClient():DbClient;createLogger(name:string):DbLogger;currentLedgerCurrency():MoneyCurrency;
 broadcastLocal:BroadcastLocal;broadcastTap:OwnerBroadcastTap;
 }


export interface SessionSpendPayload {
  sessionId: string;
  totalMoney: RegionalMoney;
  /** 仅当累计金额仍是 USD 时给旧 renderer 的兼容投影。 */
  totalCostUsd?: number;
}

export interface SessionTokensPayload {
  sessionId: string;
  /** session 终身累计 token（已持久化到 sessions.total_token_usage）。 */
  totalTokens: number;
}

export interface SessionContextPayload {
  sessionId: string;
  contextTokens: number;
  contextWindow: number;
}

type OwnerScope = DataOwnerBroadcastScope;
export function createSessionSpendBroadcaster(host:SessionSpendBroadcasterHost) {
const {getDbClient,createLogger,currentLedgerCurrency,broadcastLocal,broadcastTap,addRegionalMoney,legacyUsdMoney,normalizeRegionalMoney}=host;


const log = createLogger('sessionSpendBroadcaster');

/** IPC channel: main → renderer 推单 session 累计 cost 变化。 */
const USAGE_SESSION_SPEND_CHANGED = 'usage:session-spend-changed';
/** IPC channel: main → renderer 推单 session 累计 token 变化。 */
const USAGE_SESSION_TOKENS_CHANGED = 'usage:session-tokens-changed';

/**
 * IPC channel: main → renderer 推单 session 的 context 快照变化。
 *
 * 实时 UI 刷新 (运行中圆环动) 走的是 status event 广播 (renderer agentStatus),
 * 这个 channel 当前**只**为以后 history 列表 / 未打开 session 的 chip 等场景预留,
 * 本次 renderer 暂不订阅 —— 但落库本身仍会触发广播, 接入零成本。
 */
const USAGE_SESSION_CONTEXT_CHANGED = 'usage:session-context-changed';

function captureOwnerScope(): OwnerScope | null {
  return broadcastTap.captureDataOwnerBroadcastScope?.() ?? null;
}

function isOwnerScopeCurrent(scope: OwnerScope | null): boolean {
  return scope === null || broadcastTap.isDataOwnerBroadcastScopeCurrent?.(scope) !== false;
}

/**
 * 给 session 累加一笔 turn delta：UPDATE sessions SET total_cost_usd += delta，
 * 然后回读最新值并广播。
 *
 * 极小 / 非法 delta 跳过（与 dailySpend 同阈值）。
 */
async function recordSessionTurnSpend(
  sessionId: string,
  money: RegionalMoney,
): Promise<void> {
  if (!sessionId) return;
  const ownerScope = captureOwnerScope();
  const normalized = normalizeRegionalMoney(money);
  if (!normalized || normalized.amount < 1e-10) return;
  // 只接受本账号的结算币种。基准取 currentLedgerCurrency() 而不是构建区域 —— 结算币种
  // 由服务端按账号所属租户下发,不保证等于发行区域;按区域判会让以 USD 结算的账号
  // 「本对话」金额永远停在 0。异币种(脏数据 / 上游 bug)仍然拒收。
  const ledgerCurrency = currentLedgerCurrency();
  if (normalized.currency !== ledgerCurrency) {
    log.warn(
      `recordSessionTurnSpend rejected currency mismatch: ${normalized.currency} != ${ledgerCurrency}`,
    );
    return;
  }
  try {
    const db = getDbClient().drizzle;
    // 单币种累计列:恢复旧会话时若累计仍是旧币种，首笔当前币种费用重新起算聚合列；
    // 消息历史保持原样，不猜测旧总额应如何换算。CASE 与写入在同一条 UPDATE 里，
    // 避免并发混加不同单位。
    const sameCurrency = sql`(${sessions.totalCostCurrency} IS NULL OR ${sessions.totalCostCurrency} = ${normalized.currency})`;
    await db
      .update(sessions)
      .set({
        totalCostAmount: sql`CASE WHEN ${sameCurrency} THEN ${sessions.totalCostAmount} + ${normalized.amount} ELSE ${normalized.amount} END`,
        totalCostCurrency: normalized.currency,
        totalCostIsApproximate: sql`CASE WHEN ${sameCurrency} THEN (${sessions.totalCostIsApproximate} OR ${normalized.approximate ? 1 : 0}) ELSE ${normalized.approximate ? 1 : 0} END`,
      })
      .where(sql`${sessions.id} = ${sessionId}`)
      .run();
    const row = await db
      .select({
        totalCostUsd: sessions.totalCostUsd,
        totalCostAmount: sessions.totalCostAmount,
        totalCostCurrency: sessions.totalCostCurrency,
        totalCostIsApproximate: sessions.totalCostIsApproximate,
      })
      .from(sessions)
      .where(sql`${sessions.id} = ${sessionId}`)
      .get();
    const legacy = legacyUsdMoney(row?.totalCostUsd ?? 0);
    const current = normalizeRegionalMoney({
      amount: row?.totalCostAmount ?? 0,
      currency: row?.totalCostCurrency ?? normalized.currency,
      approximate: row?.totalCostIsApproximate ?? false,
      kind: 'actual-cost',
    });
    const totalMoney =
      legacy.amount > 0 && current
        ? legacy.currency === current.currency
          ? addRegionalMoney([legacy, current])
          : current
        : (current ?? legacy);
    if (!isOwnerScopeCurrent(ownerScope)) return;
    broadcastSessionSpend(
      {
      sessionId,
      totalMoney,
      ...(totalMoney.currency === 'USD' ? { totalCostUsd: totalMoney.amount } : {}),
      },
      ownerScope,
    );
  } catch (err) {
    log.warn('recordSessionTurnSpend failed:', err instanceof Error ? err.message : String(err));
  }
}

function broadcastSessionSpend(payload: SessionSpendPayload, ownerScope: OwnerScope | null = null): void {
  if (!isOwnerScopeCurrent(ownerScope)) return;
  const ownerStamp = ownerScope ? ownerScope.ownerStamp : broadcastTap.getSafeDataOwnerPushStamp?.();
  // device-link 旁路:控制端经 sessions topic(列表订阅常开,会话未打开也不丢)收到
  // 累计 cost 镜像(本模块走裸 UPDATE、不发 sessions:patched,没有这条 tap 控制端的
  // $ 永远不更新)。
  if (ownerScope === null) {
    broadcastTap.tapWindowBroadcast(USAGE_SESSION_SPEND_CHANGED, payload);
  } else {
    broadcastTap.tapWindowBroadcast(USAGE_SESSION_SPEND_CHANGED, payload, ownerStamp);
  }
  {
      if (ownerScope === null) {
        broadcastLocal(USAGE_SESSION_SPEND_CHANGED, payload);
      } else {
        broadcastLocal(USAGE_SESSION_SPEND_CHANGED, payload, ownerStamp);
      }
    }
}

/** 给 session 累加一笔 turn token delta，然后回读最新值并广播。 */
async function recordSessionTurnTokens(
  sessionId: string,
  tokenDelta: number,
): Promise<void> {
  if (!sessionId) return;
  if (!Number.isFinite(tokenDelta) || tokenDelta <= 0) return;
  const ownerScope = captureOwnerScope();
  try {
    const db = getDbClient().drizzle;
    await db
      .update(sessions)
      .set({ totalTokenUsage: sql`${sessions.totalTokenUsage} + ${Math.floor(tokenDelta)}` })
      .where(sql`${sessions.id} = ${sessionId}`)
      .run();
    const row = await db
      .select({ totalTokenUsage: sessions.totalTokenUsage })
      .from(sessions)
      .where(sql`${sessions.id} = ${sessionId}`)
      .get();
    if (!isOwnerScopeCurrent(ownerScope)) return;
    broadcastTokens({ sessionId, totalTokens: row?.totalTokenUsage ?? 0 }, ownerScope);
  } catch (err) {
    log.warn('recordSessionTurnTokens failed:', err instanceof Error ? err.message : String(err));
  }
}

function broadcastTokens(payload: SessionTokensPayload, ownerScope: OwnerScope | null = null): void {
  const ownerStamp = ownerScope ? ownerScope.ownerStamp : broadcastTap.getSafeDataOwnerPushStamp?.();
  if (ownerScope === null) {
    broadcastTap.tapWindowBroadcast(USAGE_SESSION_TOKENS_CHANGED, payload);
  } else {
    broadcastTap.tapWindowBroadcast(USAGE_SESSION_TOKENS_CHANGED, payload, ownerStamp);
  }
  {
      if (ownerScope === null) {
        broadcastLocal(USAGE_SESSION_TOKENS_CHANGED, payload);
      } else {
        broadcastLocal(USAGE_SESSION_TOKENS_CHANGED, payload, ownerStamp);
      }
    }
}

/**
 * 写入本 session 的 context 快照 (turn 结束时由 register.ts 调)。
 *
 * 字段写入语义:
 *   - contextTokens: 总是覆盖写 (包括 0 —— SDK 自动压缩后真值可能很小, 不能因 ">0"
 *     就守住老值, 否则圆环永远不会回落)
 *     例外: 0/0 是中断 compact 可能产生的 placeholder, 不能覆盖已知快照。
 *   - contextWindow: 仅在 > 0 时写 (0 = "SDK 未给", 不能覆盖已有真值;
 *     与 usage-tracker.ts:84-86 setContextWindow 同语义)
 *
 * 调用方 (register.ts) 已确保只在 turn end 调一次, 不会高频 IO。
 */
async function recordSessionContextSnapshot(
  sessionId: string,
  contextTokens: number,
  contextWindow: number,
): Promise<void> {
  if (!sessionId) return;
  if (!Number.isFinite(contextTokens) || contextTokens < 0) return;
  if (contextTokens === 0 && (!Number.isFinite(contextWindow) || contextWindow <= 0)) return;
  const ownerScope = captureOwnerScope();
  try {
    const db = getDbClient().drizzle;
    const updates: { contextTokens: number; contextWindow?: number; contextWindowRuntime?: number } = {
      contextTokens: Math.floor(contextTokens),
    };
    if (Number.isFinite(contextWindow) && contextWindow > 0) {
      updates.contextWindow = Math.floor(contextWindow);
      updates.contextWindowRuntime = updates.contextWindow;
    }
    await db
      .update(sessions)
      .set(updates)
      .where(sql`${sessions.id} = ${sessionId}`)
      .run();
    // 回读保证广播的是 DB 最终值 (而非入参 —— contextWindow 可能没改)
    const row = await db
      .select({
        contextTokens: sessions.contextTokens,
        contextWindow: sessions.contextWindow,
      })
      .from(sessions)
      .where(sql`${sessions.id} = ${sessionId}`)
      .get();
    if (!isOwnerScopeCurrent(ownerScope)) return;
    broadcastContext(
      {
        sessionId,
        contextTokens: row?.contextTokens ?? 0,
        contextWindow: row?.contextWindow ?? 0,
      },
      ownerScope,
    );
  } catch (err) {
    log.warn(
      'recordSessionContextSnapshot failed:',
      err instanceof Error ? err.message : String(err),
    );
  }
}

function broadcastContext(payload: SessionContextPayload, ownerScope: OwnerScope | null = null): void {
  const ownerStamp = ownerScope ? ownerScope.ownerStamp : broadcastTap.getSafeDataOwnerPushStamp?.();
  {
      if (ownerScope === null) {
        broadcastLocal(USAGE_SESSION_CONTEXT_CHANGED, payload);
      } else {
        broadcastLocal(USAGE_SESSION_CONTEXT_CHANGED, payload, ownerStamp);
      }
    }
}
return {
  USAGE_SESSION_SPEND_CHANGED,
  USAGE_SESSION_TOKENS_CHANGED,
  USAGE_SESSION_CONTEXT_CHANGED,
  recordSessionTurnSpend,
  broadcastSessionSpend,
  recordSessionTurnTokens,
  recordSessionContextSnapshot
};
}
