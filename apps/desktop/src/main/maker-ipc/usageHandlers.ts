/**
 * maker:usage:* IPC 的纯 handler body。
 *
 * usage 数据源是 host-level 副作用层，不属于 Maker；通过 deps 显式注入能让测试不
 * import Electron / runtime config。
 */

import type { AgentKind } from '@cindy/maker-core';
import type {
  MobileCodexRateLimitResetResult,
  MobileCodexRateLimitsResult,
} from '@cindy/maker-shared/device-link-contract';
import type { ClaudeSubscriptionUsageSnapshot } from '../../shared/claudeSubscriptionUsage.js';
import type { XaiSubscriptionUsageSnapshot } from '../../shared/xaiSubscriptionUsage.js';
import type { ClaudeAccountUsageSnapshot } from '../usage/claudeAccountUsage.js';
import type { ModelPricingMap } from '../usage/modelPricing.js';
import type { UsageHistoryPayload, UsageHistoryReadOptions } from '../usage/usageHistory.js';
import type { AgentTodayUsage, RateLimitSnapshot } from '../usageBroadcaster.js';
import { CodexRateLimitResetRejectedError } from '../usage/codexRateLimitReset.js';
import { requireString, throwIpcError } from '../utils/ipcValidate.js';
import { MAKER_INVOKE } from './channels.js';
import type { IpcHandlerRegistry } from './ipcHandlerRegistry.js';

export interface LegacyUsdModelPrice {
  inputUsdPerMtok: number;
  outputUsdPerMtok: number;
  cacheReadUsdPerMtok?: number;
  cacheCreateUsdPerMtok?: number;
  /** Gateway 折扣比例 0..1;旧控制端忽略。计费金额 = 原价 × (1 - costDiscount)。 */
  costDiscount?: number;
}

export type LegacyUsdModelPricingMap = Record<string, LegacyUsdModelPrice>;

function normalizedCostDiscount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 1
    ? value
    : undefined;
}

/**
 * device-link v1 兼容投影。旧控制端只能表达扁平 USD 价格，因此只投影真实 USD quote；
 * CNY 不能反算或写进 *Usd，旧端按既有“无价隐藏”语义降级。
 * costDiscount 是 append-only：新控制端用来算折后价，旧端忽略未知字段。
 */
