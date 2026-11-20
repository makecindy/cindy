/**
 * The functions the turn usage recorders' cores (sessionClaudeTurnUsageCore.ts,
 * sessionCodexTurnUsageCore.ts, sessionPiTurnUsageCore.ts, turnUsageContextCore.ts,
 * piUsageReceiptsCore.ts) take from the process they run in. Electron-free, so the Node Host
 * loads the same recorders and binds its own: its prices, its subscription accounts, its
 * per-task message writes, and empty quota refreshes.
 *
 * Each port has the name and the signature of the import it replaces, so the cores' code is the
 * desktop's unchanged. On the desktop each wrapper (sessionClaudeTurnUsage.ts,
 * sessionCodexTurnUsage.ts, sessionPiTurnUsage.ts, turnUsageContext.ts, piUsageReceipts.ts) binds the
 * ports its own core uses, from the imports the module had before, so its import graph is the one it
 * had. A port called before it is bound throws. The pure helpers that came through the same imports are ports too, so the desktop keeps
 * the very functions it imported (and a test that replaces a module replaces them as before).
 */
type DesktopAuthAdapters = typeof import('../maker-host/auth-adapters.js');
type DesktopCodexAccountAuth = typeof import('../maker-host/codex-account-auth.desktop.js');
type DesktopCodexProxyHost = typeof import('../maker-host/codex-proxy-host.desktop.js');
type DesktopClaudeAccountUsage = typeof import('../usage/claudeAccountUsage.js');
type DesktopUsageRefresh = typeof import('./usage.js');
type DesktopSchedule = typeof import('./schedule.js');
type DesktopModelPricing = typeof import('../usage/modelPricing.js');
type SessionSpendCore = typeof import('../sessionSpendBroadcasterCore.js');
type TurnCostCore = typeof import('../turnCostBroadcasterCore.js');
type ModelMismatchCore = typeof import('../modelMismatchBroadcasterCore.js');
type UsageBroadcasterCore = typeof import('../usageBroadcasterCore.js');

export interface TurnUsagePorts {
  isOpenAiSubscriptionProviderId: DesktopCodexAccountAuth['isOpenAiSubscriptionProviderId'];
  readClaudeApiKey: DesktopAuthAdapters['readClaudeApiKey'];
  getCodexProxyAuthInjection: DesktopCodexProxyHost['getCodexProxyAuthInjection'];
  recordSessionTurnSpend: SessionSpendCore['recordSessionTurnSpend'];
  recordSessionTurnTokens: SessionSpendCore['recordSessionTurnTokens'];
  broadcastSessionSpend: SessionSpendCore['broadcastSessionSpend'];
  broadcastSessionTokens: SessionSpendCore['broadcastSessionTokens'];
  recordSchedulerTurnCost: TurnCostCore['recordSchedulerTurnCost'];
  recordTurnUsageOnMessage: TurnCostCore['recordTurnUsageOnMessage'];
  recordModelMismatchOnMessage: ModelMismatchCore['recordModelMismatchOnMessage'];
  triggerClaudeAccountUsageRefresh: DesktopClaudeAccountUsage['triggerClaudeAccountUsageRefresh'];
  getGatewayAccountCurrency: DesktopModelPricing['getGatewayAccountCurrency'];
  getGatewayModelPricing: DesktopModelPricing['getGatewayModelPricing'];
  getGatewayModelPricingForModel: DesktopModelPricing['getGatewayModelPricingForModel'];
  triggerClaudeSubscriptionUsageRefresh: DesktopUsageRefresh['triggerClaudeSubscriptionUsageRefresh'];
  triggerCodexAccountUsageRefresh: DesktopUsageRefresh['triggerCodexAccountUsageRefresh'];
  triggerXaiSubscriptionUsageRefresh: DesktopUsageRefresh['triggerXaiSubscriptionUsageRefresh'];
  rebroadcastTodaySpend: UsageBroadcasterCore['rebroadcastTodaySpend'];
  recordModelTurnUsage: UsageBroadcasterCore['recordModelTurnUsage'];
  recordTurnSpend: UsageBroadcasterCore['recordTurnSpend'];
  rebroadcastCodexTodayUsage: UsageBroadcasterCore['rebroadcastCodexTodayUsage'];
  recordCodexTurnUsage: UsageBroadcasterCore['recordCodexTurnUsage'];
  broadcastSchedulerChanged: DesktopSchedule['broadcastSchedulerChanged'];
  codexUsageToTokens: TurnCostCore['codexUsageToTokens'];
  piUsageToTokens: TurnCostCore['piUsageToTokens'];
  getModelPriceQuote: DesktopModelPricing['getModelPriceQuote'];
}

let ports: Partial<TurnUsagePorts> = {};

/** Bind some of the ports (each desktop wrapper binds the ones its core uses). */
export function bindTurnUsagePorts(next: Partial<TurnUsagePorts>): void {
  ports = { ...ports, ...next };
}

function port<K extends keyof TurnUsagePorts>(name: K): TurnUsagePorts[K] {
  return ((...args: unknown[]) => {
    const bound = ports[name];
    if (!bound) throw new Error(`turn usage port ${name} is not bound in this process`);
    return (bound as (...portArgs: unknown[]) => unknown)(...args);
  }) as TurnUsagePorts[K];
}

export const isOpenAiSubscriptionProviderId = port('isOpenAiSubscriptionProviderId');
export const readClaudeApiKey = port('readClaudeApiKey');
export const getCodexProxyAuthInjection = port('getCodexProxyAuthInjection');
export const recordSessionTurnSpend = port('recordSessionTurnSpend');
export const recordSessionTurnTokens = port('recordSessionTurnTokens');
export const broadcastSessionSpend = port('broadcastSessionSpend');
export const broadcastSessionTokens = port('broadcastSessionTokens');
export const recordSchedulerTurnCost = port('recordSchedulerTurnCost');
export const recordTurnUsageOnMessage = port('recordTurnUsageOnMessage');
export const recordModelMismatchOnMessage = port('recordModelMismatchOnMessage');
export const triggerClaudeAccountUsageRefresh = port('triggerClaudeAccountUsageRefresh');
export const getGatewayAccountCurrency = port('getGatewayAccountCurrency');
export const getGatewayModelPricing = port('getGatewayModelPricing');
export const getGatewayModelPricingForModel = port('getGatewayModelPricingForModel');
export const triggerClaudeSubscriptionUsageRefresh = port('triggerClaudeSubscriptionUsageRefresh');
export const triggerCodexAccountUsageRefresh = port('triggerCodexAccountUsageRefresh');
export const triggerXaiSubscriptionUsageRefresh = port('triggerXaiSubscriptionUsageRefresh');
export const rebroadcastTodaySpend = port('rebroadcastTodaySpend');
export const recordModelTurnUsage = port('recordModelTurnUsage');
export const recordTurnSpend = port('recordTurnSpend');
export const rebroadcastCodexTodayUsage = port('rebroadcastCodexTodayUsage');
export const recordCodexTurnUsage = port('recordCodexTurnUsage');
export const broadcastSchedulerChanged = port('broadcastSchedulerChanged');
export const codexUsageToTokens = port('codexUsageToTokens');
export const piUsageToTokens = port('piUsageToTokens');
export const getModelPriceQuote = port('getModelPriceQuote');
