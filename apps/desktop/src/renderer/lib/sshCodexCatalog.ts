import type { ProviderView } from '@cindy/model-providers';

/** Host Codex catalog for an SSH project. `idle` means it has not been read yet. */
export interface SshCodexCatalog {
  providers: ProviderView[];
  status: 'idle' | 'loading' | 'error' | 'ready';
  refresh: () => void;
}

/**
 * Model catalog for an SSH project. Codex runs on the host's native login, so its
 * models come only from the host; Claude Code and Pi keep the controller catalog.
 * Replacing only the Codex models keeps the other engines selectable from a Codex draft.
 */
export function mergeSshCodexCatalog(
  local: readonly ProviderView[],
  remoteCodex: readonly ProviderView[],
): ProviderView[] {
  const remoteById = new Map(remoteCodex.map((provider) => [provider.id, provider]));
  const merged: ProviderView[] = [];
  for (const provider of local) {
    const otherAgents = provider.agents.filter((agent) => agent !== 'codex');
    const remote = remoteById.get(provider.id);
    if (remote) {
      remoteById.delete(provider.id);
      // The host login must not enable disconnected or suspended local routes.
      merged.push(provider.connected && !provider.suspended && otherAgents.length > 0
        ? {
            ...remote,
            agents: [...otherAgents, 'codex'],
            routing: { ...provider.routing, codex: remote.routing.codex },
            models: { ...provider.models, codex: remote.models.codex ?? [] },
          }
        : remote);
      continue;
    }
    if (otherAgents.length === 0) continue;
    const models = { ...provider.models };
    const routing = { ...provider.routing };
    delete models.codex;
    delete routing.codex;
    merged.push({ ...provider, agents: otherAgents, models, routing });
  }
  merged.push(...remoteById.values());
  return merged;
}
