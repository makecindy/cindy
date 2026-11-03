import fs from 'node:fs';
import { activeOwnerScopeKey, ownerScopedUserDataPath } from '../appSessionState.js';
import { createLogger } from '../logger.js';
import { createOverrideSettingsFile } from './override-settings-file.js';

interface Settings {
  providers: Record<string, boolean> | null;
}

/** Sparse overrides keyed by the actual account connection, never the public catalog brand. */
export function createProviderFastPolicyStore(options: { filePath(): string; scopeKey(): string }) {
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
    log: createLogger('provider-fast-policy'),
    label: 'provider-fast-policy',
    maxBytes: 256 * 1024,
    preserveUnreadableFile: true,
    logLoadedValue: false,
    logReadErrorDetails: false,
  });
  return {
    allows(providerId: string): boolean {
      store.invalidateIfChanged();
      const providers = store.read().providers;
      return (
        providers !== null &&
        (!Object.hasOwn(providers, providerId) || providers[providerId] === true)
      );
    },
    async set(providerId: string, allowed: boolean, assertCurrent: () => void): Promise<void> {
      await store.updateAtomic(({ value }) => {
        assertCurrent();
        if (value.providers === null) throw new Error('Subscription Fast policy could not be read');
        if (
          !Object.hasOwn(value.providers, providerId) &&
          Object.keys(value.providers).length >= 4096
        )
          throw new Error('Too many subscription Fast policies');
        return { providers: { ...value.providers, [providerId]: allowed } };
      });
      assertCurrent();
    },
  };
}

export const providerFastPolicy = createProviderFastPolicyStore({
  filePath: () => ownerScopedUserDataPath('provider-fast-policy.json'),
  scopeKey: activeOwnerScopeKey,
});
