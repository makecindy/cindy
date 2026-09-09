import type { AgentEvent, Session } from '@cindy/maker-core';

import { createLogger } from '../logger.js';
import { readClaudeApiKey } from '../maker-host/auth-adapters.js';
import { recordSessionTurnSpend } from '../sessionSpendBroadcaster.js';
import { recordSchedulerTurnCost, recordTurnUsageOnMessage } from '../turnCostBroadcaster.js';
import { recordModelMismatchOnMessage } from '../modelMismatchBroadcaster.js';
import { detectClaudeModelMismatch } from '../../shared/modelMismatch.js';
import { triggerClaudeAccountUsageRefresh } from '../usage/claudeAccountUsage.js';
import {
  getGatewayAccountCurrency,
  getGatewayModelPricingForModel,
} from '../usage/modelPricing.js';
import { getReferenceModelPricing } from '../usage/referenceModelPricing.js';
import {
  ClaudeOutputLagTimingGuard,
  computeModelUsageDeltas,
  type ModelUsageCumulative,
  type ModelUsageDeltaEntry,
} from '../usage/modelUsageDelta.js';
import {
  claudeSubscriptionUsageModelKey,
  getSubscriptionValuePriceFor,
} from '../usage/usageHistory.js';
import {
  billingRouteForExplicitProvider,
  buildClaudeTurnUsageDetails,
  computePriceQuoteTurnMoney,
  isAnthropicModel,
  normalizeTurnUsageSegments,
  normalizeModelIdForPricing,
  resolveClaudeTurnCostSinks,
  sumTurnUsageSegments,
  type BillingRoute,
} from '../usage/turnCostCalculator.js';
import {
  CHATGPT_MODEL_PREFIX,
  isExclusiveXaiModelId,
  isSubscriptionDirectRoute,
} from '../../shared/subscriptionModels.js';
import {
  addRegionalMoney,
  usdToLedgerCurrency,
  type RegionalMoney,
} from '../../shared/regionalMoney.js';
import { currentLedgerCurrency } from '../usage/ledgerCurrency.js';
import { CURRENT_CINDY_REGION } from '../../shared/brandRegion.js';
import {
  triggerClaudeSubscriptionUsageRefresh,
  triggerCodexAccountUsageRefresh,
  triggerXaiSubscriptionUsageRefresh,
} from './usage.js';
import {
  rebroadcastTodaySpend,
  recordModelTurnUsage,
  recordTurnSpend,
} from '../usageBroadcaster.js';
import { broadcastSchedulerChanged } from './schedule.js';
import { getSessionProvider } from '../maker-host/session-provider-store.js';
import { getActiveCatalog } from '../maker-host/active-catalog.js';
import { readClaudeSessionRoute } from '../maker-host/claude-session-route-registry.js';

export interface RecordSessionClaudeTurnUsageDeps {
  readonly turnModelPromiseBySession: Map<string, Promise<string>>;
  readonly readSessionModelForUsage: (sessionId: string) => Promise<string>;
  readonly lastReportedModelUsageBySession: Map<string, Map<string, ModelUsageCumulative>>;
  readonly claudeOutputLagTimingGuard: Pick<ClaudeOutputLagTimingGuard, 'evaluate'>;
  readonly lastReportedCostUsdBySession: Map<string, number>;
  readonly log: Pick<ReturnType<typeof createLogger>, 'warn'>;
  readonly unpricedSubscriptionValueMarker: () => RegionalMoney;
}

