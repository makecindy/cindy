import { throwIpcError } from '../utils/ipcValidate.js';
import { activeOwnerScopeKey, ownerScopedUserDataPath } from '../appSessionState.js';
import { createLogger } from '../logger.js';
import { createOverrideSettingsFile } from '../maker-host/override-settings-file.js';
import { captureProviderManagementScope } from '../provider-group/managementScope.js';
import type { ProviderShareVisibility } from '../../shared/providerShareInsights.js';

interface VisibilitySettings {
  providers: Record<string, Partial<ProviderShareVisibility> & { revision: number }>;
}

export function createProviderShareVisibilityStore(options: {
  filePath(): string;
  scopeKey(): string;
}) {
  const store = createOverrideSettingsFile<VisibilitySettings>({
    ...options,
    defaults: () => ({ providers: {} }),
    normalize(raw) {
      const providers = (raw as Partial<VisibilitySettings> | null)?.providers;
      return {
        providers: Object.fromEntries(
          Object.entries(
            providers && typeof providers === 'object' && !Array.isArray(providers)
              ? providers
              : {},
          )
            .filter(([id, value]) => id.length > 0 && value && typeof value === 'object')
            .map(([id, value]) => [
              id,
              {
                ...(value.quota === true ? { quota: true } : {}),
                ...(value.usage === true ? { usage: true } : {}),
                revision: Number.isSafeInteger(value.revision) ? value.revision : 0,
              },
            ]),
        ),
      };
    },
    log: createLogger('provider-share:visibility'),
    label: 'provider-share-visibility',
    maxBytes: 1024 * 1024,
    preserveUnreadableFile: true,
    logLoadedValue: false,
    logReadErrorDetails: false,
  });
  return {
    read(providerId: string): ProviderShareVisibility & { revision: number } {
      store.invalidateIfChanged();
      const value = store.read().providers[providerId];
      return {
        quota: value?.quota === true,
        usage: value?.usage === true,
        revision: value?.revision ?? 0,
      };
    },
    async set(
      providerId: string,
      patch: Partial<ProviderShareVisibility>,
      assertCurrent: () => void,
    ) {
      assertCurrent();
      try {
        await store.updateAtomic(({ value }) => {
          assertCurrent();
          const previous = value.providers[providerId];
          const quota = patch.quota ?? previous?.quota ?? false;
          const usage = patch.usage ?? previous?.usage ?? false;
          return {
            providers: {
              ...value.providers,
              [providerId]: {
                ...(quota ? { quota: true } : {}),
                ...(usage ? { usage: true } : {}),
                revision: (previous?.revision ?? 0) + 1,
              },
            },
          };
        });
      } catch {
        assertCurrent();
        throwIpcError('PRECONDITION_FAILED', 'Could not save provider share visibility');
      }
      assertCurrent();
      return this.read(providerId);
    },
  };
}

export const providerShareVisibility = createProviderShareVisibilityStore({
  filePath: () => ownerScopedUserDataPath('provider-share-visibility.json'),
  scopeKey: () => {
    captureProviderManagementScope();
    return activeOwnerScopeKey();
  },
});
