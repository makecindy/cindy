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
import type { GlmCodingPlanUsageSnapshot } from '../../shared/glmCodingPlanUsage.js';
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
}

export type LegacyUsdModelPricingMap = Record<string, LegacyUsdModelPrice>;

/**
 * device-link v1 兼容投影。旧控制端只能表达扁平 USD 价格，因此只投影真实 USD quote；
 * CNY 不能反算或写进 *Usd，旧端按既有“无价隐藏”语义降级。
 */
export function toLegacyUsdModelPricing(
  pricing: ModelPricingMap | null,
): LegacyUsdModelPricingMap | null {
  const out: LegacyUsdModelPricingMap = {};
  for (const [modelId, quote] of Object.entries(pricing?.xd ?? {})) {
    if (quote.currency !== 'USD') continue;
    out[modelId] = {
      inputUsdPerMtok: quote.inputPerMtok,
      outputUsdPerMtok: quote.outputPerMtok,
      ...(quote.cacheReadPerMtok !== undefined
        ? { cacheReadUsdPerMtok: quote.cacheReadPerMtok }
        : {}),
      ...(quote.cacheCreatePerMtok !== undefined
        ? { cacheCreateUsdPerMtok: quote.cacheCreatePerMtok }
        : {}),
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
  readGlmCodingPlanUsageSnapshot(providerId: string): Promise<GlmCodingPlanUsageSnapshot | null>;
  readXaiSubscriptionUsageSnapshot(): Promise<XaiSubscriptionUsageSnapshot | null>;
  assertTrustedSender?(event: unknown): void;
  readClaudeAccountUsageSnapshot(): ClaudeAccountUsageSnapshot | null;
  triggerClaudeAccountUsageRefresh(force: boolean): Promise<void>;
  readModelPricing(): Promise<ModelPricingMap | null>;
  readReferenceModelPricing(): ModelPricingMap;
  readUsageHistory(opts?: UsageHistoryReadOptions): Promise<UsageHistoryPayload>;
  emptyUsageHistory(): UsageHistoryPayload;
  /**
   * sender 归属校验(生产 = security/trustedAppRenderer 的 assertTrustedAppRendererEvent,
   * 不通过时抛 PERMISSION_DENIED)。经 deps 注入保持 handler body 免 Electron 可测
   * (规则同 providerHandlers)。USAGE_GLM_CODING_PLAN 会触发凭证背书的出网请求,
   * **必须**有守卫才放行(electron-security:新 handler 不得以旧代码没校验为由省略;
   * #2768 首轮 review r3785828851)。
   */
  assertTrustedUsageSender?(event: unknown): void;
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

  // GLM Coding Plan 订阅余量 (5h token / MCP 月度窗口) — cached-first, per-provider。
  // 该 handler 会按 renderer 传入的 providerId 触发凭证背书的出网刷新,先验 sender
  // 再读任何配置 —— 守卫缺失时 fail-closed 拒绝,不裸跑。providerId 还要过 slug
  // 白名单:requireString 只拒空值,任意长字符串会在 reader 的 states Map 永久落
  // 条目并逐次触发 DB 查询(被注入的 renderer 可借此膨胀 main 内存;#2768 三轮
  // review r3788613364)——与 custom-provider-store 的 CUSTOM_PROVIDER_ID_RE 同规则。
  registry.handle(
    MAKER_INVOKE.USAGE_GLM_CODING_PLAN,
    async (event, providerId: unknown) => {
      if (!deps.assertTrustedUsageSender) {
        throwIpcError('PERMISSION_DENIED', 'usage sender trust guard unavailable');
      }
      deps.assertTrustedUsageSender(event);
      const id = requireString(providerId, 'providerId');
      if (!/^[a-z0-9_-]{1,40}$/.test(id)) {
        throwIpcError('INVALID_PARAMS', 'providerId must be a custom provider slug');
      }
      return await deps.readGlmCodingPlanUsageSnapshot(id);
    },
  );

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
  registry.handle(MAKER_INVOKE.USAGE_HISTORY, async (_e, opts: unknown) => {
    const raw = (opts ?? {}) as { days?: unknown; forceRefresh?: unknown };
    const days = typeof raw.days === 'number' && Number.isFinite(raw.days) ? raw.days : undefined;
    const forceRefresh = raw.forceRefresh === true;
    const readOpts = {
      ...(days === undefined ? {} : { days }),
      ...(forceRefresh ? { forceRefresh: true } : {}),
    };
    try {
      return await deps.readUsageHistory(Object.keys(readOpts).length === 0 ? undefined : readOpts);
    } catch {
      return deps.emptyUsageHistory();
    }
  });
}
