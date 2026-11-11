/** Learned Pi cache compatibility, scoped to connection + wire model + route digest.
 * Internal override, not a user preference. Delete an entry to re-evaluate support.
 * Unreadable files are preserved; a failed write never authorizes replay.
 */
import { app } from 'electron';
import { statSync } from 'node:fs';
import path from 'node:path';
import { desktopMakerLogger } from './logger-adapter.js';
import { createOverrideSettingsFile } from './override-settings-file.js';

type CacheOverride = { supportsLongCacheRetention: false; learnedAt?: number; expiresAt?: number; evidence?: 'explicit' | 'opaque' };
interface PiNativeCompatOverrides { routes: Record<string, CacheOverride> }
const log = desktopMakerLogger.child('pi-native-compat-overrides-store');
const DEFAULTS: PiNativeCompatOverrides = { routes: {} };
const filePath = () => path.join(app.getPath('userData'), 'pi-native-compat-overrides.json');
function identity(providerId: string, modelId: string, routeKey?: string): string | undefined {
  if (!routeKey || !/^[a-f0-9]{64}$/.test(routeKey)) return undefined;
  if (![providerId, modelId].every((v) => typeof v === 'string' && v.length > 0 && v.length <= 512 && !/[\u0000-\u001f\u007f]/.test(v))) return undefined;
  return JSON.stringify([providerId, modelId, routeKey]);
}
function normalize(raw: unknown): PiNativeCompatOverrides {
  const routes: Record<string, CacheOverride> = Object.create(null);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { routes };
  const source = (raw as { routes?: unknown }).routes;
  if (!source || typeof source !== 'object' || Array.isArray(source)) return { routes };
  for (const [key, value] of Object.entries(source)) {
    try {
      const parts: unknown = JSON.parse(key);
      if (!Array.isArray(parts) || parts.length !== 3 || !parts.every((v) => typeof v === 'string')
        || identity(parts[0], parts[1], parts[2]) !== key) continue;
      if (value && typeof value === 'object' && (value as CacheOverride).supportsLongCacheRetention === false) {
        const record = value as CacheOverride;
        const timed = Number.isFinite(record.learnedAt) && Number.isFinite(record.expiresAt)
          && record.expiresAt! > record.learnedAt!
          && record.expiresAt! <= record.learnedAt! + (record.evidence === 'opaque' ? 1 : 7) * 86400000
          && (record.evidence === 'explicit' || record.evidence === 'opaque');
        if (!timed && (record.learnedAt !== undefined || record.expiresAt !== undefined || record.evidence !== undefined)) continue;
        if (timed) {
          routes[key] = { supportsLongCacheRetention: false, learnedAt: record.learnedAt,
            expiresAt: record.expiresAt, evidence: record.evidence };
        } else {
          // Match the native bridge's stable grace for untimed legacy learning.
          // Preserve that deadline when an unrelated route is later written.
          const learnedAt = statSync(filePath()).mtimeMs;
          routes[key] = { supportsLongCacheRetention: false, learnedAt,
            expiresAt: learnedAt + 7 * 86400000, evidence: 'explicit' };
        }
      }
    } catch { /* Invalid identities are not executable configuration. */ }
  }
  return { routes };
}
const store = createOverrideSettingsFile<PiNativeCompatOverrides>({
  filePath,
  defaults: DEFAULTS, normalize, log, label: 'pi native compat overrides',
  maxBytes: 256 * 1024, preserveUnreadableFile: true,
  logLoadedValue: false, logReadErrorDetails: false,
});
export function readPiNativeCompatOverride(providerId: string, modelId: string, routeKey?: string): CacheOverride | undefined {
  const key = identity(providerId, modelId, routeKey);
  if (!key) return undefined;
  store.invalidateIfChanged();
  const record = store.read().routes[key];
  return record && record.expiresAt! > Date.now() && record.learnedAt! <= Date.now()
    ? { supportsLongCacheRetention: false } : undefined;
}
export async function recordPiNativeCompatOverride(providerId: string, modelId: string,
  compat: Record<string, unknown>, routeKey?: string): Promise<boolean> {
  const key = identity(providerId, modelId, routeKey);
  if (!key || compat.supportsLongCacheRetention !== false) return false;
  try {
    const learnedAt = Date.now();
    await store.updateAtomic((current) => ({ routes: {
      ...current.value.routes, [key]: { supportsLongCacheRetention: false, learnedAt,
        expiresAt: learnedAt + 7 * 86400000, evidence: 'explicit' },
    } }));
    return readPiNativeCompatOverride(providerId, modelId, routeKey)?.supportsLongCacheRetention === false;
  } catch {
    log.warn('pi cache compatibility could not be persisted');
    return false;
  }
}
