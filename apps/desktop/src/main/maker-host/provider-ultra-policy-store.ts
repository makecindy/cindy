import fs from 'node:fs';
import { activeOwnerScopeKey, ownerScopedUserDataPath } from '../appSessionState.js';
import { createLogger } from '../logger.js';
import { createOverrideSettingsFile } from './override-settings-file.js';

interface Settings {
  providers: Record<string, boolean> | null;
}

/** Sparse per-account opt-outs for the Ultra reasoning tier. Default is on. */
export function createProviderUltraPolicyStore(options: {
  filePath(): string;
  scopeKey(): string;
}) {
  const store = createOverrideSettingsFile<Settings>({
    ...options,
    defaults: () => {
      try {
        fs.statSync(options.filePath());
        return { providers: null };
      } catch (error) {
        return { providers: (error as NodeJS.ErrnoException).code === 'ENOENT' ? {} : null };
      }
    },
    normalize(raw) {
      const providers = (raw as Settings | null)?.providers;
      if (!providers || typeof providers !== 'object' || Array.isArray(providers))
        return { providers: null };
      if (Object.keys(providers).length > 4096) return { providers: null };
      return {
        providers: Object.fromEntries(
          Object.entries(providers).map(([id, allowed]) => [id, allowed === true]),
        ),
      };
    },
    log: createLogger('provider-ultra-policy'),
    label: 'provider-ultra-policy',
    maxBytes: 256 * 1024,
    preserveUnreadableFile: true,
    logLoadedValue: false,
    logReadErrorDetails: false,
  });
  return {
    allows(providerId: string): boolean {
      store.invalidateIfChanged();
      const providers = store.read().providers;
      // Absent or unreadable settings preserve the historical behavior: Ultra stays available.
      return providers === null || providers[providerId] !== false;
    },
    async set(providerId: string, allowUltra: boolean, assertCurrent: () => void): Promise<void> {
      await store.updateAtomic(({ value }) => {
        assertCurrent();
        if (value.providers === null) throw new Error('Ultra policy could not be read');
        if (
          !Object.hasOwn(value.providers, providerId) &&
          Object.keys(value.providers).length >= 4096
        )
          throw new Error('Too many Ultra policies');
        return { providers: { ...value.providers, [providerId]: allowUltra } };
      });
      assertCurrent();
    },
  };
}

export const providerUltraPolicy = createProviderUltraPolicyStore({
  filePath: () => ownerScopedUserDataPath('provider-ultra-policy.json'),
  scopeKey: activeOwnerScopeKey,
});
