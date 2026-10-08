/**
 * 远程 Agent 的供应商级授权。
 *
 * 每台电脑、每个 Cindy 账号各自保存一份；缺席表示未授权（默认关闭）。
 * 这份设置只决定同账号另一台电脑能否使用本机该供应商的登录与额度，
 * 不改变本机选择器里的模型可见性，也不把凭证或路由细节写进 device-link。
 */
import { ownerScopedUserDataPath } from '../appSessionState.js';
import { createOverrideSettingsFile } from './override-settings-file.js';
import { desktopMakerLogger } from './logger-adapter.js';

interface RemoteProviderAccessPrefs {
  allowedProviders: Record<string, true>;
}

const DEFAULTS: RemoteProviderAccessPrefs = { allowedProviders: {} };
const MAX_ENTRIES = 4096;
const log = desktopMakerLogger.child('remote-provider-access-store');

function normalize(raw: unknown): RemoteProviderAccessPrefs {
  const source =
    raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as { allowedProviders?: unknown }).allowedProviders
      : undefined;
  const allowedProviders: Record<string, true> = {};
  if (source && typeof source === 'object' && !Array.isArray(source)) {
    for (const [providerId, enabled] of Object.entries(source as Record<string, unknown>)) {
      if (enabled !== true || !providerId) continue;
      if (Object.keys(allowedProviders).length >= MAX_ENTRIES) break;
      allowedProviders[providerId] = true;
    }
  }
  return { allowedProviders };
}

const store = createOverrideSettingsFile<RemoteProviderAccessPrefs>({
  filePath: () => ownerScopedUserDataPath('remote-provider-access-prefs.json'),
  defaults: DEFAULTS,
  normalize,
  log,
  label: 'remote-provider-access',
  maxBytes: 256 * 1024,
});

export function isRemoteProviderInvocationAllowed(providerId: string): boolean {
  store.invalidateIfChanged();
  return store.read().allowedProviders[providerId] === true;
}

export function setRemoteProviderInvocationEnabled(providerId: string, enabled: boolean): void {
  if (!providerId) return;
  store.invalidateIfChanged();
  const allowedProviders = { ...store.read().allowedProviders };
  if (enabled) {
    if (allowedProviders[providerId] === true) return;
    if (Object.keys(allowedProviders).length >= MAX_ENTRIES) {
      throw new Error('remote provider access limit reached');
    }
    allowedProviders[providerId] = true;
  } else {
    if (!(providerId in allowedProviders)) return;
    delete allowedProviders[providerId];
  }
  store.writePatch({ allowedProviders });
  log.info('remote provider access updated', { providerId, enabled });
}

export const __testing = { normalize };
