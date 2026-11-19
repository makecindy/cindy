// The reference price projection lives in referenceModelPricingCore.ts (shared with the Node Host).
// This module keeps the Desktop display provider projection and window broadcast.
import type { Catalog } from '@cindy/model-providers';
import { BrowserWindow } from 'electron';
import type { ModelPricingCatalog } from '../../shared/regionalMoney.js';
import { createLogger } from '../logger.js';
import { notifyUsagePricingChanged } from './pricingChanges.js';

import { getReferenceModelPricing, REFERENCE_MODEL_PRICING_CHANGED_CHANNEL } from './referenceModelPricingCore.js';

export * from './referenceModelPricingCore.js';

const log = createLogger('referenceModelPricing');

let displayProviders: (() => Catalog['providers']) | null = null;

/**
 * The catalog the model picker and settings list render from. An account provider's own
 * discovered models are projected onto it after the active catalog, so quoting only the
 * active catalog leaves exactly those models without a price.
 */
export function setReferencePricingDisplayProviders(source: (() => Catalog['providers']) | null): void {
  displayProviders = source;
}

/** Current reference prices for every model the renderer can list. */
export function getDisplayReferenceModelPricing(): ModelPricingCatalog {
  return getReferenceModelPricing({ providers: displayProviders?.() });
}

let lastBroadcastTable: string | null = null;
let followUpScheduled = false;

function publishReferenceModelPricing(pricing: ModelPricingCatalog, table: string): void {
  lastBroadcastTable = table;
  notifyUsagePricingChanged();
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try {
      win.webContents.send(REFERENCE_MODEL_PRICING_CHANGED_CHANNEL, pricing);
    } catch {
      // Window teardown may race the broadcast; other windows still receive it.
    }
  }
}

export function broadcastReferenceModelPricing(): void {
  const pricing = getDisplayReferenceModelPricing();
  publishReferenceModelPricing(pricing, JSON.stringify(pricing));
}

/**
 * 供应商清单变化后跟进一次参考价。
 *
 * OAuth 账号供应商的报价按「当时这个账号名下的型号」逐个生成；账号发现在目录加载之后才
 * 补入新型号，那一刻没有人再广播，界面上这些型号就一直没有价格（独立订阅账号页上新型号
 * 缺价格档）。同一轮事件循环内的多次变化只重算一次；报价表没变就不广播，也不通知用量重算。
 */
export function followReferenceModelPricingAfterProviderChange(): void {
  if (followUpScheduled) return;
  followUpScheduled = true;
  setImmediate(() => {
    followUpScheduled = false;
    // Nothing awaits this callback: an escaping error would be an uncaughtException, which
    // shuts the app down. A missed price update is retried by the next provider change.
    try {
      const pricing = getDisplayReferenceModelPricing();
      const table = JSON.stringify(pricing);
      if (table === lastBroadcastTable) return;
      publishReferenceModelPricing(pricing, table);
    } catch (error) {
      log.warn('reference price follow-up failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
}
