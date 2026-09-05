import type { AgentEvent, Session } from '@cindy/maker-core';

import { buildTurnUsageDetails } from '../../shared/turnUsageDetails.js';
import { recordSessionTurnSpend, recordSessionTurnTokens } from '../sessionSpendBroadcaster.js';
import {
  piUsageToTokens,
  recordSchedulerTurnCost,
  recordTurnUsageOnMessage,
} from '../turnCostBroadcaster.js';
import { triggerClaudeAccountUsageRefresh } from '../usage/claudeAccountUsage.js';
import { getGatewayModelPricingForModel } from '../usage/modelPricing.js';
import { getReferenceModelPricing } from '../usage/referenceModelPricing.js';
import {
  getSubscriptionValuePriceFor,
  piSubscriptionUsageModelKey,
} from '../usage/usageHistory.js';
import {
  computePriceQuoteTurnMoney,
  normalizeTurnUsageSegments,
  normalizeModelIdForPricing,
  resolveTurnCost,
  sumTurnUsageSegments,
  type BillingRoute,
} from '../usage/turnCostCalculator.js';
import {
  CHATGPT_MODEL_PREFIX,
  XAI_MODEL_PREFIX,
  isSubscriptionDirectRoute,
} from '../../shared/subscriptionModels.js';
import { addRegionalMoney, type RegionalMoney } from '../../shared/regionalMoney.js';
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
import { isUserProviderSession } from '../maker-host/provider-route.js';
import { getSessionFastMode } from '../maker-host/session-effort-store.js';

export interface RecordSessionPiTurnUsageDeps {
  readonly turnPiFastModeBySession: Map<string, boolean>;
  readonly turnModelPromiseBySession: Map<string, Promise<string>>;
  readonly readSessionModelForUsage: (sessionId: string) => Promise<string>;
  readonly unpricedSubscriptionValueMarker: () => RegionalMoney;
}