export function recordSessionClaudeTurnUsage(
  deps: RecordSessionClaudeTurnUsageDeps,
  session: Session,
  event: AgentEvent,
  turnAssistantPersistId: string | undefined,
  completedTurnWallClockMs: number | undefined,
  isContinuationBoundary: boolean,
) {
  // 每 turn 结束累加 daily_spend 表 + 广播给 renderer 右下角"今日 $X.XX" chip。
  // 这些统计 side effect 必须在 EVENT broadcast 之后，避免同步 SQLite 或额外
  // usage 广播延后 final/done 送达。
  //
  // 本轮费用 = HYBRID 定价: Anthropic 模型信任 SDK 自报 cost (OAuth 下=0、API 下=真实、
  // cache-correct), 非 Anthropic provider 模型 (gpt-5.5 等) 用远端 gateway 价 × token
  // 重算 —— 修 SDK 把它们按 Anthropic 价错算 (~2.5x) 的 bug。逐模型解析后四个 sink
  // (今日 / session / per-message / 按模型) 同源同值。
  // 守卫: index.ts:388 stream_end fallback / codex done 不带 total_cost_usd, typeof 检查会跳过。
  if (event.type === 'done' && event.source === 'claude-code') {
    const modelPromise =
      deps.turnModelPromiseBySession.get(session.id) ?? deps.readSessionModelForUsage(session.id);
    deps.turnModelPromiseBySession.delete(session.id);
    const doneData = event.data as
      | {
          total_cost_usd?: unknown;
          duration_ms?: unknown;
          duration_api_ms?: unknown;
          usage?: {
            input_tokens?: number;
            output_tokens?: number;
            cache_read_input_tokens?: number;
            cache_creation_input_tokens?: number;
          };
          modelUsage?: Record<string, unknown>;
          usageSegments?: unknown;
          usageSegmentsComplete?: unknown;
          modelUsageCumulativeStartsAtZero?: unknown;
          assistant_message_id?: unknown;
          is_error?: unknown;
        }
      | undefined;
    const cumulative = doneData?.total_cost_usd;
    const modelUsage = doneData?.modelUsage;
    // Missing request boundaries are an explicit pricing failure, including
    // older remote payloads. Flat aggregate arithmetic may look safe, but
    // the request's Fast/Batch variant is also unknown.
    const claudeUsageSegments = normalizeTurnUsageSegments(doneData?.usageSegments);
    const claudeUsageSegmentsComplete =
      doneData?.usageSegmentsComplete === true && (claudeUsageSegments?.length ?? 0) > 0;
    const claudeTurnDurationMs =
      completedTurnWallClockMs ??
      (typeof doneData?.duration_ms === 'number' ? doneData.duration_ms : undefined);
    let modelUsageDeltas: ModelUsageDeltaEntry[] | undefined;
    if (modelUsage && typeof modelUsage === 'object') {
      const observedByModel = claudeUsageSegmentsComplete
        ? (() => {
            const grouped = new Map<string, ReturnType<typeof sumTurnUsageSegments>>();
            for (const segment of claudeUsageSegments ?? []) {
              const model = normalizeModelIdForPricing(segment.model);
              const previous = grouped.get(model) ?? {
                inputTokens: 0,
                outputTokens: 0,
                cacheReadTokens: 0,
                cacheCreateTokens: 0,
              };
              grouped.set(model, {
                inputTokens: previous.inputTokens + segment.inputTokens,
                outputTokens: previous.outputTokens + segment.outputTokens,
                cacheReadTokens: previous.cacheReadTokens + segment.cacheReadTokens,
                cacheCreateTokens: previous.cacheCreateTokens + segment.cacheCreateTokens,
              });
            }
            return grouped;
          })()
        : undefined;
      const { next, deltas } = computeModelUsageDeltas(
        deps.lastReportedModelUsageBySession.get(session.id),
        modelUsage,
        observedByModel,
        {
          cumulativeStartsAtZero: doneData?.modelUsageCumulativeStartsAtZero === true,
        },
      );
      deps.lastReportedModelUsageBySession.set(session.id, next);
      modelUsageDeltas = deltas;
    }
    const outputLagTiming = deps.claudeOutputLagTimingGuard.evaluate(
      session.id,
      modelUsageDeltas ?? [],
      !isContinuationBoundary,
      typeof doneData?.assistant_message_id === 'string'
        ? doneData.assistant_message_id
        : undefined,
      doneData?.is_error !== true,
    );
    const claudeGenerationDurationMs = outputLagTiming.suppressTiming
      ? undefined
      : typeof doneData?.duration_api_ms === 'number'
        ? doneData.duration_api_ms
        : undefined;
    // total_cost_usd 累计基线: 主路径不靠它算钱, 但仍跟住, 以便万一某轮缺 modelUsage
    // 走兜底时累计差才准。先取"更新前"基线给兜底用, 再写入本轮累计。
    const prevReportedCost = deps.lastReportedCostUsdBySession.get(session.id);
    if (typeof cumulative === 'number' && cumulative >= 0) {
      deps.lastReportedCostUsdBySession.set(session.id, cumulative);
    }
    // 模型降级检测:所选模型(turn start 快照)整轮缺席于实际 modelUsage delta →
    // 判定主线被上游静默替换(如 fable-5 高负载被路由到 opus-4-8),把标记挂到本轮
    // 收尾 assistant 的 agent_meta 上(AssistantMessage 渲染降级提示行)。
    // fire-and-forget,与记账 sink 互不阻塞;判定纯函数见 shared/modelMismatch.ts。
    if (modelUsageDeltas && outputLagTiming.detected) {
      // 上游在 done 时点还没结算本轮输出(实测 Vertex),这一轮的费用会偏低、下一轮偏高。
      // 总量不丢,只是归属错位;不做纠正的理由见 usage/modelUsageDelta 文件头。
      deps.log.warn(
        `turn output likely lagging upstream settlement (session=${session.id}): ` +
          modelUsageDeltas
            .map(
              (d) =>
                `${d.model} out=${d.outputTokensDelta} in=${d.inputTokensDelta} ` +
                `cacheRead=${d.cacheReadTokensDelta} cacheCreate=${d.cacheCreateTokensDelta}`,
            )
            .join('; '),
      );
    }
    if (turnAssistantPersistId && modelUsageDeltas && modelUsageDeltas.length > 0) {
      const mismatchClientId = turnAssistantPersistId;
      const actualEntries = modelUsageDeltas.map((d) => ({
        model: d.model,
        outputTokens: d.outputTokensDelta,
      }));
      void modelPromise
        .then((selectedModel) => {
          const mismatch = detectClaudeModelMismatch(selectedModel, actualEntries);
          if (mismatch) {
            return recordModelMismatchOnMessage({
              sessionId: session.id,
              clientId: mismatchClientId,
              mismatch,
            });
          }
        })
        .catch(() => {
          /* 模型解析失败:跳过降级检测,非致命 */
        });
    }
    if (
      (modelUsageDeltas && modelUsageDeltas.length > 0) ||
      (claudeUsageSegments?.length ?? 0) > 0
    ) {
      // 主路径: 逐模型 HYBRID 定价 (Anthropic→SDK, 非 Anthropic→gateway), 四个 sink
      // 由同一份解析结果驱动。价格表走 main 端内存 + 磁盘缓存, stale 快返并后台刷新。
      const deltas = modelUsageDeltas ?? [];
      void (async () => {
        const sessionProviderForBilling = getSessionProvider(session.id);
        const observedClaudeRoute =
          sessionProviderForBilling == null ? readClaudeSessionRoute(session.id) : null;
        const explicitProviderBillingRoute = billingRouteForExplicitProvider(
          sessionProviderForBilling,
          sessionProviderForBilling
            ? getActiveCatalog().providers.find(
                (provider) => provider.id === sessionProviderForBilling,
              )?.access?.kind
            : null,
        );
        const isClaudeSubscriptionSession =
          !session.remoteHostId &&
          (sessionProviderForBilling === 'anthropic' ||
            (sessionProviderForBilling == null &&
              (observedClaudeRoute != null
                ? observedClaudeRoute === 'subscription'
                : !readClaudeApiKey())));
        const billingRoute: BillingRoute = session.remoteHostId
          ? 'unknown'
          : isClaudeSubscriptionSession
            ? 'subscription'
            : (explicitProviderBillingRoute ??
              (observedClaudeRoute === 'gateway' ? 'xd-gateway' : 'unknown'));
        const pricing =
          billingRoute === 'xd-gateway'
            ? await getGatewayModelPricingForModel()
            : getReferenceModelPricing();
        const { turnMoney, estimatedTurnMoney, perModel } = resolveClaudeTurnCostSinks(
          deltas,
          pricing,
          { providerId: sessionProviderForBilling, billingRoute, region: CURRENT_CINDY_REGION },
          claudeUsageSegments,
          claudeUsageSegmentsComplete,
        );
        const resolvedUsageDeltas: ModelUsageDeltaEntry[] = perModel.map((item) => ({
          model: item.model,
          costUsdDelta: item.money?.kind === 'actual-cost' ? item.money.amount : 0,
          inputTokensDelta: item.deltas.inputTokens,
          outputTokensDelta: item.deltas.outputTokens,
          cacheReadTokensDelta: item.deltas.cacheReadTokens,
          cacheCreateTokensDelta: item.deltas.cacheCreateTokens,
        }));
        // 按模型记账 (首页仪表盘"按模型拆分"): 保留 provider/SKU 前缀，
        // `codex/` 等预算路由必须精确命中自己的报价，不能回落到裸模型的另一折扣。
        // 订阅轮打 #billing=subscription 标记(Claude 订阅:Anthropic 模型 + cost=0),
        // 或 bridge 订阅轮(chatgpt// xai/ 前缀,source==='subscription');两类均需触发
        // rebroadcastTodaySpend 刷新首页仪表盘。
        const modelUsageWrites: Promise<unknown>[] = [];
        const subscriptionTurnEstimates: RegionalMoney[] = [];
        let hasSubscriptionValueRow = false;
        for (const m of perModel) {
          const isClaudeSubscriptionValueRow =
            isClaudeSubscriptionSession && !m.money && isAnthropicModel(m.model);
          const isBridgeSubscriptionRow =
            m.source === 'subscription' && isSubscriptionDirectRoute(m.model);
          const subscriptionEstimate =
            isClaudeSubscriptionValueRow || isBridgeSubscriptionRow
              ? computePriceQuoteTurnMoney(
                  m.deltas,
                  getSubscriptionValuePriceFor('claude-code', m.model, pricing),
                  currentLedgerCurrency(),
                  m.segments,
                )
              : null;
          if (subscriptionEstimate?.amount) {
            subscriptionTurnEstimates.push(subscriptionEstimate);
          }
          if (isClaudeSubscriptionValueRow || isBridgeSubscriptionRow)
            hasSubscriptionValueRow = true;
          const modelRowMoney =
            m.money?.kind === 'actual-cost'
              ? m.money
              : isClaudeSubscriptionValueRow || isBridgeSubscriptionRow
                ? (subscriptionEstimate ?? deps.unpricedSubscriptionValueMarker())
                : null;
          modelUsageWrites.push(
            recordModelTurnUsage({
              agentKind: 'claude-code',
              model:
                isClaudeSubscriptionValueRow || isBridgeSubscriptionRow
                  ? claudeSubscriptionUsageModelKey(m.model)
                  : m.model,
              // The subscription suffix lets the existing schema reconstruct this amount as
              // value-estimate, keeping it out of daily_spend and actual API totals.
              money: modelRowMoney,
              inputTokensDelta: m.deltas.inputTokens,
              outputTokensDelta: m.deltas.outputTokens,
              cacheReadTokensDelta: m.deltas.cacheReadTokens,
              cacheCreateTokensDelta: m.deltas.cacheCreateTokens,
            }),
          );
        }
        // 无真实费用、但产生订阅价值或 provider 参考估值的轮次不走
        // recordTurnSpend。等模型行落库后重广播今日 spend 快照,通知已打开的首页
        // 仪表盘刷新(对齐 codex 订阅轮的 rebroadcastCodexTodayUsage)。
        if ((hasSubscriptionValueRow || estimatedTurnMoney) && !turnMoney) {
          void Promise.allSettled(modelUsageWrites).then(() => rebroadcastTodaySpend());
        }
        if (turnMoney && turnMoney.amount > 0) {
          // 保留 #216 的 token/cache 明细随费用落库 (MessageActionBar tooltip)。
          // deltas 非空 → buildClaudeTurnUsageDetails 用 deltas 里的 model, fallbackModel 不取用。
          // 传 perModel → 落「按模型成本明细」(含 subagent 跑的模型, 如 Haiku)。
          const turnUsageDetails = buildClaudeTurnUsageDetails(
            doneData?.usage,
            resolvedUsageDeltas,
            'unknown',
            perModel,
            claudeGenerationDurationMs,
            claudeTurnDurationMs,
          );
          recordTurnSpend(turnMoney);
          recordSessionTurnSpend(session.id, turnMoney);
          // per-message 维度优先挂 assistant；纯 tool turn 则按 scheduler runId 直接归因。
          const changedScheduleId = await recordSchedulerTurnCost({
            sessionId: session.id,
            clientId: turnAssistantPersistId,
            money: turnMoney,
            turnUsageDetails,
            turnOrigin: event.turnOrigin,
          });
          if (changedScheduleId) broadcastSchedulerChanged(changedScheduleId);
        } else if (turnAssistantPersistId) {
          // 无真实计费轮的「本轮价值」估算,挂到消息(isEstimate:true,chip 的
          // "本会话价值"由 useSessionEstimatedValue 汇总),不进 daily_spend /
          // sessions.total_cost_usd(那些是真实账单)。provider 参考价与两类订阅估值
          // 可叠加(如 Claude 订阅主会话 + bridge 订阅子 agent):
          //   - provider-api 参考价:远程目录中的公开参考价,不是供应商真实账单;
          //   - bridge 订阅模型(chatgpt/ / xai/,source==='subscription'):静态参考价折算;
          //   - Claude 订阅会话(显式选 Anthropic,SDK 自报 cost=0):Anthropic 牌价折算
          //     (纯 Anthropic 轮 pricing 为 null → 家族牌价兜底表,不为估值发起网络请求)。
          // 混合轮(真实计费 > 0)走上面的真实分支,订阅部分不另挂估算 —— 一条消息只有一个
          // cost 字段,真实计费优先;订阅 token 明细仍在 turnUsageDetails.perModelCost 里。
          const estimatedValues: RegionalMoney[] = estimatedTurnMoney ? [estimatedTurnMoney] : [];
          estimatedValues.push(...subscriptionTurnEstimates);
          const turnEstimatedValue =
            estimatedValues.length > 0 ? addRegionalMoney(estimatedValues) : null;
          const turnUsageDetails = buildClaudeTurnUsageDetails(
            doneData?.usage,
            resolvedUsageDeltas,
            'unknown',
            perModel,
            claudeGenerationDurationMs,
            claudeTurnDurationMs,
          );
          if (turnEstimatedValue && turnEstimatedValue.amount > 0) {
            const changedScheduleId = await recordSchedulerTurnCost({
              sessionId: session.id,
              clientId: turnAssistantPersistId,
              money: turnEstimatedValue,
              turnUsageDetails,
              turnOrigin: event.turnOrigin,
            });
            if (changedScheduleId) broadcastSchedulerChanged(changedScheduleId);
          } else {
            // 真实计费与订阅估值都拿不到(典型:网关目录整体不下发价格、模型不在价表)
            // —— 钱没有,但 token 明细是算好的,落下来让 UI 退回显示本轮 token。
            await recordTurnUsageOnMessage({
              sessionId: session.id,
              clientId: turnAssistantPersistId,
              turnUsageDetails,
            });
          }
        }
      })();
    } else if (typeof cumulative === 'number' && cumulative >= 0) {
      // 窄兜底: 罕见地 done 只带 total_cost_usd、没 modelUsage / request segments ——
      // 拆不了 daily_model_usage, 只在已有累计基线后用 cost delta 记总额。
      // The first cumulative snapshot after restart/reattach may contain
      // the whole provider process lifetime. With neither modelUsage nor
      // request segments, only establish the baseline.
      const rawDelta =
        prevReportedCost === undefined ? 0 : Math.max(0, cumulative - prevReportedCost);
      void (async () => {
        let resolvedModel = 'unknown';
        try {
          const model = await modelPromise;
          resolvedModel = model;
        } catch {
          /* non-fatal: 保留 SDK 原始 cost */
        }
        // `doneData.usage` can be the same process-lifetime cumulative snapshot as
        // `total_cost_usd`. Without model deltas or request segments it is not a reliable
        // per-turn token fact, so retain only model/timing metadata in this fallback.
        const turnUsageDetails = buildClaudeTurnUsageDetails(
          undefined,
          undefined,
          resolvedModel,
          undefined,
          claudeGenerationDurationMs,
          claudeTurnDurationMs,
        );
        // 本分支有三个"记不了钱"的出口(本轮 cost 未增长 / 订阅直连 / 非明确
        // provider-api 路由)。只保留可证明的模型与时长；进程累计 usage 不能冒充本轮 token。
        const recordUsageOnly = async () => {
          if (!turnAssistantPersistId) return;
          await recordTurnUsageOnMessage({
            sessionId: session.id,
            clientId: turnAssistantPersistId,
            turnUsageDetails,
          });
        };
        if (rawDelta <= 0) {
          await recordUsageOnly();
          return;
        }
        const providerId = getSessionProvider(session.id);
        const observedRoute = providerId == null ? readClaudeSessionRoute(session.id) : null;
        const explicitProviderRoute = billingRouteForExplicitProvider(
          providerId,
          providerId
            ? getActiveCatalog().providers.find((provider) => provider.id === providerId)?.access
                ?.kind
            : null,
        );
        const route: BillingRoute = session.remoteHostId
          ? 'unknown'
          : providerId === 'anthropic' || observedRoute === 'subscription'
            ? 'subscription'
            : (explicitProviderRoute ?? (observedRoute === 'gateway' ? 'xd-gateway' : 'unknown'));
        // 订阅直连轮(chatgpt/ / xai/)走窄兜底时: 真实计费恒 0, 不写 daily_spend /
        // sessions.total_cost_usd(与主路径 resolveTurnCost 的 subscription gate 同口径,
        // 避免把订阅 SDK 自报 cost 误记进计费)。但显式 provider-api 是权威路由:
        // 自定义 API 供应商可能供应带订阅前缀的模型 id,不能按前缀把真实费用判掉。
        if (route !== 'provider-api' && isSubscriptionDirectRoute(resolvedModel)) {
          await recordUsageOnly();
          return;
        }
        // A cumulative SDK dollar value is authoritative only for an
        // explicitly selected provider API. Remote/unknown routing cannot
        // be attributed to this local account and must stay usage-only.
        if (route !== 'provider-api') {
          await recordUsageOnly();
          return;
        }
        const ledgerCurrency = (await getGatewayAccountCurrency()) ?? currentLedgerCurrency();
        const money = usdToLedgerCurrency(rawDelta, ledgerCurrency);
        recordTurnSpend(money);
        recordSessionTurnSpend(session.id, money);
        const changedScheduleId = await recordSchedulerTurnCost({
          sessionId: session.id,
          clientId: turnAssistantPersistId,
          money,
          turnUsageDetails,
          turnOrigin: event.turnOrigin,
        });
        if (changedScheduleId) broadcastSchedulerChanged(changedScheduleId);
      })();
    }
    // 与 spend 记账并列的另一个 turn-done side-effect: 刷新 Claude 账号月度配额
    // (LiteLLM /v2/user/info)。fire-and-forget, 模块内 2s 超时 + 10s 节流。
    // 故意放在 cumulative 块外面: spend 走 turn delta, 配额走 HTTP API, 两件事独立;
    // 但仍在 done && claude-code 的 if 内, 不要每个事件都打一次。
    void triggerClaudeAccountUsageRefresh();
    // chatgpt/ 订阅轮: 额外触发 ChatGPT wham 额度刷新(与 codex 同一 ChatGPT 账户),让底部
    // chip 的订阅额度实时更新 —— bridge 轮不产生 codex account_usage 事件,须主动触发。
    void modelPromise
      .then((m) => {
        if (m && m.startsWith(CHATGPT_MODEL_PREFIX)) triggerCodexAccountUsageRefresh();
        if (m && isExclusiveXaiModelId(m)) triggerXaiSubscriptionUsageRefresh();
      })
      .catch(() => {
        /* 模型解析失败: 跳过, 非致命 */
      });
    // Claude 订阅账号余量 (oauth/usage 端点) 同理 turn-done 触发一次 —— 节流 (180s) /
    // 429 退避 / 未连订阅 no-op 都在 reader 内部; turn 内的实时刷新由 proxy 旁路读
    // unified headers 兜住, 这里只负责把 scoped 分模型窗口等端点独有数据拉新。
    triggerClaudeSubscriptionUsageRefresh();
  }
}
