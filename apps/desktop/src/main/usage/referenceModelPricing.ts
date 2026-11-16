// The reference price projection lives in referenceModelPricingCore.ts (shared with the Node Host).
// This module keeps the Desktop window broadcast and re-exports the rest unchanged.
import { BrowserWindow } from 'electron';
import { notifyUsagePricingChanged } from './pricingChanges.js';

import { getReferenceModelPricing, REFERENCE_MODEL_PRICING_CHANGED_CHANNEL } from './referenceModelPricingCore.js';

export * from './referenceModelPricingCore.js';

export function broadcastReferenceModelPricing(): void {
  notifyUsagePricingChanged();
  const pricing = getReferenceModelPricing();
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(REFERENCE_MODEL_PRICING_CHANGED_CHANNEL, pricing);
    }
  }
}
