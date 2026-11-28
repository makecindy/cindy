import { applyPermissionChange } from '../analyticsSettingsService.js';
import { getMakerIfReady } from '../maker-host/index.js';
import { additionalSettingsRuntime, additionalModelRuntime } from './additionalRuntime.js';
import type { AdditionalSettingsDomain } from '../../shared/settingsEditableCatalog.js';

/** Apply through the same runtime services as native settings, preserving busy turns. */
export async function applyAdditionalSettings(domain: AdditionalSettingsDomain): Promise<void> {
  if (domain === 'modelContext' || domain === 'modelAccess' || domain === 'providerNames' || domain === 'modelPrices') {
    const runtime = additionalModelRuntime();
    if (!runtime && getMakerIfReady()) throw new Error('NOT_READY');
    if (domain === 'modelContext') await runtime?.refreshContext();
    else if (domain === 'modelPrices') runtime?.pricingChanged();
    else runtime?.accessChanged();
    return;
  }
  if (['computerTools', 'androidTools', 'browserTools'].includes(domain)) {
    const runtime = additionalModelRuntime();
    if (!runtime && getMakerIfReady()) throw new Error('NOT_READY');
    await runtime?.refreshTools(); return;
  }
  if (domain === 'chatEmbedding') {
    const runtime = additionalSettingsRuntime()?.chatEmbedding;
    if (!runtime) throw new Error('NOT_READY');
    await runtime.reconcile(); return;
  }
  if (domain === 'privacy') {
    applyPermissionChange();
    return;
  }
}
