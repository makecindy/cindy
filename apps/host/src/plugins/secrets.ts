import fs from 'node:fs';
import path from 'node:path';
import { createGhostSecretStore } from '../../../desktop/src/main/secrets/ghostSecretStoreCore.js';
import { dataOwnerStorageKey } from '../../../desktop/src/main/dataOwnerPath.js';
import { activeOwnerScopeKey, isAppSessionBoundaryPending } from '../../../desktop/src/main/appSessionState.js';
import { createLogger } from '../../../desktop/src/main/logger.js';

/** Same encrypted records and same plugin rules as Desktop. Capturing the
 * generation prevents a queued old-account write from following a new owner. */
export function createHostPluginSecrets(profileDir: string, ownerId: string, codec: {
  read(key: string): string | null;
  write(key: string, value: string): void;
  remove(key: string): void;
}) {
  const owner = activeOwnerScopeKey();
  const prefix = `owner_${dataOwnerStorageKey(ownerId)}_`;
  const dir = path.join(profileDir, 'safe-storage');
  const check = () => {
    if (isAppSessionBoundaryPending() || activeOwnerScopeKey() !== owner) throw new Error('PLUGIN_OWNER_CHANGED');
  };
  const key = (value: string) => { check(); return prefix + value; };
  const log = createLogger('host-plugin-secrets');
  return createGhostSecretStore({
    ownerScoped: true,
    isAvailable() { check(); return true; },
    read: value => codec.read(key(value)),
    readStrict: value => codec.read(key(value)),
    write(value, secret) { codec.write(key(value), secret); return true; },
    remove(value) { codec.remove(key(value)); return { success: true }; },
    saved(value) {
      const file = path.join(dir, `${key(value)}.enc`);
      try { fs.statSync(file); return true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
    },
    list() {
      check();
      try { return fs.readdirSync(dir).filter(file => file.startsWith(prefix) && file.endsWith('.enc'))
        .map(file => file.slice(prefix.length, -4)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    },
  }, { warn: (details, message) => log.warn(message, details) });
}
