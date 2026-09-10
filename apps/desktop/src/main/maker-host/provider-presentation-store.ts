import { activeOwnerScopeKey, ownerScopedUserDataPath } from '../appSessionState.js';
import { desktopMakerLogger } from './logger-adapter.js';
import { createOverrideSettingsFile } from './override-settings-file.js';

export interface ProviderPresentation {
  name?: string;
  removed?: boolean;
}
interface PresentationFile extends ProviderPresentation {
  providers?: Record<string, ProviderPresentation>;
}
function normalizePresentation(raw: unknown): ProviderPresentation {
  if (!raw || typeof raw !== 'object') return {};
  const value = raw as ProviderPresentation;
  return {
    ...(typeof value.name === 'string' && value.name.trim() && value.name.length <= 128
      ? { name: value.name.trim() }
      : {}),
    ...(typeof value.removed === 'boolean' ? { removed: value.removed } : {}),
  };
}
const log = desktopMakerLogger.child('provider-presentation');
const store = createOverrideSettingsFile<PresentationFile>({
  // Preserve the original OpenAI preferences without a migration or duplicate source of truth.
  filePath: () => ownerScopedUserDataPath('local-codex-provider-prefs.json'),
  scopeKey: activeOwnerScopeKey,
  defaults: {},
  normalize: (raw) => {
    const root = normalizePresentation(raw);
    const providers = (raw as PresentationFile | null)?.providers;
    if (!providers || typeof providers !== 'object' || Array.isArray(providers)) return root;
    return {
      ...root,
      providers: Object.fromEntries(
        Object.entries(providers)
          .filter(([id]) => /^[a-zA-Z0-9._-]{1,128}$/.test(id) && id !== 'openai')
          .map(([id, value]) => [id, normalizePresentation(value)]),
      ),
    };
  },
  log,
  label: 'provider-presentation',
});
export function readProviderPresentation(providerId: string): ProviderPresentation {
  store.invalidateIfChanged();
  const { name, removed, providers } = store.read();
  return providerId === 'openai'
    ? { ...(name ? { name } : {}), ...(removed !== undefined ? { removed } : {}) }
    : (providers?.[providerId] ?? {});
}
export async function setProviderPresentation(providerId: string, patch: ProviderPresentation): Promise<void> {
  if (!/^[a-zA-Z0-9._-]{1,128}$/.test(providerId)) throw new Error('Invalid provider id');
  if (patch.name !== undefined && (!patch.name.trim() || patch.name.length > 128))
    throw new Error('Invalid provider name');
  const normalized = normalizePresentation(patch);
  await store.updateAtomic(({ value }) => {
    if (providerId === 'openai') return normalized;
    const providers = value.providers ?? {};
    return {
      providers: { ...providers, [providerId]: { ...providers[providerId], ...normalized } },
    };
  });
}
export const readLocalCodexPresentation = () => readProviderPresentation('openai');
/** Login or disconnect is already committed; display preferences cannot reverse its result. */
export async function retainProviderPresentationAfterAuthChange(providerId: string): Promise<void> {
  try {
    await setProviderPresentation(providerId, { removed: false });
  } catch (error) {
    log.warn('Failed to retain provider presentation after authentication change', { providerId, error: String(error) });
  }
}
/** Retain upgrade-era connections without resurrecting explicitly deleted rows. */
export async function retainInvalidatedProviderPresentation(providerId: string): Promise<void> {
  try {
    await store.updateAtomic(({ value }) => {
      const current = providerId === 'openai' ? value : value.providers?.[providerId];
      if (current?.removed !== undefined) return {};
      return providerId === 'openai' ? { removed: false } : {
        providers: { ...value.providers, [providerId]: { ...current, removed: false } },
      };
    });
  } catch (error) {
    // Display preferences must not prevent credential invalidation or its broadcast.
    log.warn('Failed to retain invalidated provider', { providerId, error: String(error) });
  }
}
export const renameLocalCodexProvider = (name: string) =>
  setProviderPresentation('openai', { name });
export const setLocalCodexProviderRemoved = (removed: boolean) =>
  setProviderPresentation('openai', { removed });
