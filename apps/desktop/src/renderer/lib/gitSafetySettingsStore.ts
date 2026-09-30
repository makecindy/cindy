/**
 * gitSafetySettingsStore — renderer mirror for Git safety settings.
 *
 * Source of truth is main's <userData>/git-safety-settings.json. localStorage
 * is only a synchronous renderer mirror for settings UI and compatibility
 * consumers; rewind visibility is determined by agent capabilities and its
 * preview explains when file restoration is unavailable.
 */

export type GitSafetyMode = 'off' | 'existing-git' | 'all-projects';
const STORAGE_KEY = 'gitSafety.mode';
const LEGACY_STORAGE_KEY = 'gitSafety.autoSnapshotEnabled';
const SYNC_KEY = 'gitSafety.sync';

type Subscriber = (value: boolean) => void;
type ModeSubscriber = (value: GitSafetyMode, source: 'local' | 'storage') => void;
const subscribers = new Set<Subscriber>();
const modeSubscribers = new Set<ModeSubscriber>();

function modeFromLegacy(value: string | null): GitSafetyMode {
  return value === 'true' ? 'all-projects' : 'off';
}

export function getGitSafetyMode(): GitSafetyMode {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    if (value === 'off' || value === 'existing-git' || value === 'all-projects') return value;
    const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
    return legacy === null ? 'existing-git' : modeFromLegacy(legacy);
  } catch {
    return 'off';
  }
}

export function getGitSafetyAutoSnapshotEnabled(): boolean {
  return getGitSafetyMode() !== 'off';
}

export function setGitSafetyAutoSnapshotEnabled(next: boolean): void {
  setGitSafetyMode(next ? 'all-projects' : 'off');
}

export function setGitSafetyMode(next: GitSafetyMode): void {
  try {
    localStorage.setItem(STORAGE_KEY, next);
    // Same-mode writes still need a storage event so other Settings windows
    // refresh isCustomized. Bump an unrelated key instead of adding a bus.
    localStorage.setItem(SYNC_KEY, String(Date.now()));
  } catch {
    // localStorage unavailable — ignore; callers still get main IPC errors.
  }
  subscribers.forEach((cb) => cb(next !== 'off'));
  modeSubscribers.forEach((cb) => cb(next, 'local'));
}

export function subscribeGitSafetyAutoSnapshotEnabled(cb: Subscriber): () => void {
  subscribers.add(cb);

  const storageHandler = (e: StorageEvent) => {
    if (e.key !== STORAGE_KEY && e.key !== LEGACY_STORAGE_KEY && e.key !== SYNC_KEY) return;
    cb(getGitSafetyAutoSnapshotEnabled());
  };
  window.addEventListener('storage', storageHandler);

  return () => {
    subscribers.delete(cb);
    window.removeEventListener('storage', storageHandler);
  };
}

export function subscribeGitSafetyMode(cb: ModeSubscriber): () => void {
  modeSubscribers.add(cb);
  const storageHandler = (e: StorageEvent) => {
    if (e.key !== STORAGE_KEY && e.key !== LEGACY_STORAGE_KEY && e.key !== SYNC_KEY) return;
    cb(getGitSafetyMode(), 'storage');
  };
  window.addEventListener('storage', storageHandler);

  return () => {
    modeSubscribers.delete(cb);
    window.removeEventListener('storage', storageHandler);
  };
}

function hasExplicitLegacyOptOut(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === null
      && localStorage.getItem(LEGACY_STORAGE_KEY) === 'false';
  } catch {
    return false;
  }
}

/**
 * Old `writePatch({ autoSnapshotEnabled: false })` deleted the main override,
 * so explicit opt-out looks like "never configured" on disk. The renderer
 * legacy key is the remaining durable marker; persist it to main *before*
 * any GET can overwrite the mirror with the new default.
 */
export async function persistLegacyGitSafetyOptOut(): Promise<boolean> {
  if (!hasExplicitLegacyOptOut()) return false;
  await window.electronAPI.maker.gitSafetySet('off');
  setGitSafetyMode('off');
  return true;
}

export async function bootstrapGitSafetySettingsFromMain(): Promise<void> {
  try {
    if (hasExplicitLegacyOptOut()) {
      try {
        await persistLegacyGitSafetyOptOut();
      } catch {
        // Keep the legacy opt-out marker; do not GET the new default.
      }
      return;
    }
    const settings = await window.electronAPI.maker.gitSafetyGet();
    const mode =
      settings.mode === 'off' || settings.mode === 'existing-git' || settings.mode === 'all-projects'
        ? settings.mode
        : settings.autoSnapshotEnabled
          ? 'all-projects'
          : 'off';
    setGitSafetyMode(mode);
  } catch {
    // preload unavailable / IPC failed — keep local fallback.
  }
}
