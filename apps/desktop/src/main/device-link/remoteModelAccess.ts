import fs from 'node:fs';
import { activeOwnerScopeKey, ownerScopedUserDataPath } from '../appSessionState.js';
import { createLogger } from '../logger.js';
import { createOverrideSettingsFile } from '../maker-host/override-settings-file.js';
import { captureProviderManagementScope } from '../provider-group/managementScope.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import { isRemoteModelSelection, type RemoteModelSelection } from '../../shared/remoteModelAccess.js';

interface ProviderRule { models?: string[]; members: Record<string, string[]> }
interface Settings { providers: Record<string, ProviderRule> | null }
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const selection = (value: unknown): string[] => isRemoteModelSelection(value) && value !== null ? value : [];

/** Remote-only authorization; local model preferences and supplier credentials never pass through this store. */
export function createRemoteModelAccessStore(options: { filePath(): string; scopeKey(): string }) {
  const store = createOverrideSettingsFile<Settings>({
    ...options,
    defaults: () => {
      // An absent file preserves the old grant. An existing unreadable file must never restore full access.
      try { fs.statSync(options.filePath()); return { providers: null }; }
      catch (error) { return { providers: (error as NodeJS.ErrnoException).code === 'ENOENT' ? {} : null }; }
    },
    normalize(raw) {
      const providers = (raw as Settings | null)?.providers;
      if (!object(providers)) return { providers: null };
      return { providers: Object.fromEntries(Object.entries(providers).map(([id, rule]) => {
        if (!object(rule) || !object(rule.members)) return [id, { models: [], members: {} }];
        return [id, {
          ...('models' in rule ? { models: selection(rule.models) } : {}),
          members: object(rule.members)
            ? Object.fromEntries(Object.entries(rule.members).map(([member, ids]) => [member, selection(ids)])) : {},
        }];
      })) };
    },
    log: createLogger('remote-model-access'), label: 'remote-model-access',
    maxBytes: 4 * 1024 * 1024, preserveUnreadableFile: true,
    logLoadedValue: false, logReadErrorDetails: false,
  });
  function read(providerId: string, memberId?: string): { models: RemoteModelSelection; providerModels: RemoteModelSelection } {
    store.invalidateIfChanged();
    const providers = store.read().providers;
    if (providers === null) throwIpcError('PRECONDITION_FAILED', 'Remote model permissions could not be read');
    const rule = Object.hasOwn(providers, providerId) ? providers[providerId] : undefined;
    const providerModels = rule?.models ?? null;
    const models = memberId ? (rule && Object.hasOwn(rule.members, memberId) ? rule.members[memberId] : null) : providerModels;
    return { models, providerModels };
  }
  return {
    read,
    allows(providerId: string, model: string, memberId?: string): boolean {
      try {
        const { models, providerModels } = read(providerId, memberId);
        return Boolean(model) && (providerModels === null || providerModels.includes(model)) && (models === null || models.includes(model));
      } catch { return false; }
    },
    async set(providerId: string, models: RemoteModelSelection, memberId: string | undefined, assertCurrent: () => void) {
      if (!isRemoteModelSelection(models)) throwIpcError('INVALID_PARAMS', 'Invalid remote model selection');
      assertCurrent();
      await store.updateAtomic(({ value }) => {
        assertCurrent();
        if (value.providers === null) throwIpcError('PRECONDITION_FAILED', 'Remote model permissions could not be read');
        const providers = { ...value.providers };
        const previous = Object.hasOwn(providers, providerId) ? providers[providerId] : undefined;
        const rule: ProviderRule = { ...previous, members: { ...previous?.members } };
        if (memberId) {
          if (models === null) delete rule.members[memberId];
          else Object.defineProperty(rule.members, memberId, { value: [...models], enumerable: true, configurable: true, writable: true });
        } else if (models === null) delete rule.models;
        else rule.models = [...models];
        if (rule.models === undefined && Object.keys(rule.members).length === 0) delete providers[providerId];
        else Object.defineProperty(providers, providerId, { value: rule, enumerable: true, configurable: true, writable: true });
        return { providers };
      });
      assertCurrent();
      return read(providerId, memberId);
    },
  };
}

export const remoteModelAccess = createRemoteModelAccessStore({
  filePath: () => ownerScopedUserDataPath('remote-model-access.json'),
  scopeKey: () => { captureProviderManagementScope(); return activeOwnerScopeKey(); },
});
