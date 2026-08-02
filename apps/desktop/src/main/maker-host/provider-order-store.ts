/**
 * provider-order-store — owner-scoped provider display-order override.
 *
 * File: the active owner's namespace via ownerScopedUserDataPath('provider-order-prefs.json').
 * The persisted list is the order in which providers have appeared in Settings,
 * subsequently adjusted by explicit drag operations. Cindy AI seeds an empty list;
 * every other newly visible provider appends at the end.
 */

import {
  mergeObservedProviderOrder,
  normalizeProviderOrder,
} from '../../shared/providerOrder.js';
import { ownerScopedUserDataPath } from '../appSessionState.js';
import { desktopMakerLogger } from './logger-adapter.js';
import { createOverrideSettingsFile } from './override-settings-file.js';

const log = desktopMakerLogger.child('provider-order-store');
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
  filePath: () => ownerScopedUserDataPath('provider-order-prefs.json'),
  defaults: DEFAULTS,
  normalize,
  log,
  label: 'provider-order',
});

export function readProviderOrder(): string[] {
  store.invalidateIfChanged();
  const order = [...store.read().providerOrder];
  return order.includes(CINDY_AI_PROVIDER_ID) ? order : [CINDY_AI_PROVIDER_ID, ...order];
}

export function setProviderOrder(visibleProviderIds: readonly string[]): boolean {
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

export const __testing = { normalize, reset: () => store.reset() };
