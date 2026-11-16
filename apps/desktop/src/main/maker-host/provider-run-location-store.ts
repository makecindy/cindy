/**
 * 供应商「运行于」：同账号另一台电脑也提供这个供应商时，本机新任务在哪台电脑运行。
 *
 * 每台电脑、每个 Cindy 账号各自保存一份，只记用户改选过的供应商（覆盖值）：值是那台电脑的 deviceId，
 * 或 'local' 表示固定在本机。没有记录时按默认：本机能用就在本机，用不了时用一台在线、已开放的电脑。
 */
import { ownerScopedPath as ownerScopedUserDataPath } from '../ownerContext.js';
import { createOverrideSettingsFile } from './override-settings-file.js';
import { desktopMakerLogger } from './logger-adapter.js';

interface ProviderRunLocationPrefs {
  locations: Record<string, string>;
}

const DEFAULTS: ProviderRunLocationPrefs = { locations: {} };
const MAX_ENTRIES = 1024;
const MAX_ID_LENGTH = 256;
const log = desktopMakerLogger.child('provider-run-location-store');

function normalize(raw: unknown): ProviderRunLocationPrefs {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as { locations?: unknown }).locations
    : undefined;
  const locations: Record<string, string> = {};
  if (source && typeof source === 'object' && !Array.isArray(source)) {
    for (const [providerId, location] of Object.entries(source as Record<string, unknown>)) {
      if (Object.keys(locations).length >= MAX_ENTRIES) break;
      if (!providerId || providerId.length > MAX_ID_LENGTH) continue;
      if (typeof location !== 'string' || !location || location.length > MAX_ID_LENGTH) continue;
      locations[providerId] = location;
    }
  }
  return { locations };
}

const store = createOverrideSettingsFile<ProviderRunLocationPrefs>({
  filePath: () => ownerScopedUserDataPath('provider-run-location-prefs.json'),
  defaults: DEFAULTS,
  normalize,
  log,
  label: 'provider-run-location',
  maxBytes: 128 * 1024,
});

export function readProviderRunLocation(providerId: string): string | undefined {
  store.invalidateIfChanged();
  return store.read().locations[providerId];
}

/** `null` 回到默认(删除覆盖)。 */
export function setProviderRunLocation(providerId: string, location: string | null): void {
  if (!providerId || providerId.length > MAX_ID_LENGTH) throw new Error('invalid providerId');
  if (location !== null && (!location || location.length > MAX_ID_LENGTH)) throw new Error('invalid location');
  store.invalidateIfChanged();
  const locations = { ...store.read().locations };
  if (location === null) {
    if (!(providerId in locations)) return;
    delete locations[providerId];
  } else {
    if (locations[providerId] === location) return;
    if (!(providerId in locations) && Object.keys(locations).length >= MAX_ENTRIES) {
      throw new Error('provider run location limit reached');
    }
    locations[providerId] = location;
  }
  store.writePatch({ locations });
  log.info('provider run location updated', { providerId, location: location === null ? 'default' : location === 'local' ? 'local' : 'device' });
}
