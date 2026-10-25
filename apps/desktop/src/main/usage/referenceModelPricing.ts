/**
 * 非 XD 渠道的参考报价投影。
 *
 * 数据只来自公共 Model Registry 与用户覆盖，用于 BYOK / 订阅价值估算。Cindy AI
 * Gateway 的模型与售价由 modelPricing.ts 独占维护，本模块显式拒绝 XD 数据。
 */

import { BrowserWindow } from 'electron';
import type { AgentKind } from '@cindy/model-providers';

import {
  getModelPriceQuote,
  modelPricingKey,
  registryPricingCatalog,
  subscriptionDirectPriceQuote,
} from '../../shared/modelPriceQuote.js';
import type { ModelPriceQuote, ModelPricingCatalog } from '../../shared/regionalMoney.js';
import { getByokPricing } from '../model-access/byokPricing.js';
import { getActiveCatalog } from '../maker-host/active-catalog.js';
import { accountReferencePriceQuote as providerReferencePriceQuote } from './accountReferencePrice.js';
import {
  applyModelPriceOverrides,
  mergeStoredModelPriceOverride,
  type ModelPriceOverridesSnapshot,
} from './modelPriceOverrideStore.js';
import {createReferenceModelPricing} from "@cindy/app-runtime/referenceModelPricing";


export type { ModelPriceOverridesSnapshot } from './modelPriceOverrideStore.js';
export { readModelPriceOverridesSnapshot } from './modelPriceOverrideStore.js';

export const {REFERENCE_MODEL_PRICING_CHANGED_CHANNEL,getReferenceModelPricing,broadcastReferenceModelPricing,getCodexProviderSubscriptionValuePrice,getCodexSubscriptionValuePrice,getClaudeSubscriptionValuePrice,getSubscriptionDirectValuePrice}=createReferenceModelPricing({
getActiveCatalog:()=>getActiveCatalog(),
getByokPricing:()=>getByokPricing(),
providerReferencePriceQuote:(...args)=>providerReferencePriceQuote(...args),
applyModelPriceOverrides:(...args)=>applyModelPriceOverrides(...args),
mergeStoredModelPriceOverride:(...args)=>mergeStoredModelPriceOverride(...args),
broadcast(channel,payload){for(const win of BrowserWindow.getAllWindows())if(!win.isDestroyed())win.webContents.send(channel,payload);}
});
