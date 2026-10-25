/**
 * modelPricing — Cindy AI Gateway 的 XD 实际报价投影。
 *
 * XD 模型与价格只来自 model-access-server 的同一次 GET /models 响应。这里不再
 * 直接请求 LiteLLM；模型同步成功时整体替换 XD quote，失败时保留上一份成功快照。
 * Gateway per-token 数值在这里转换为 per-Mtok；新版服务端下发的原生币种优先，
 * 旧版服务端缺失时才回退构建区域。
 */

import { promises as fs, statSync } from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow } from 'electron';

import { CURRENT_CINDY_REGION } from '../../shared/brandRegion.js';
import { gatewayLedgerCurrency, gatewayPricingCatalog } from '../../shared/modelPriceQuote.js';
import type { ModelAccessGatewayModel } from '../../shared/modelAccess.js';
import { providerSecretStorageKey } from '../../shared/providerSecrets.js';
import {
  type ModelPriceQuote,
  type ModelPricingCatalog,
  type MoneyCurrency,
} from '../../shared/regionalMoney.js';
import { getCurrentDbClientUserId } from '../localDb/client/current.js';
import {
  hydrateAccountCurrency,
  noteActiveAccount,
  rememberAccountCurrency,
} from './accountCurrencyStore.js';
import { currentLedgerCurrency, isLedgerCurrencyKnown, setActiveLedgerCurrency } from './ledgerCurrency.js';
import { createLogger } from '../logger.js';
import { getClientEndpoint } from '../clientEndpointsService.js';
import { resolveOwnerScopedSecretStorageKey } from '../secrets/providerSecretStore.js';
import {createGatewayModelPricing} from "@cindy/app-runtime/modelPricing";


export { getModelPriceQuote } from '../../shared/modelPriceQuote.js';
export type {
  ModelPriceQuote as ModelPrice,
  ModelPricingCatalog as ModelPricingMap,
} from '../../shared/regionalMoney.js';
function currentKeyCacheIdentity(): string {
  try {
    const physicalKey = resolveOwnerScopedSecretStorageKey(providerSecretStorageKey('xd'));
    if (!physicalKey) return 'key=missing';
    const file = path.join(app.getPath('userData'), 'safe-storage', `${physicalKey}.enc`);
    const stat = statSync(file, { bigint: true });
    return `key=${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
  } catch {
    return 'key=missing';
  }
}
export const {MODEL_PRICING_CHANGED_CHANNEL,replaceGatewayModelPricing,clearGatewayModelPricing,trackGatewayModelPricingSync,isModelPricingRefreshInFlight,getGatewayModelPricing,getGatewayAccountCurrency,getGatewayMediaBillingCurrency,getGatewayModelPricingForModel,prewarmModelPricing,__resetModelPricingCacheForTesting}=createGatewayModelPricing({
get CURRENT_CINDY_REGION(){return CURRENT_CINDY_REGION;},
userDataDirectory:()=>app.getPath("userData"),
currentKeyCacheIdentity,
getCurrentDbClientUserId:()=>getCurrentDbClientUserId(),
createLogger,
getClientEndpoint,
hydrateAccountCurrency:(...args)=>hydrateAccountCurrency(...args),
noteActiveAccount:(...args)=>noteActiveAccount(...args),
rememberAccountCurrency:(...args)=>rememberAccountCurrency(...args),
currentLedgerCurrency:()=>currentLedgerCurrency(),
isLedgerCurrencyKnown:()=>isLedgerCurrencyKnown(),
setActiveLedgerCurrency:(...args)=>setActiveLedgerCurrency(...args),
broadcast(channel,payload){for(const win of BrowserWindow.getAllWindows())if(!win.isDestroyed())win.webContents.send(channel,payload);}
});
