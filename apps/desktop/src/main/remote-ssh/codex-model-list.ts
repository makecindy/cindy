import type { ProviderView } from '@cindy/model-providers';
import { requireObject, requireString, throwIpcError } from '../utils/ipcValidate.js';

/** Only an unchanged persisted native SSH route may bypass new-model discovery. */
export function isVerifiedSshCodexResume(
  request: { model?: string; providerId?: string | null; remoteHostId?: string | null; resumeSessionId?: string },
  stored: { model: string; providerId: string | null; remoteHostId: string | null; sdkSessionId: string | null; agentKind: string } | undefined,
): boolean {
  return !!stored && stored.agentKind === 'codex' && !!request.remoteHostId &&
    stored.remoteHostId === request.remoteHostId && !!request.resumeSessionId &&
    stored.sdkSessionId === request.resumeSessionId && stored.model === request.model &&
    (stored.providerId ?? null) === (request.providerId ?? null) &&
    (!request.providerId || request.providerId === 'openai');
}

export async function readSshCodexModelList(
  input: unknown,
  read: (hostId: string) => Promise<ProviderView[]>,
): Promise<ProviderView[]> {
  const id = requireString(requireObject(input).id, 'id');
  if (id.length > 256) throwIpcError('INVALID_PARAMS', 'SSH host id is too long');
  try {
    const providers = await read(id);
    if (!providers.some((provider) => provider.models.codex?.length)) {
      throw new Error('Remote Codex returned no selectable models');
    }
    return providers;
  } catch {
    // RPC failures may contain remote configuration or credentials.
    throwIpcError('SSH_EXEC_FAILED', 'Unable to read remote Codex models; reconnect and retry');
  }
}

export function assertSshCodexModel(providers: ProviderView[], model: string, providerId?: string | null) {
  if (providerId && providerId !== 'openai') {
    throwIpcError('INVALID_PARAMS', 'SSH Codex uses the remote native connection');
  }
  const descriptor = providers[0]?.models.codex?.find((item) => item.id === model);
  if (!descriptor) throwIpcError('INVALID_PARAMS', 'Model is unavailable on this SSH host; choose a remote Codex model');
  return descriptor;
}
