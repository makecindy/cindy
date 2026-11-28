import type { AgentKind, Provider, CustomProviderConfig } from '@cindy/model-providers';
import { isGeminiChatEndpoint } from '../../shared/geminiApiConnection.js';
import { activeOwnerScopeKey, ownerScopedUserDataPath } from '../appSessionState.js';
import { desktopMakerLogger } from './logger-adapter.js';
import { createOverrideSettingsFile } from './override-settings-file.js';

// Only a connection reference is stored here. Old profiles have no override.
const binding = createOverrideSettingsFile<{ providerId: string | null }>({
  filePath: () => ownerScopedUserDataPath('gemini-image-connection.json'),
  scopeKey: activeOwnerScopeKey,
  defaults: { providerId: null },
  normalize: raw => {
    const id = (raw as { providerId?: unknown })?.providerId;
    if (typeof id !== 'string' || !/^[a-z0-9_-]{1,40}$/.test(id)) throw new Error('Invalid Gemini image connection');
    return { providerId: id };
  },
  preserveUnreadableFile: true,
  log: desktopMakerLogger.child('gemini-image-connection'),
  label: 'Gemini image connection',
});

export function bindGeminiImageConnection(providerId: string): Promise<void> {
  return binding.writePatchAtomic({ providerId });
}

export function geminiImageConnectionId(): string | null {
  binding.invalidateIfChanged();
  const { providerId } = binding.read();
  if (binding.isUnreadable()) return ''; // Fail closed without affecting other media channels.
  return providerId;
}

const googleAgents = ['codex', 'pi', 'claude-code'] as const;

export function geminiImageAgent(provider: Provider | undefined): AgentKind | undefined {
  if (provider?.source !== 'user' || provider.auth.method !== 'apiKey') return undefined;
  return googleAgents.find(agent => isGeminiChatEndpoint(provider.routing[agent]?.upstream));
}

/** A catalog refresh may lag a committed edit. Verify the selected route against its saved endpoint. */
export function savedGeminiRouteMatches(config: CustomProviderConfig | null, agent: AgentKind | undefined): boolean {
  return !!config && !!agent && (!config.auth || config.auth.method === 'apiKey') &&
    isGeminiChatEndpoint(config.runtimes[agent]?.baseUrl);
}

export function resolveGeminiImageKey(
  id: string | null,
  find: (id: string) => Provider | undefined,
  readKey: (id: string, agent: AgentKind) => string | null,
  readLegacy: () => string | null,
): string | null {
  if (id === null) return readLegacy();
  if (!id) return null;
  const agent = geminiImageAgent(find(id));
  return agent ? readKey(id, agent) : null;
}
