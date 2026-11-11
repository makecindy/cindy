import { isRemoteDesktopIdleMinutes } from '@cindy/device-link';
import { createHash } from 'node:crypto';
import { activeOwnerScopeKey, ownerScopedUserDataPath } from '../appSessionState';
import { createOverrideSettingsFile } from '../maker-host/override-settings-file';
import { createLogger } from '../logger';
import {
  DEFAULT_VIEWER_PREFERENCES,
  type RemoteViewerPreferences,
} from '../../shared/remoteDesktopViewer';

type Overrides = Record<string, Partial<RemoteViewerPreferences>>;
const store = createOverrideSettingsFile<Overrides>({
  filePath: () => ownerScopedUserDataPath('remote-desktop-viewer.json'),
  scopeKey: activeOwnerScopeKey,
  defaults: {},
  normalize: (raw) => {
    const result: Overrides = {};
    if (!raw || typeof raw !== 'object') return result;
    for (const [device, value] of Object.entries(raw)) {
      if (!/^[a-f0-9]{64}$/.test(device) || !value || typeof value !== 'object') continue;
      const patch: Partial<RemoteViewerPreferences> = {};
      for (const key of Object.keys(
        DEFAULT_VIEWER_PREFERENCES,
      ) as (keyof RemoteViewerPreferences)[]) {
        if (key === 'idleTimeoutMinutes') {
          if (isRemoteDesktopIdleMinutes(value[key])) patch[key] = value[key];
        } else if (key in value && typeof value[key] === 'boolean') patch[key] = value[key];
      }
      result[device] = patch;
    }
    return result;
  },
  maxBytes: 256 * 1024,
  preserveUnreadableFile: true,
  logLoadedValue: false,
  logReadErrorDetails: false,
  log: createLogger('remote-viewer-preferences'),
  label: 'remote viewer',
});
const keyFor = (device: string) => createHash('sha256').update(device).digest('hex');
export function readViewerPreferences(device: string): RemoteViewerPreferences {
  store.invalidateIfChanged();
  return { ...DEFAULT_VIEWER_PREFERENCES, ...store.read()[keyFor(device)] };
}
export async function writeViewerPreferences(
  device: string,
  patch: Partial<RemoteViewerPreferences>,
): Promise<RemoteViewerPreferences> {
  if (
    !patch ||
    typeof patch !== 'object' ||
    Array.isArray(patch) ||
    Object.entries(patch).some(
      ([key, value]) =>
        !Object.hasOwn(DEFAULT_VIEWER_PREFERENCES, key) ||
        (key === 'idleTimeoutMinutes'
          ? !isRemoteDesktopIdleMinutes(value)
          : typeof value !== 'boolean'),
    )
  )
    throw new Error('INVALID_REQUEST');
  const key = keyFor(device);
  const result = await store.updateAtomic(({ value }) => {
    // Keep explicit toggle choices even when they equal today's default. Unedited
    // fields remain absent so future defaults do not become frozen overrides.
    // Choosing the default idle duration clears it, matching Mobile.
    const next = { ...value[key], ...patch };
    if (next.idleTimeoutMinutes === DEFAULT_VIEWER_PREFERENCES.idleTimeoutMinutes)
      delete next.idleTimeoutMinutes;
    return { [key]: next };
  });
  return { ...DEFAULT_VIEWER_PREFERENCES, ...result[key] };
}
