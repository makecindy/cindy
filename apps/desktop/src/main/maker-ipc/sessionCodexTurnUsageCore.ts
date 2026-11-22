import { companyModelTokens, takeCompanyTurn } from '../usage/companyTokenFacts.js';
import { captureTurnUsageContext, tokenAttribution, turnBillingSource, type TurnUsageContext } from './turnUsageContextCore.js';
import type { AgentEvent, Session } from '@cindy/maker-core';

import { buildTurnUsageDetails } from '../../shared/turnUsageDetails.js';

import { readClaudeApiKey } from './turnUsagePorts.js';
import { getCodexProxyAuthInjection } from './turnUsagePorts.js';
import { recordSessionTurnSpend, recordSessionTurnTokens } from './turnUsagePorts.js';
import {
  recordSchedulerTurnCost,
  recordTurnUsageOnMessage,
} from './turnUsagePorts.js';
import { triggerClaudeAccountUsageRefresh } from './turnUsagePorts.js';
import { getGatewayModelPricingForModel, getModelPriceQuote } from './turnUsagePorts.js';
import {
  getCodexProviderSubscriptionValuePrice,
  getReferenceModelPricing,
  getSubscriptionDirectValuePrice,
} from '../usage/referenceModelPricingCore.js';
import { codexApiUsageModelKey, codexSubscriptionUsageModelKey } from '../usage/usageModelKeys.js';
import {
  computePriceQuoteTurnMoney,
  normalizeTurnUsageSegments,
  normalizeModelIdForPricing,
  sumTurnUsageSegments,
} from '../usage/turnCostCalculator.js';
import { isExclusiveXaiModelId } from '../../shared/subscriptionModels.js';
import { isCodexGatewayWireModel } from '@cindy/model-providers';
import { sumMoneyByCurrency, type RegionalMoney } from '../../shared/regionalMoney.js';
import { triggerClaudeSubscriptionUsageRefresh, triggerXaiSubscriptionUsageRefresh } from './turnUsagePorts.js';
import { isClaudeSubscriptionProviderId } from '../maker-host/subscription-account-kind.js';
import {
  rebroadcastCodexTodayUsage,
  recordCodexTurnUsage,
  recordModelTurnUsage,
  recordTurnSpend,
} from './turnUsagePorts.js';
import { broadcastSchedulerChanged } from './turnUsagePorts.js';

