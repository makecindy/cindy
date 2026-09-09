import type { AgentEvent, Session } from '@cindy/maker-core';

import { buildTurnUsageDetails } from '../../shared/turnUsageDetails.js';

import { readClaudeApiKey } from '../maker-host/auth-adapters.js';
import { getCodexProxyAuthInjection } from '../maker-host/codex-proxy-host.js';
import { recordSessionTurnSpend, recordSessionTurnTokens } from '../sessionSpendBroadcaster.js';
import {
  codexUsageToTokens,
  recordSchedulerTurnCost,
  recordTurnUsageOnMessage,
} from '../turnCostBroadcaster.js';
import { triggerClaudeAccountUsageRefresh } from '../usage/claudeAccountUsage.js';
import { getGatewayModelPricingForModel, getModelPriceQuote } from '../usage/modelPricing.js';
import {
  getCodexProviderSubscriptionValuePrice,
  getReferenceModelPricing,
  getSubscriptionDirectValuePrice,
} from '../usage/referenceModelPricing.js';
import { codexApiUsageModelKey, codexSubscriptionUsageModelKey } from '../usage/usageHistory.js';
import {
  computePriceQuoteTurnMoney,
  normalizeTurnUsageSegments,
  normalizeModelIdForPricing,
  sumTurnUsageSegments,
} from '../usage/turnCostCalculator.js';
import { isExclusiveXaiModelId } from '../../shared/subscriptionModels.js';
import { type RegionalMoney } from '../../shared/regionalMoney.js';
import { currentLedgerCurrency } from '../usage/ledgerCurrency.js';
import { triggerXaiSubscriptionUsageRefresh } from './usage.js';
import {
  rebroadcastCodexTodayUsage,
  recordCodexTurnUsage,
  recordModelTurnUsage,
  recordTurnSpend,
} from '../usageBroadcaster.js';
import { broadcastSchedulerChanged } from './schedule.js';
import { getSessionProvider } from '../maker-host/session-provider-store.js';
import { getActiveCatalog } from '../maker-host/active-catalog.js';
import { isUserProviderSession } from '../maker-host/provider-route.js';

export interface RecordSessionCodexTurnUsageDeps {
  readonly turnModelPromiseBySession: Map<string, Promise<string>>;
  readonly readSessionModelForUsage: (sessionId: string) => Promise<string>;
  readonly unpricedSubscriptionValueMarker: () => RegionalMoney;
}