export function toLegacyUsdModelPricing(
  pricing: ModelPricingMap | null,
): LegacyUsdModelPricingMap | null {
  const out: LegacyUsdModelPricingMap = {};
  for (const [modelId, quote] of Object.entries(pricing?.xd ?? {})) {
    if (quote.currency !== 'USD') continue;
    const costDiscount = normalizedCostDiscount(quote.costDiscount);
    out[modelId] = {
      inputUsdPerMtok: quote.inputPerMtok,
      outputUsdPerMtok: quote.outputPerMtok,
      ...(quote.cacheReadPerMtok !== undefined
        ? { cacheReadUsdPerMtok: quote.cacheReadPerMtok }
        : {}),
      ...(quote.cacheCreatePerMtok !== undefined
        ? { cacheCreateUsdPerMtok: quote.cacheCreatePerMtok }
        : {}),
      ...(costDiscount !== undefined ? { costDiscount } : {}),
    };
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** usage handler 需要的 host-level 查询与刷新能力。 */
export interface MakerUsageHandlerDeps {
  readAgentTodayUsage(agentKind: AgentKind): Promise<AgentTodayUsage>;
  readCodexAccountUsageSnapshot(): Promise<RateLimitSnapshot | null>;
  readCodexRateLimits(): Promise<MobileCodexRateLimitsResult>;
  consumeCodexRateLimitReset(idempotencyKey: string): Promise<MobileCodexRateLimitResetResult>;
  readClaudeSubscriptionUsageSnapshot(): Promise<ClaudeSubscriptionUsageSnapshot | null>;
  readXaiSubscriptionUsageSnapshot(): Promise<XaiSubscriptionUsageSnapshot | null>;
  /**
   * 用量历史会读取完整的 sessions 表，必须在任何参数解析或 DB 查询前确认
   * 请求来自受信任的主页面 renderer。
   */
  assertTrustedSender(event: unknown): void;
  readClaudeAccountUsageSnapshot(): ClaudeAccountUsageSnapshot | null;
  triggerClaudeAccountUsageRefresh(force: boolean): Promise<void>;
  readModelPricing(): Promise<ModelPricingMap | null>;
  readReferenceModelPricing(): ModelPricingMap;
  readUsageHistory(opts?: UsageHistoryReadOptions): Promise<UsageHistoryPayload>;
  emptyUsageHistory(): UsageHistoryPayload;
}

export function registerMakerUsageHandlers(
  registry: IpcHandlerRegistry,
  deps: MakerUsageHandlerDeps,
): void {
  registry.handle(MAKER_INVOKE.USAGE_TODAY, async (_e, agentKind: unknown) => {
    return await deps.readAgentTodayUsage(requireString(agentKind, 'agentKind') as AgentKind);
  });

  registry.handle(MAKER_INVOKE.USAGE_ACCOUNT, async (_e, agentKind: unknown) => {
    const kind = requireString(agentKind, 'agentKind');
    if (kind === 'codex') return await deps.readCodexAccountUsageSnapshot();
    if (kind === 'claude-code') {
      // warm-start: 没有 snapshot 时触发一次强制刷新；本次仍按当前 snapshot 返回。
      if (deps.readClaudeAccountUsageSnapshot() === null) {
        void deps.triggerClaudeAccountUsageRefresh(true);
      }
      return deps.readClaudeAccountUsageSnapshot();
    }
    return null;
  });

  registry.handle(MAKER_INVOKE.USAGE_CODEX_RATE_LIMITS, async () => {
    try {
      return await deps.readCodexRateLimits();
    } catch (err) {
      if (err instanceof CodexRateLimitResetRejectedError) {
        throwIpcError('PRECONDITION_FAILED', `${err.reason}: ${err.message}`);
      }
      throw err;
    }
  });

  registry.handle(
    MAKER_INVOKE.USAGE_CODEX_RATE_LIMIT_RESET,
    async (_e, idempotencyKey: unknown) => {
      const key = requireString(idempotencyKey, 'idempotencyKey');
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(key)) {
        throwIpcError('INVALID_PARAMS', 'idempotencyKey must be a UUID');
      }
      try {
        return await deps.consumeCodexRateLimitReset(key);
      } catch (err) {
        if (err instanceof CodexRateLimitResetRejectedError) {
          throwIpcError('PRECONDITION_FAILED', `${err.reason}: ${err.message}`);
        }
        throw err;
      }
    },
  );

  // Claude 订阅账号余量 (5h/周/分模型窗口) — cached-first, 内部按需后台刷新。
  registry.handle(MAKER_INVOKE.USAGE_CLAUDE_SUBSCRIPTION, async () => {
    return await deps.readClaudeSubscriptionUsageSnapshot();
  });

  registry.handle(MAKER_INVOKE.USAGE_XAI_SUBSCRIPTION, async (event) => {
    deps.assertTrustedSender?.(event);
    return await deps.readXaiSubscriptionUsageSnapshot();
  });

  // device-link v1:保留旧扁平 USD 形状，不能把 CNY 伪装成 *Usd。
  registry.handle(MAKER_INVOKE.USAGE_MODEL_PRICING, async () => {
    return toLegacyUsdModelPricing(await deps.readModelPricing());
  });

  // Desktop renderer v2:Cindy AI `/models` 的 XD 原生报价，不混入 Catalog。
  registry.handle(MAKER_INVOKE.USAGE_MODEL_PRICING_V2, async () => {
    return await deps.readModelPricing();
  });

  registry.handle(MAKER_INVOKE.USAGE_REFERENCE_MODEL_PRICING, async () => {
    return deps.readReferenceModelPricing();
  });

  // 用量历史聚合 (首页仪表盘) — 查询型 handler, DB 出错回退空 payload 让
  // renderer 正常渲染空态 (与同文件其它 usage 读取的 fallback-data 口径一致)。
  registry.handle(MAKER_INVOKE.USAGE_HISTORY, async (event, opts: unknown) => {
    deps.assertTrustedSender(event);
    const raw = (opts ?? {}) as { days?: unknown; modelDays?: unknown; forceRefresh?: unknown };
    const days =
      raw.days === 'all'
        ? ('all' as const)
        : typeof raw.days === 'number' && Number.isFinite(raw.days)
          ? raw.days
          : undefined;
    const modelDays =
      raw.modelDays === 'all'
        ? ('all' as const)
        : typeof raw.modelDays === 'number' && Number.isFinite(raw.modelDays)
          ? raw.modelDays
          : undefined;
    const forceRefresh = raw.forceRefresh === true;
    const readOpts = {
      ...(days === undefined ? {} : { days }),
      ...(modelDays === undefined ? {} : { modelDays }),
      ...(forceRefresh ? { forceRefresh: true } : {}),
    };
    try {
      return await deps.readUsageHistory(Object.keys(readOpts).length === 0 ? undefined : readOpts);
    } catch {
      return deps.emptyUsageHistory();
    }
  });
}
