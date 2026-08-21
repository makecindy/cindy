/**
 * customProviderBillingSettingsStore — renderer mirror for custom provider billing settings.
 *
 * Source of truth is main's <userData>/custom-provider-billing-settings.json.
 * localStorage is only a synchronous renderer mirror.
 */

const STORAGE_KEY = 'customProviderBilling.showSdkCostForCustomProviders';

type Subscriber = (value: boolean) => void;
const subscribers = new Set<Subscriber>();

export function getCustomProviderShowSdkCost(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

export function setCustomProviderShowSdkCost(next: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, next ? 'true' : 'false');
  } catch {
    // ignore
  }
  subscribers.forEach((cb) => cb(next));
}

export function subscribeCustomProviderShowSdkCost(cb: Subscriber): () => void {
  subscribers.add(cb);
  const storageHandler = (e: StorageEvent) => {
    if (e.key !== STORAGE_KEY) return;
    cb(getCustomProviderShowSdkCost());
  };
  window.addEventListener('storage', storageHandler);
  return () => {
    subscribers.delete(cb);
    window.removeEventListener('storage', storageHandler);
  };
}

export async function bootstrapCustomProviderBillingFromMain(): Promise<void> {
  try {
    const settings = await window.electronAPI.maker.customProviderBillingGet();
    if (getCustomProviderShowSdkCost() === settings.showSdkCostForCustomProviders) return;
    setCustomProviderShowSdkCost(settings.showSdkCostForCustomProviders);
  } catch {
    // keep local fallback
  }
}