export function recordSessionPiTurnUsage(
  deps: RecordSessionPiTurnUsageDeps,
  session: Session,
  event: AgentEvent,
  turnAssistantPersistId: string | undefined,
) {
  // Pi done 事件同样携带 per-turn token/cache 明细。Pi 复用 Cindy 的 provider
  // 路由，因此计费形态必须看 session provider，而不是把它当成一个新的计费方：
  //   openai / anthropic / xai → 用户订阅，显示剩余窗口 + 本对话价值；
  //   xd / 默认网关            → 实际 gateway cost。
  // usage 事实无论价格是否可解析都持久化，保证新模型也能看到 cache 命中明细。
  if (event.type === 'done' && event.source === 'pi') {
    const sessionProvider = getSessionProvider(session.id);
    // New Pi payloads carry the tariff on every request segment. Keep the
    // turn-start snapshot only as a compatibility fallback for older or
    // incomplete payloads that have no explicit priceVariant.
    const piPriceVariant =
      (deps.turnPiFastModeBySession.get(session.id) ?? getSessionFastMode(session.id))
        ? 'priority'
        : 'standard';
    deps.turnPiFastModeBySession.delete(session.id);
    const modelPromise =
      deps.turnModelPromiseBySession.get(session.id) ?? deps.readSessionModelForUsage(session.id);
    deps.turnModelPromiseBySession.delete(session.id);
    const rawUsage = (event.data as { usage?: unknown } | undefined)?.usage;
    if (rawUsage && typeof rawUsage === 'object') {
      const tokens = piUsageToTokens(
        rawUsage as {
          inputTokens?: number;
          outputTokens?: number;
          cacheReadTokens?: number;
          cacheCreationTokens?: number;
        },
      );
      const piUsageSegments = normalizeTurnUsageSegments(
        (rawUsage as { segments?: unknown }).segments,
      ).map((segment) => ({
        ...segment,
        // Parent requests use this session's bridge preference. Delegated
        // child requests have an independent process and are standard
        // unless their own payload explicitly reports another variant.
        priceVariant:
          segment.priceVariant ?? (segment.id?.startsWith('pi:') ? piPriceVariant : 'standard'),
      }));
      const piSegmentTotals = sumTurnUsageSegments(piUsageSegments);
      const piSegmentsReliable =
        (rawUsage as { segmentsComplete?: unknown }).segmentsComplete === true &&
        piUsageSegments.length > 0 &&
        piSegmentTotals.inputTokens === tokens.inputTokens &&
        piSegmentTotals.outputTokens === tokens.outputTokens &&
        piSegmentTotals.cacheReadTokens === tokens.cacheReadTokens &&
        piSegmentTotals.cacheCreateTokens === tokens.cacheCreateTokens;
      const totalTokens =
        tokens.inputTokens +
        tokens.outputTokens +
        tokens.cacheReadTokens +
        tokens.cacheCreateTokens;
      void recordSessionTurnTokens(session.id, totalTokens);
      void (async () => {
        let turnModel = 'unknown';
        try {
          turnModel = await modelPromise;
        } catch {
          // 模型读取失败仍持久化 token/cache，模型显示为 unknown。
        }
        const pricingModel = normalizeModelIdForPricing(turnModel);
        const isCustomProviderRoute = isUserProviderSession(session.id);
        const effectiveProvider =
          sessionProvider ??
          (pricingModel.startsWith(CHATGPT_MODEL_PREFIX)
            ? 'openai'
            : pricingModel.startsWith(XAI_MODEL_PREFIX)
              ? 'xai'
              : null);
        const isSubscriptionValue =
          effectiveProvider === 'openai' ||
          effectiveProvider === 'anthropic' ||
          effectiveProvider === 'xai' ||
          (!isCustomProviderRoute && isSubscriptionDirectRoute(pricingModel));
        const billingRoute: BillingRoute = isCustomProviderRoute
          ? 'provider-api'
          : isSubscriptionValue
            ? 'subscription'
            : 'xd-gateway';
        const effectiveSegments = piSegmentsReliable ? piUsageSegments : [];
        const groupedSegments = new Map<
          string,
          { segments: typeof effectiveSegments; tokens: typeof tokens; sdkCostUsd: number }
        >();
        for (const segment of effectiveSegments) {
          const model = normalizeModelIdForPricing(segment.model ?? turnModel);
          const group = groupedSegments.get(model) ?? {
            segments: [],
            tokens: {
              inputTokens: 0,
              outputTokens: 0,
              cacheReadTokens: 0,
              cacheCreateTokens: 0,
            },
            sdkCostUsd: 0,
          };
          group.segments.push(segment);
          group.tokens.inputTokens += segment.inputTokens;
          group.tokens.outputTokens += segment.outputTokens;
          group.tokens.cacheReadTokens += segment.cacheReadTokens;
          group.tokens.cacheCreateTokens += segment.cacheCreateTokens;
          group.sdkCostUsd += segment.costUsd ?? 0;
          groupedSegments.set(model, group);
        }
        // An explicitly incomplete segment payload must not be collapsed
        // into one synthetic request for pricing. Keep the aggregate token
        // fact under the selected model while leaving money unavailable.
        if (groupedSegments.size === 0) {
          groupedSegments.set(pricingModel, { segments: [], tokens, sdkCostUsd: 0 });
        }

        const durationMs =
          typeof (rawUsage as { durationMs?: unknown }).durationMs === 'number'
            ? (rawUsage as { durationMs: number }).durationMs
            : undefined;
        const turnDurationMs =
          typeof (rawUsage as { turnDurationMs?: unknown }).turnDurationMs === 'number'
            ? (rawUsage as { turnDurationMs: number }).turnDurationMs
            : undefined;
        const usageOnlyDetails = buildTurnUsageDetails({
          ...tokens,
          model: groupedSegments.size === 1 ? [...groupedSegments.keys()][0] : undefined,
          models: [...groupedSegments.keys()],
          durationMs,
          turnDurationMs,
        });

        try {
          const pricing =
            billingRoute === 'xd-gateway'
              ? await getGatewayModelPricingForModel()
              : getReferenceModelPricing();
          const actualMonies: RegionalMoney[] = [];
          const estimatedMonies: RegionalMoney[] = [];
          const perModelCost: Array<{ model: string; money: RegionalMoney }> = [];
          const modelWrites: Promise<unknown>[] = [];
          for (const [model, group] of groupedSegments) {
            // Missing/incomplete request boundaries are explicitly unpriceable. A provider-
            // reported request cost may still win in resolveTurnCost; token × quote must not
            // collapse the whole turn into one synthetic long-context request.
            const pricingSegments = piSegmentsReliable ? group.segments : [];
            let money: RegionalMoney | null = null;
            if (billingRoute === 'subscription') {
              const quote = getSubscriptionValuePriceFor('pi', model, pricing);
              money = computePriceQuoteTurnMoney(
                group.tokens,
                quote ?? undefined,
                currentLedgerCurrency(),
                pricingSegments,
              );
            } else {
              money = resolveTurnCost({
                rawModel: model,
                tokens: group.tokens,
                // Pi computes usage.cost from its local model catalog. For
                // BYOM/provider-api routes that is a reference estimate,
                // not a provider invoice. Let the provider quote path mark
                // it as value-estimate instead of recording it as actual.
                sdkCostDelta: billingRoute === 'provider-api' ? undefined : group.sdkCostUsd,
                pricing,
                context: {
                  providerId: sessionProvider,
                  billingRoute,
                  region: CURRENT_CINDY_REGION,
                },
                segments: pricingSegments,
              }).money;
            }
            if (money?.amount) {
              perModelCost.push({ model, money });
              (money.kind === 'actual-cost' ? actualMonies : estimatedMonies).push(money);
            }
            const modelUsageKey = isSubscriptionValue ? piSubscriptionUsageModelKey(model) : model;
            const modelRowMoney =
              money?.kind === 'actual-cost'
                ? money
                : isSubscriptionValue
                  ? (money ?? deps.unpricedSubscriptionValueMarker())
                  : null;
            modelWrites.push(
              recordModelTurnUsage({
                agentKind: 'pi',
                model: modelUsageKey,
                // daily_model_usage has no money-kind column. Subscription
                // rows recover value-estimate from their suffix; other
                // reference estimates must stay message-only or they would
                // be reconstructed later as actual spend.
                money: modelRowMoney,
                inputTokensDelta: group.tokens.inputTokens,
                outputTokensDelta: group.tokens.outputTokens,
                cacheReadTokensDelta: group.tokens.cacheReadTokens,
                cacheCreateTokensDelta: group.tokens.cacheCreateTokens,
              }),
            );
          }
          await Promise.allSettled(modelWrites);
          void rebroadcastTodaySpend();
          const actualMoney = actualMonies.length > 0 ? addRegionalMoney(actualMonies) : null;
          const estimatedMoney =
            estimatedMonies.length > 0 ? addRegionalMoney(estimatedMonies) : null;
          const messageMoney = actualMoney ?? estimatedMoney;
          const turnUsageDetails = buildTurnUsageDetails({
            ...tokens,
            model: groupedSegments.size === 1 ? [...groupedSegments.keys()][0] : undefined,
            models: [...groupedSegments.keys()],
            perModelCost,
            durationMs,
            turnDurationMs,
          });
          if (actualMoney) {
            void recordTurnSpend(actualMoney);
            void recordSessionTurnSpend(session.id, actualMoney);
          }
          if (messageMoney) {
            const changedScheduleId = await recordSchedulerTurnCost({
              sessionId: session.id,
              clientId: turnAssistantPersistId,
              money: messageMoney,
              turnUsageDetails,
              turnOrigin: event.turnOrigin,
            });
            if (changedScheduleId) broadcastSchedulerChanged(changedScheduleId);
          } else if (turnAssistantPersistId && turnUsageDetails) {
            await recordTurnUsageOnMessage({
              sessionId: session.id,
              clientId: turnAssistantPersistId,
              turnUsageDetails,
            });
          }
        } catch {
          // Price/catalog failure must not lose token/cache facts.
          const writes = [...groupedSegments].map(([model, group]) =>
            recordModelTurnUsage({
              agentKind: 'pi',
              model: isSubscriptionValue ? piSubscriptionUsageModelKey(model) : model,
              money: isSubscriptionValue ? deps.unpricedSubscriptionValueMarker() : undefined,
              inputTokensDelta: group.tokens.inputTokens,
              outputTokensDelta: group.tokens.outputTokens,
              cacheReadTokensDelta: group.tokens.cacheReadTokens,
              cacheCreateTokensDelta: group.tokens.cacheCreateTokens,
            }),
          );
          await Promise.allSettled(writes);
          void rebroadcastTodaySpend();
          if (turnAssistantPersistId && usageOnlyDetails) {
            await recordTurnUsageOnMessage({
              sessionId: session.id,
              clientId: turnAssistantPersistId,
              turnUsageDetails: usageOnlyDetails,
            });
          }
        }

        if (effectiveProvider === 'openai') {
          triggerCodexAccountUsageRefresh();
        } else if (effectiveProvider === 'anthropic') {
          triggerClaudeSubscriptionUsageRefresh();
        } else if (effectiveProvider === 'xai') {
          triggerXaiSubscriptionUsageRefresh();
        } else if (effectiveProvider === 'xd' || effectiveProvider == null) {
          void triggerClaudeAccountUsageRefresh();
        }
      })();
    }
  }
}
