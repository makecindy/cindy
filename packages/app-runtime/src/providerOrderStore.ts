import {
  mergeObservedProviderOrder,
  normalizeProviderOrder,
} from '@cindy/model-providers/providerOrder';
import { createOverrideSettingsFile } from './overrideSettingsFile.js';

export function createProviderOrderStore(filePath: () => string, log: {info(message:string, fields?:Record<string,unknown>):void;warn(message:string, fields?:Record<string,unknown>):void}) {
const CINDY_AI_PROVIDER_ID = 'xd';

interface ProviderOrderPrefs {
  providerOrder: string[];
}

const DEFAULTS: ProviderOrderPrefs = { providerOrder: [] };

function normalize(raw: unknown): ProviderOrderPrefs {
  if (!raw || typeof raw !== 'object') return { providerOrder: [] };
  return {
    providerOrder: normalizeProviderOrder((raw as { providerOrder?: unknown }).providerOrder),
  };
}

const store = createOverrideSettingsFile<ProviderOrderPrefs>({
  filePath,
  defaults: DEFAULTS,
  normalize,
  log,
  label: 'provider-order',
});

function readProviderOrder(): string[] {
  store.invalidateIfChanged();
  const order = [...store.read().providerOrder];
  return order.includes(CINDY_AI_PROVIDER_ID) ? order : [CINDY_AI_PROVIDER_ID, ...order];
}

function setProviderOrder(visibleProviderIds: readonly string[]): boolean {
  store.invalidateIfChanged();
  const current = readProviderOrder();
  const next = mergeObservedProviderOrder(current, normalizeProviderOrder(visibleProviderIds));
  if (next.length === current.length && next.every((id, index) => id === current[index])) {
    return false;
  }
  store.writePatch({ providerOrder: next });
  log.info('provider display order written', { count: next.length });
  return true;
}

const __testing = { normalize, reset: () => store.reset() };

return {readProviderOrder,setProviderOrder,__testing};
}
