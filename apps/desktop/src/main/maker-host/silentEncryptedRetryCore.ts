
import path from 'node:path';

import { desktopMakerLogger } from './logger-adapter.js';
import {
  createOverrideSettingsFile,
  portableOverrideSettings,
  type OverrideSettingsState,
} from './override-settings-file.js';


export interface SilentEncryptedRetrySettings {
  enabled: boolean;
}

export function createSilentEncryptedRetryStore(ports: {
  getUserDataDir: typeof import('../userDataPath.js').getUserDataDir;
}) {
const { getUserDataDir } = ports;


const log = desktopMakerLogger.child('silent-encrypted-retry-store');

const DEFAULTS: SilentEncryptedRetrySettings = {
  enabled: true,
};

function settingsFilePath(): string {
  return path.join(getUserDataDir(), 'silent-encrypted-retry-settings.json');
}

function normalize(raw: unknown): SilentEncryptedRetrySettings {
  if (!raw || typeof raw !== 'object') return { ...DEFAULTS };
  const r = raw as Record<string, unknown>;
  return {
    enabled: typeof r.enabled === 'boolean' ? r.enabled : DEFAULTS.enabled,
  };
}

const store = createOverrideSettingsFile<SilentEncryptedRetrySettings>({
  filePath: settingsFilePath,
  defaults: DEFAULTS,
  normalize,
  log,
  label: 'silent encrypted retry',
}); function readSilentEncryptedRetrySettings(): SilentEncryptedRetrySettings {
  return store.read();
} function readSilentEncryptedRetrySettingsState(): OverrideSettingsState<SilentEncryptedRetrySettings> {
  return store.readState();
} function writeSilentEncryptedRetryEnabled(enabled: boolean): void {
  store.writePatch({ enabled });
  log.info('silent encrypted retry setting written', { enabled });
} function resetSilentEncryptedRetrySettings(): SilentEncryptedRetrySettings {
  return store.reset();
} const silentEncryptedRetryPortableSettings = portableOverrideSettings(store);
return { readSilentEncryptedRetrySettings, readSilentEncryptedRetrySettingsState, writeSilentEncryptedRetryEnabled, resetSilentEncryptedRetrySettings, silentEncryptedRetryPortableSettings };
}
