// The XD gateway price projection lives in modelPricingCore.ts (shared with the Node Host). This
// module builds the single Desktop instance; its ports resolve Electron, the client endpoint, the
// owner-scoped key name and the account currency store when called, never when this module loads.
import { app, BrowserWindow } from 'electron';

import { getClientEndpoint } from '../clientEndpointsService.js';
import { resolveOwnerScopedSecretStorageKey } from '../secrets/providerSecretStore.js';
import {
  hydrateAccountCurrency,
  noteActiveAccount,
  rememberAccountCurrency,
} from './accountCurrencyStore.js';
import { createModelPricing } from './modelPricingCore.js';

export { getModelPriceQuote, MODEL_PRICING_CHANGED_CHANNEL } from './modelPricingCore.js';
export type { ModelPrice, ModelPricingMap } from './modelPricingCore.js';

const desktopModelPricing = createModelPricing({
  app: { getPath: (name) => app.getPath(name) },
  BrowserWindow: { getAllWindows: () => BrowserWindow.getAllWindows() },
  getClientEndpoint: (key) => getClientEndpoint(key),
  resolveOwnerScopedSecretStorageKey: (storageKey) => resolveOwnerScopedSecretStorageKey(storageKey),
  hydrateAccountCurrency: (...args) => hydrateAccountCurrency(...args),
  noteActiveAccount: (...args) => noteActiveAccount(...args),
  rememberAccountCurrency: (...args) => rememberAccountCurrency(...args),
});
type Instance = typeof desktopModelPricing;

/**
 * 与模型同步同快照更新 XD quote。models 非空但没有标准 input/output 价格时，
 * 价格投影会被清空，不复活旧模型价格。
 */
export function replaceGatewayModelPricing(...args: Parameters<Instance['replaceGatewayModelPricing']>): ReturnType<Instance['replaceGatewayModelPricing']> {
  return desktopModelPricing.replaceGatewayModelPricing(...args);
}

export function clearGatewayModelPricing(): void {
  desktopModelPricing.clearGatewayModelPricing();
}

export function trackGatewayModelPricingSync(...args: Parameters<Instance['trackGatewayModelPricingSync']>): void {
  desktopModelPricing.trackGatewayModelPricingSync(...args);
}

export function isModelPricingRefreshInFlight(): boolean {
  return desktopModelPricing.isModelPricingRefreshInFlight();
}

export function getGatewayModelPricing(): ReturnType<Instance['getGatewayModelPricing']> {
  return desktopModelPricing.getGatewayModelPricing();
}

/**
 * Model Access 账号用量与模型目录属于同一个 Gateway 租户，因而共用目录声明的
 * 原生币种。混合币种或尚无当前账号目录时返回 null，调用方不再根据组织名称猜测。
 */
export function getGatewayAccountCurrency(...args: Parameters<Instance['getGatewayAccountCurrency']>): ReturnType<Instance['getGatewayAccountCurrency']> {
  return desktopModelPricing.getGatewayAccountCurrency(...args);
}

/** Header amounts have no currency: reuse only this account's confirmed ledger currency. */
export function getGatewayMediaBillingCurrency(): ReturnType<Instance['getGatewayMediaBillingCurrency']> {
  return desktopModelPricing.getGatewayMediaBillingCurrency();
}

/** 计费热路径只等待 `/models` 写入 XD 报价，不读取 Catalog。 */
export function getGatewayModelPricingForModel(): ReturnType<Instance['getGatewayModelPricingForModel']> {
  return desktopModelPricing.getGatewayModelPricingForModel();
}

/** 启动只读磁盘快照；真正的新价格仍由 /models 同步整体替换。 */
export function prewarmModelPricing(): Promise<void> {
  return desktopModelPricing.prewarmModelPricing();
}

export function __resetModelPricingCacheForTesting(): void {
  desktopModelPricing.__resetModelPricingCacheForTesting();
}
