import type { CindyRegion } from '@cindy/maker-shared/brand-identity';
import type { createRegionalMoney, MoneyCurrency, ModelPricingCatalog, ModelPriceQuote, RegionalMoney } from '@cindy/maker-shared/regional-money';
import type { createTurnUsageDetails } from '@cindy/maker-shared/turn-usage-details';
import type { AgentKind } from '@cindy/model-providers';
import type { ModelMismatchInfo } from '@cindy/model-providers/modelMismatch';
import type { getModelPriceQuote } from '@cindy/model-providers/modelPriceQuote';
import type { createTurnCostCalculator } from './turnCostCalculator.js';
import type { createTurnCostBroadcaster } from './turnCostBroadcaster.js';
import type { createSessionSpendBroadcaster } from './sessionSpendBroadcaster.js';
import type { createTurnUsageContext, TurnUsageContextHost } from './turnUsageContext.js';
import type { DailyModelUsageDelta } from './dailyModelUsage.js';

/** Original pricing and persistence services; credentials remain owned by the platform host. */
export interface SessionTurnUsageHost extends
  Pick<ReturnType<typeof createRegionalMoney>, 'addRegionalMoney' | 'usdToLedgerCurrency'>,
  Pick<ReturnType<typeof createTurnUsageDetails>, 'buildTurnUsageDetails'>,
  ReturnType<typeof createTurnCostCalculator>,
  Pick<ReturnType<typeof createTurnCostBroadcaster>, 'codexUsageToTokens' | 'piUsageToTokens' | 'recordSchedulerTurnCost' | 'recordTurnUsageOnMessage'>,
  Pick<ReturnType<typeof createSessionSpendBroadcaster>, 'recordSessionTurnSpend' | 'recordSessionTurnTokens'>,
  Pick<TurnUsageContextHost, 'getSessionProvider' | 'isOpenAiSubscriptionProviderId' | 'isClaudeSubscriptionProviderId' | 'isXaiSubscriptionProviderId'> {
  readonly CURRENT_CINDY_REGION: CindyRegion;
  captureTurnUsageContext: ReturnType<typeof createTurnUsageContext>['captureTurnUsageContext'];
  currentLedgerCurrency(): MoneyCurrency;
  readClaudeApiKey(): string | null;
  getCodexProxyAuthInjection(): 'oauth-bearer' | 'env-key' | 'provider-oauth';
  readClaudeSessionRoute(sessionId: string): 'gateway' | 'subscription' | null;
  getGatewayAccountCurrency(): Promise<MoneyCurrency | null>;
  getGatewayModelPricingForModel(): Promise<ModelPricingCatalog | null>;
  getModelPriceQuote: typeof getModelPriceQuote;
  getReferenceModelPricing(): ModelPricingCatalog;
  getCodexProviderSubscriptionValuePrice(providerId: string, modelId: string,
    pricing: ModelPricingCatalog | null | undefined, at?: string | Date,
    overrides?: undefined, agent?: AgentKind): ModelPriceQuote | undefined;
  getSubscriptionDirectValuePrice(modelId: string, agent?: AgentKind,
    pricing?: ModelPricingCatalog | null): ModelPriceQuote | undefined;
  getSubscriptionValuePriceFor(agentKind: AgentKind | 'media', model: string,
    pricing: ModelPricingCatalog | null): ModelPriceQuote | undefined;
  codexApiUsageModelKey(model: string): string;
  codexSubscriptionUsageModelKey(model: string): string;
  claudeSubscriptionUsageModelKey(model: string): string;
  piSubscriptionUsageModelKey(model: string): string;
  recordTurnSpend(money: RegionalMoney, ts?: number): Promise<void>;
  recordModelTurnUsage(delta: DailyModelUsageDelta & { sessionId?: string }, ts?: number): Promise<void>;
  recordCodexTurnUsage(usage: unknown): void;
  recordModelMismatchOnMessage(args: {sessionId: string; clientId: string; mismatch: ModelMismatchInfo}): Promise<void>;
  rebroadcastTodaySpend(): Promise<void>;
  rebroadcastCodexTodayUsage(): void;
  triggerClaudeAccountUsageRefresh(): Promise<unknown>;
  triggerClaudeSubscriptionUsageRefresh(providerId?: string): void;
  triggerCodexAccountUsageRefresh(providerId?: string): void;
  triggerXaiSubscriptionUsageRefresh(providerId?: string): void;
  broadcastSchedulerChanged(scheduleId: string): void;
}