export interface RecordSessionCodexTurnUsageDeps {
  readonly turnUsageContextBySession: Map<string, TurnUsageContext>;
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
    const recordedAt = Date.now();
    const capturedContext = deps.turnUsageContextBySession.get(session.id) ?? captureTurnUsageContext(session.id, undefined, 'codex');
    deps.turnUsageContextBySession.delete(session.id);
    // 本会话显式选定的供应商('xd' / 'openai' / null=默认)。退役全局 authMode 后,
    // 「是否走订阅(不计网关费)」改由 spawn 注入 + 该会话是否显式选了 XD 网关决定。
    const isRemoteCodexSession = Boolean(session.remoteHostId || session.agentDeviceId);
    const usage = (event.data as { usage?: { execution?: {
      providerId?: string | null; credentialMode?: string | null; model?: string;
    } } } | undefined)?.usage;
    const execution = !isRemoteCodexSession ? usage?.execution : undefined;
    const turnContext = execution && (typeof execution.providerId === 'string' || execution.providerId === null)
      && execution.providerId !== capturedContext.providerId
      ? captureTurnUsageContext(session.id, execution.providerId, 'codex') : capturedContext;
    const sessionProvider = turnContext.providerId;
    const isCustomProviderRoute = !isRemoteCodexSession && turnContext.isUserProviderRoute;
    const codexAuthInjection = execution
      ? execution.credentialMode === 'gateway-key' ? 'env-key'
        : execution.credentialMode === 'oauth-bearer' ? 'oauth-bearer' : null
      : isRemoteCodexSession ? null : getCodexProxyAuthInjection();
    const modelPromise =
      deps.turnModelPromiseBySession.get(session.id) ?? deps.readSessionModelForUsage(session.id);
    deps.turnModelPromiseBySession.delete(session.id);
    if (usage) recordCodexTurnUsage(usage);
    // 按模型记账: codex done.data.usage 是 **per-turn 增量语义** (maker-core
    // codexDoneUsage 契约: promptTokens=本 turn 未命中输入, completionTokens=完整输出
    // (reasoningTokens 只是其中的诊断子集), cachedTokens=命中缓存, cacheCreationTokens=写入缓存;
    // 整 turn 没收到 tokenUsage/updated 时全 0。
    // 直接入库, 不做 delta 化 —— 历史上 promptTokens 曾是 contextTokens 快照、这里
    // 做过 per-session delta 化, 语义改为 per-turn 后那套逻辑会把后小于前的 turn 记 0。
    if (usage && typeof usage === 'object') {
      const u = usage as {
        promptTokens?: number;
        completionTokens?: number;
        reasoningTokens?: number;
        cachedTokens?: number;
        cacheCreationTokens?: number;
        segments?: unknown;
        durationMs?: number;
        turnDurationMs?: number;
        generationTrace?: unknown;
      };
      const promptTokens = Number(u.promptTokens) || 0;
      const completionTokens = Number(u.completionTokens) || 0;
      const cachedTokens = Number(u.cachedTokens) || 0;
      const cacheCreationTokens = Number(u.cacheCreationTokens) || 0;
      const codexUsageSegments = normalizeTurnUsageSegments(u.segments);
      const codexSegmentTotals = sumTurnUsageSegments(codexUsageSegments);
      const codexSegmentsReliable =
        codexUsageSegments.length > 0 &&
        codexSegmentTotals.inputTokens === promptTokens &&
        codexSegmentTotals.outputTokens === completionTokens &&
        codexSegmentTotals.cacheReadTokens === cachedTokens &&
        codexSegmentTotals.cacheCreateTokens === cacheCreationTokens;
      void recordSessionTurnTokens(session.id, promptTokens + completionTokens + cachedTokens + cacheCreationTokens);
      // 先落 daily_model_usage token 行, 再等价格表补 API cost。首页 usage push 会在
      // ~2s 后刷新, 不能让冷价格表 / 离线 fetch 把模型 token 行延后到刷新之后。
      // 后续 cost-only 增量不会重复累计 token。
      void (async () => {
        let pricingModel = 'unknown';
        let turnModel = 'unknown';
        try {
          turnModel = execution?.model || await modelPromise.catch(() => 'unknown');
          // 只剥上下文后缀，保留 provider/SKU 前缀；`codex/gpt-*` 与裸
          // `gpt-*` 是不同售价和折扣，不能互相回落。
          pricingModel = normalizeModelIdForPricing(turnModel);
        } catch {
          // 模型读取失败时仍记录 token, 聚合 UI 会归到 unknown。
        }
        const isCodexBudgetRoute =
          (sessionProvider == null || sessionProvider === 'xd') &&
          isCodexGatewayWireModel(pricingModel);
        const isCodexXaiProviderRoute =
          (sessionProvider == null || sessionProvider === 'xai') &&
          isExclusiveXaiModelId(pricingModel);
        const isCodexOpenAiProviderRoute = sessionProvider == null || sessionProvider === 'openai';
        const hasGatewayKey = !isRemoteCodexSession && Boolean(readClaudeApiKey());
        const hasEffectiveGatewayRoute =
          !isRemoteCodexSession &&
          !isCustomProviderRoute &&
          (codexAuthInjection === 'env-key' ||
            isCodexBudgetRoute ||
            (sessionProvider === 'xd' && hasGatewayKey));
        // 显式来源的订阅判定以目录 access.kind 为权威(内置 anthropic 的 Claude.ai
        // 订阅同样是订阅价值,不能只认 OpenAI/xAI);目录缺 access 的旧快照仍靠下面
        // 的 openai oauth 分支兜底。
        const sessionProviderAccessKind = turnContext.accessKind;
        const isCodexSubscriptionAccessRoute =
          !isRemoteCodexSession &&
          sessionProvider != null &&
          sessionProvider !== 'xd' &&
          sessionProviderAccessKind === 'subscription' &&
          !hasEffectiveGatewayRoute;
        const isSubscriptionValue = !isRemoteCodexSession && (
          isCodexXaiProviderRoute ||
          isCodexSubscriptionAccessRoute ||
          (isCodexOpenAiProviderRoute &&
            codexAuthInjection === 'oauth-bearer' &&
            !hasEffectiveGatewayRoute));
        const usesReferencePriceEstimate =
          !isSubscriptionValue &&
          !isRemoteCodexSession &&
          !hasEffectiveGatewayRoute &&
          Boolean(sessionProvider && sessionProvider !== 'xd');
        if (!isRemoteCodexSession && execution?.credentialMode !== 'gateway-key' &&
            !hasEffectiveGatewayRoute && sessionProvider !== 'xd' &&
            (isCodexSubscriptionAccessRoute || codexAuthInjection === 'oauth-bearer' || isCustomProviderRoute)) {
          const record = takeCompanyTurn(turnContext);
          if (record && codexSegmentsReliable) {
            record(codexUsageSegments.flatMap(segment => segment.model
              ? [companyModelTokens(normalizeModelIdForPricing(segment.model), segment)] : []));
          } else if (record && execution?.model && u.segments === undefined) {
            record([{ model: pricingModel, input: promptTokens, output: completionTokens, cacheRead: cachedTokens, cacheWrite: cacheCreationTokens }]);
          }
        }
        // Keep unknown remote routes token-only, without a billing suffix that
        // would classify them as API spend or trigger subscription revaluation.
        const billing = turnBillingSource(turnContext, isSubscriptionValue ? 'subscription' : hasEffectiveGatewayRoute ? 'xd-gateway' : usesReferencePriceEstimate ? 'provider-api' : 'unknown');
        if (isSubscriptionValue && !billing.providerId) billing.providerId = isCodexXaiProviderRoute ? 'xai' : 'openai';
        const turnUsageDetails = buildTurnUsageDetails({
          ...billing,
          perModelTokens: execution && codexSegmentsReliable
            ? codexUsageSegments.map(segment => ({ ...billing, ...segment, model: segment.model ?? turnModel }))
            : [{ ...billing, model: turnModel, inputTokens: promptTokens, outputTokens: completionTokens, cacheReadTokens: cachedTokens, cacheCreateTokens: cacheCreationTokens }],
          inputTokens: promptTokens,
          outputTokens: completionTokens,
          cacheReadTokens: cachedTokens,
          cacheCreateTokens: cacheCreationTokens,
          model: turnModel,
          durationMs: u.durationMs,
          turnDurationMs: u.turnDurationMs,
          trace: u.generationTrace,
        });
        const tokenRows = turnUsageDetails?.perModelTokens ?? [];
        await Promise.all(tokenRows.map(row => recordModelTurnUsage({
          sessionId: session.id, agentKind: 'codex',
          model: isRemoteCodexSession ? normalizeModelIdForPricing(row.model)
            : isSubscriptionValue ? codexSubscriptionUsageModelKey(normalizeModelIdForPricing(row.model))
              : codexApiUsageModelKey(normalizeModelIdForPricing(row.model)),
          recordedAt, attribution: isRemoteCodexSession ? undefined : {
            ...tokenAttribution(row, turnContext),
            ...(!(execution && codexSegmentsReliable && codexUsageSegments
              .filter(segment => (segment.model ?? turnModel) === row.model)
              .every(segment => segment.model && segment.modelConfirmed === true))
              ? { modelUnconfirmed: true } : {}),
          },
          money: isSubscriptionValue ? deps.unpricedSubscriptionValueMarker() : undefined,
          inputTokensDelta: row.inputTokens, outputTokensDelta: row.outputTokens,
          cacheReadTokensDelta: row.cacheReadTokens, cacheCreateTokensDelta: row.cacheCreateTokens,
        }))).finally(() => rebroadcastCodexTodayUsage());

        // Codex SDK 不报 $, 用价格表折算。普通模型 + oauth(订阅)显示为 token 价值;api 模式和 codex/
        // 折扣模型走 gateway API, 显示为 API cost。远端 Codex 由远端 daemon
        // 路由,本机不知道远端 OAuth/API 事实,因此保留 unknown 来源和 token,
        // 不估值、不写本地 gateway cost。只有真实本地 API cost 写入 sessions.total_cost_usd,
        // 避免 scheduler 的 Cost 汇总混入订阅价值或远端账号消耗。
        // fire-and-forget 不阻塞事件循环;价格表走 main 端内存 + 磁盘缓存,
        // stale 快返并后台刷新,
        // 拉不到 / 模型无条目 → 只落 token 明细,UI 退回显示本轮 token。
        // 明细在 try 外构造:它只依赖上面已拿到的 token 数,价格请求抛错时也要能落。
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
          const perModelCost = [];
          for (const row of tokenRows) {
            // Gateway SKUs carry the sale-price identity even when the response
            // reports a bare upstream model. Ledger attribution follows the row.
            const rowModel = normalizeModelIdForPricing(row.model);
            const quoteModel = isCodexBudgetRoute ? pricingModel : rowModel;
            const price = isSubscriptionValue && isCodexXaiProviderRoute
              ? getSubscriptionDirectValuePrice(quoteModel, 'codex', pricing)
              : isSubscriptionValue
                ? getCodexProviderSubscriptionValuePrice(subscriptionValueProviderId, quoteModel, pricing)
                : hasEffectiveGatewayRoute
                  ? getModelPriceQuote(pricing, 'xd', quoteModel)
                  : usesReferencePriceEstimate
                    ? getModelPriceQuote(pricing, sessionProvider, quoteModel, 'codex')
                    : undefined;
            const segments = codexSegmentsReliable
              ? execution
                ? codexUsageSegments.filter(segment => (segment.model ?? turnModel) === row.model)
                : codexUsageSegments
              : [];
            const money = computePriceQuoteTurnMoney(row, price, segments);
            if (!money) continue;
            // Only gateway sale prices are actual API spend. Reference quotes
            // remain message-only estimates so history cannot reclassify them.
            if (isSubscriptionValue || price?.source === 'gateway') {
              await recordModelTurnUsage({
                sessionId: session.id,
                agentKind: 'codex',
                model: isSubscriptionValue ? codexSubscriptionUsageModelKey(rowModel)
                  : codexApiUsageModelKey(rowModel),
                recordedAt,
                money,
                inputTokensDelta: 0,
                outputTokensDelta: 0,
                cacheReadTokensDelta: 0,
                cacheCreateTokensDelta: 0,
              });
            }
            perModelCost.push({ ...billing, model: row.model, money });
          }
          const values = perModelCost.map(row => row.money);
          const actualAmounts = isSubscriptionValue ? [] : sumMoneyByCurrency(values.filter(m => m.kind === 'actual-cost'));
          const estimatedAmounts = sumMoneyByCurrency(values.filter(value => value.kind === 'value-estimate'));
          const money = actualAmounts[0] ?? estimatedAmounts[0];
          if (money && money.amount > 0) {
            if (turnUsageDetails) turnUsageDetails.perModelCost = perModelCost;
            for (const amount of actualAmounts) {
              void recordTurnSpend(amount);
              void recordSessionTurnSpend(session.id, amount);
            }
            const changedScheduleId = await recordSchedulerTurnCost({
              sessionId: session.id,
              clientId: turnAssistantPersistId,
              money,
              estimatedAmounts,
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
    // 走 Cindy AI gateway/API 口径的 codex turn，done 后通过 Model Access 刷新账号配额
    // (与 cc 同口径, chip 显示 daily/monthly/key cost)。命中:会话显式选了 XD 网关、无 OAuth
    // token 的 env-key fallback、或 codex/ 预算模型。普通 oauth 订阅没有 $ 配额,不刷。
    void modelPromise
      .then((model) => {
        if (isRemoteCodexSession) return;
        const hasGatewayKey = Boolean(readClaudeApiKey());
        if (isClaudeSubscriptionProviderId(sessionProvider)) {
          triggerClaudeSubscriptionUsageRefresh(sessionProvider ?? undefined);
          return;
        }
        if (isExclusiveXaiModelId(model)) {
          triggerXaiSubscriptionUsageRefresh(sessionProvider ?? undefined);
          return;
        }
        if (
          !isCustomProviderRoute &&
          !isExclusiveXaiModelId(model) &&
          (codexAuthInjection === 'env-key' ||
            isCodexGatewayWireModel(model) ||
            (sessionProvider === 'xd' && hasGatewayKey))
        ) {
          void triggerClaudeAccountUsageRefresh();
        }
      })
      .catch(() => {
        if (!isRemoteCodexSession && sessionProvider === 'xd' && readClaudeApiKey()) {
          void triggerClaudeAccountUsageRefresh();
        }
      });
  }
}
