import type { ProviderView } from '@cindy/model-providers';
import { extractIpcError } from '@/utils/ipcError';

/** Why the host Codex catalog could not be read, from the main-process error code. */
export type SshCodexLoadFailure = 'not-connected' | 'install-failed' | 'no-models' | 'runtime-failed';

/** Host Codex catalog for an SSH project. `idle` means it has not been read yet. */
export interface SshCodexCatalog {
  providers: ProviderView[];
  status: 'idle' | 'loading' | 'error' | 'ready';
  /** Set with `status: 'error'` when the reason is known; otherwise the generic notice applies. */
  failure?: SshCodexLoadFailure;
  refresh: () => void;
}

const FAILURE_BY_CODE: Partial<Record<string, SshCodexLoadFailure>> = {
  SSH_NOT_CONNECTED: 'not-connected',
  SSH_INSTALL_FAILED: 'install-failed',
  SSH_CODEX_MODELS_EMPTY: 'no-models',
  SSH_EXEC_FAILED: 'runtime-failed',
};

/** Classify a `remoteSsh.listCodexModels` rejection; unknown errors stay generic. */
export function sshCodexLoadFailureOf(error: unknown): SshCodexLoadFailure | undefined {
  const code = extractIpcError(error)?.code;
  return code ? FAILURE_BY_CODE[code] : undefined;
}

const FAILURE_MESSAGE_KEYS: Record<SshCodexLoadFailure, string> = {
  'not-connected': 'newChat.modelSelector.sshCodexLoadFailed.notConnected',
  'install-failed': 'newChat.modelSelector.sshCodexLoadFailed.installFailed',
  'no-models': 'newChat.modelSelector.sshCodexLoadFailed.noModels',
  'runtime-failed': 'newChat.modelSelector.sshCodexLoadFailed.runtimeFailed',
};

/** The i18n key explaining a failed host Codex read. */
export function sshCodexLoadFailedMessageKey(failure: SshCodexLoadFailure | undefined): string {
  return failure ? FAILURE_MESSAGE_KEYS[failure] : 'newChat.modelSelector.remoteLoadFailed';
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
