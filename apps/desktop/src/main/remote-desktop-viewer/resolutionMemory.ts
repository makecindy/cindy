import { createHash } from 'node:crypto';
import { activeOwnerScopeKey, ownerScopedUserDataPath } from '../appSessionState';
import { createOverrideSettingsFile } from '../maker-host/override-settings-file';
import { createLogger } from '../logger';
import {
  parseRememberedViewerResolution,
  type RememberedViewerResolution,
} from '../../shared/remoteDesktopViewer';

// Non-secret, account-scoped: the last display choice this computer made for
// one monitor of one remote computer. The host still restores its own display
// when the viewer leaves.
type Memory = Record<string, RememberedViewerResolution>;
const store = createOverrideSettingsFile<Memory>({
  filePath: () => ownerScopedUserDataPath('remote-desktop-viewer-resolutions.json'),
  scopeKey: activeOwnerScopeKey,
  defaults: {},
  normalize: (raw) => {
    const result: Memory = {};
    if (!raw || typeof raw !== 'object') return result;
    for (const [key, value] of Object.entries(raw)) {
      const remembered = /^[a-f0-9]{64}$/.test(key) ? parseRememberedViewerResolution(value) : null;
      if (remembered) result[key] = remembered;
    }
    return result;
  },
  maxBytes: 256 * 1024,
  preserveUnreadableFile: true,
  logLoadedValue: false,
  logReadErrorDetails: false,
  log: createLogger('remote-viewer-resolutions'),
  label: 'remote viewer resolution',
});
const keyFor = (device: string, display: string) =>
  createHash('sha256').update(device).update('\0').update(display).digest('hex');

export function readViewerResolution(
  device: string,
  display: string,
): RememberedViewerResolution | null {
  store.invalidateIfChanged();
  return store.read()[keyFor(device, display)] ?? null;
}

/** `null` forgets the choice, so the computer keeps its own display next time. */
export async function writeViewerResolution(
  device: string,
  display: string,
  value: RememberedViewerResolution | null,
): Promise<void> {
  await store.updateAtomic(() => ({
    // A normalized-away null equals the default and drops the entry.
    [keyFor(device, display)]: value as RememberedViewerResolution,
  }));
}