export function recordSessionCodexTurnUsage(
  deps: RecordSessionCodexTurnUsageDeps,
  session: Session,
  event: AgentEvent,
  turnAssistantPersistId: string | undefined,
) {
  // Codex done 事件: 记 today token 累计 (替代老 registerCodexIpc 里的 recordCodexTurnUsage 接入点)。
  // codex/index.ts 在 turn.completed 时把 SDK usage 翻成 camelCase 塞进 done.data.usage, 这里直接转给 broadcaster。
  // Codex SDK 不报 cost, 所以走 token 量(codex chip 显示 "本 session N token"), 跟 Claude 的 $ chip 是两条管道。
  if (event.type === 'done' && event.source === 'codex') {
    // 本会话显式选定的供应商('xd' / 'openai' / null=默认)。退役全局 authMode 后,
    // 「是否走订阅(不计网关费)」改由 spawn 注入 + 该会话是否显式选了 XD 网关决定。
    const sessionProvider = getSessionProvider(session.id);
    const isRemoteCodexSession = Boolean(session.remoteHostId);
    const isCustomProviderRoute = !isRemoteCodexSession && isUserProviderSession(session.id);
    const codexAuthInjection = isRemoteCodexSession ? null : getCodexProxyAuthInjection();
    const modelPromise =
      deps.turnModelPromiseBySession.get(session.id) ?? deps.readSessionModelForUsage(session.id);
    deps.turnModelPromiseBySession.delete(session.id);
    const usage = (event.data as { usage?: unknown } | undefined)?.usage;
    if (usage) recordCodexTurnUsage(usage);
    // 按模型记账: codex done.data.usage 是 **per-turn 增量语义** (maker-core
    // codexDoneUsage 契约: promptTokens=本 turn 未命中输入, completionTokens=完整输出
    // (reasoningTokens 只是其中的诊断子集), cachedTokens=命中缓存;
    // 整 turn 没收到 tokenUsage/updated 时全 0。
    // 直接入库, 不做 delta 化 —— 历史上 promptTokens 曾是 contextTokens 快照、这里
    // 做过 per-session delta 化, 语义改为 per-turn 后那套逻辑会把后小于前的 turn 记 0。
    if (usage && typeof usage === 'object') {
      const u = usage as {
        promptTokens?: number;
        completionTokens?: number;
        reasoningTokens?: number;
        cachedTokens?: number;
        segments?: unknown;
        durationMs?: number;
        turnDurationMs?: number;
      };
      const promptTokens = Number(u.promptTokens) || 0;
      const completionTokens = Number(u.completionTokens) || 0;
      const cachedTokens = Number(u.cachedTokens) || 0;
      const codexUsageSegments = normalizeTurnUsageSegments(u.segments);
      const codexSegmentTotals = sumTurnUsageSegments(codexUsageSegments);
      const codexSegmentsReliable =
        codexUsageSegments.length > 0 &&
        codexSegmentTotals.inputTokens === promptTokens &&
        codexSegmentTotals.outputTokens === completionTokens &&
        codexSegmentTotals.cacheReadTokens === cachedTokens;
      void recordSessionTurnTokens(session.id, promptTokens + completionTokens + cachedTokens);
      // 先落 daily_model_usage token 行, 再等价格表补 API cost。首页 usage push 会在
      // ~2s 后刷新, 不能让冷价格表 / 离线 fetch 把模型 token 行延后到刷新之后。
      // 后续 cost-only 增量不会重复累计 token。
      void (async () => {
        let pricingModel = 'unknown';
        let turnModel = 'unknown';
        try {
          turnModel = await modelPromise;
          // 只剥上下文后缀，保留 provider/SKU 前缀；`codex/gpt-*` 与裸
          // `gpt-*` 是不同售价和折扣，不能互相回落。
          pricingModel = normalizeModelIdForPricing(turnModel);
        } catch {
          // 模型读取失败时仍记录 token, 聚合 UI 会归到 unknown。
        }
        const isCodexBudgetRoute =
          (sessionProvider == null || sessionProvider === 'xd') &&
          pricingModel.startsWith('codex/');
        const isCodexXaiProviderRoute =
          (sessionProvider == null || sessionProvider === 'xai') &&
          isExclusiveXaiModelId(pricingModel);
        const isCodexOpenAiProviderRoute = sessionProvider == null || sessionProvider === 'openai';
        const hasGatewayKey = Boolean(readClaudeApiKey());
        const hasEffectiveGatewayRoute =
          !isRemoteCodexSession &&
          !isCustomProviderRoute &&
          (codexAuthInjection === 'env-key' ||
            isCodexBudgetRoute ||
            (sessionProvider === 'xd' && hasGatewayKey));
        // 显式来源的订阅判定以目录 access.kind 为权威(内置 anthropic 的 Claude.ai
        // 订阅同样是订阅价值,不能只认 OpenAI/xAI);目录缺 access 的旧快照仍靠下面
        // 的 openai oauth 分支兜底。
        const sessionProviderAccessKind = sessionProvider
          ? getActiveCatalog().providers.find((provider) => provider.id === sessionProvider)?.access
              ?.kind
          : null;
        const isCodexSubscriptionAccessRoute =
          !isRemoteCodexSession &&
          sessionProvider != null &&
          sessionProvider !== 'xd' &&
          sessionProviderAccessKind === 'subscription' &&
          !hasEffectiveGatewayRoute;
        const isSubscriptionValue =
          isRemoteCodexSession ||
          isCodexXaiProviderRoute ||
          isCodexSubscriptionAccessRoute ||
          (isCodexOpenAiProviderRoute &&
            codexAuthInjection === 'oauth-bearer' &&
            !hasEffectiveGatewayRoute);
        const usesReferencePriceEstimate =
          !isSubscriptionValue &&
          !isRemoteCodexSession &&
          !hasEffectiveGatewayRoute &&
          Boolean(sessionProvider && sessionProvider !== 'xd');
        const modelUsageKey = isSubscriptionValue
          ? codexSubscriptionUsageModelKey(pricingModel)
          : codexApiUsageModelKey(pricingModel);
        await recordModelTurnUsage({
          agentKind: 'codex',
          model: modelUsageKey,
          money: isSubscriptionValue ? deps.unpricedSubscriptionValueMarker() : undefined,
          inputTokensDelta: promptTokens,
          outputTokensDelta: completionTokens,
          cacheReadTokensDelta: cachedTokens,
          cacheCreateTokensDelta: 0,
        }).finally(() => rebroadcastCodexTodayUsage());

        // Codex SDK 不报 $, 用价格表折算。普通模型 + oauth(订阅)显示为 token 价值;api 模式和 codex/
        // 折扣模型走 gateway API, 显示为 API cost。远端 Codex 由远端 daemon
        // 路由,本机不知道远端 OAuth/API 事实,因此只显示 token 价值,不写本地
        // gateway cost。只有真实本地 API cost 写入 sessions.total_cost_usd,
        // 避免 scheduler 的 Cost 汇总混入订阅价值或远端账号消耗。
        // fire-and-forget 不阻塞事件循环;价格表走 main 端内存 + 磁盘缓存,
        // stale 快返并后台刷新,
        // 拉不到 / 模型无条目 → 只落 token 明细,UI 退回显示本轮 token。
        // 明细在 try 外构造:它只依赖上面已拿到的 token 数,价格请求抛错时也要能落。
        const turnUsageDetails = buildTurnUsageDetails({
          inputTokens: promptTokens,
          outputTokens: completionTokens,
          cacheReadTokens: cachedTokens,
          cacheCreateTokens: 0,
          model: turnModel,
          durationMs: u.durationMs,
          turnDurationMs: u.turnDurationMs,
        });
        const recordCodexUsageOnly = async () => {
          if (!turnAssistantPersistId) return;
          await recordTurnUsageOnMessage({
            sessionId: session.id,
            clientId: turnAssistantPersistId,
            turnUsageDetails,
          });
        };
        try {
          const pricing = isSubscriptionValue
            ? getReferenceModelPricing()
            : hasEffectiveGatewayRoute
              ? await getGatewayModelPricingForModel()
              : usesReferencePriceEstimate
                ? getReferenceModelPricing()
                : null;
          // 订阅估值按显式来源取各自的日期定价路由:内置 anthropic 走 Anthropic
          // registry 参考价(含 codex 侧价格覆盖),默认/openai 保持 OpenAI 价表。
          const subscriptionValueProviderId =
            isCodexSubscriptionAccessRoute && sessionProvider != null ? sessionProvider : 'openai';
          const price = isCodexXaiProviderRoute
            ? getSubscriptionDirectValuePrice(pricingModel, 'codex', pricing)
            : isSubscriptionValue
              ? getCodexProviderSubscriptionValuePrice(
                  subscriptionValueProviderId,
                  pricingModel,
                  pricing,
                )
              : hasEffectiveGatewayRoute
                ? getModelPriceQuote(pricing, 'xd', pricingModel)
                : usesReferencePriceEstimate
                  ? getModelPriceQuote(pricing, sessionProvider, pricingModel, 'codex')
                  : undefined;
          const money = computePriceQuoteTurnMoney(
            codexUsageToTokens(u),
            price ?? undefined,
            currentLedgerCurrency(),
            u.segments !== undefined && codexSegmentsReliable ? codexUsageSegments : [],
          );
          // Only Gateway sale prices are actual API spend. Third-party/user reference quotes
          // are value estimates and daily_model_usage cannot preserve RegionalMoney.kind, so
          // writing them into #billing=api would later reconstruct an estimate as actual cost.
          if (money && (isSubscriptionValue || price?.source === 'gateway')) {
            await recordModelTurnUsage({
              agentKind: 'codex',
              model: modelUsageKey,
              money,
              inputTokensDelta: 0,
              outputTokensDelta: 0,
              cacheReadTokensDelta: 0,
              cacheCreateTokensDelta: 0,
            });
          }
          if (money && money.amount > 0) {
            const isActualApiCost = !isSubscriptionValue && price?.source === 'gateway';
            if (isActualApiCost) {
              void recordTurnSpend(money);
              void recordSessionTurnSpend(session.id, money);
            }
            const changedScheduleId = await recordSchedulerTurnCost({
              sessionId: session.id,
              clientId: turnAssistantPersistId,
              money,
              turnUsageDetails,
              turnOrigin: event.turnOrigin,
            });
            if (changedScheduleId) broadcastSchedulerChanged(changedScheduleId);
          } else {
            await recordCodexUsageOnly();
          }
        } catch {
          // token row 已在价格请求前落库;价格失败只影响 API cost / message cost。
          // 消息那一格仍要有事实可看:补落一次 token 明细。patch 是 agent_meta merge、
          // 写的又是同一份明细,所以与上面成功分支重复执行也是幂等的(自身失败只 warn)。
          await recordCodexUsageOnly();
        }
      })();
    }
    // 走 gateway/API 口径(同一把 XD key 的 LiteLLM 计费)的 codex turn,done 后刷新账号配额
    // (与 cc 同口径, chip 显示 daily/monthly/key cost)。命中:会话显式选了 XD 网关、无 OAuth
    // token 的 env-key fallback、或 codex/ 预算模型。普通 oauth 订阅没有 $ 配额,不刷。
    void modelPromise
      .then((model) => {
        const hasGatewayKey = Boolean(readClaudeApiKey());
        if (!isRemoteCodexSession && isExclusiveXaiModelId(model)) {
          triggerXaiSubscriptionUsageRefresh();
          return;
        }
        if (
          !isRemoteCodexSession &&
          !isCustomProviderRoute &&
          !isExclusiveXaiModelId(model) &&
          (codexAuthInjection === 'env-key' ||
            model.startsWith('codex/') ||
            (sessionProvider === 'xd' && hasGatewayKey))
        ) {
          void triggerClaudeAccountUsageRefresh();
        }
      })
      .catch(() => {
        if (sessionProvider === 'xd' && readClaudeApiKey()) {
          void triggerClaudeAccountUsageRefresh();
        }
      });
  }
}
