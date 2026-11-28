import type { ProviderView } from '@cindy/model-providers';
import { isIpcError, type IpcErrorCode } from '../../shared/ipc-errors.js';
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

/**
 * Stable failure categories for reading the remote Codex model list. Each maps a
 * failure to a fixed message: remote error text may contain configuration or
 * credentials, so it never reaches the renderer.
 */
const SSH_CODEX_MODEL_LIST_FAILURES = {
  notConnected: ['SSH_NOT_CONNECTED', 'SSH host is not connected or the request is stale; reconnect and retry'],
  installFailed: ['SSH_INSTALL_FAILED', 'Unable to install Codex on the SSH host'],
  noModels: ['SSH_CODEX_MODELS_EMPTY', 'Remote Codex returned no selectable models'],
  runtimeFailed: ['SSH_EXEC_FAILED', 'Remote Codex did not start or respond; retry'],
} as const satisfies Record<string, readonly [IpcErrorCode, string]>;

function sshCodexModelListFailure(err: unknown): keyof typeof SSH_CODEX_MODEL_LIST_FAILURES {
  const code = isIpcError(err) ? err.code : null;
  if (code === 'SSH_NOT_CONNECTED' || code === 'SSH_HOST_NOT_FOUND') return 'notConnected';
  if (code === 'SSH_INSTALL_FAILED') return 'installFailed';
  return 'runtimeFailed';
}

export async function readSshCodexModelList(
  input: unknown,
  read: (hostId: string) => Promise<ProviderView[]>,
): Promise<ProviderView[]> {
  const id = requireString(requireObject(input).id, 'id');
  if (id.length > 256) throwIpcError('INVALID_PARAMS', 'SSH host id is too long');
  let providers: ProviderView[];
  try {
    providers = await read(id);
  } catch (err) {
    // Keep only the category: RPC failures may contain remote configuration or credentials.
    const [code, message] = SSH_CODEX_MODEL_LIST_FAILURES[sshCodexModelListFailure(err)];
    throwIpcError(code, message);
  }
  if (!providers.some((provider) => provider.models.codex?.length)) {
    const [code, message] = SSH_CODEX_MODEL_LIST_FAILURES.noModels;
    throwIpcError(code, message);
  }
  return providers;
}

export function assertSshCodexModel(providers: ProviderView[], model: string, providerId?: string | null) {
  if (providerId && providerId !== 'openai') {
    throwIpcError('REMOTE_CODEX_SOURCE_UNSUPPORTED', 'SSH Codex uses the remote native connection');
  }
  const descriptor = providers[0]?.models.codex?.find((item) => item.id === model);
  if (!descriptor) throwIpcError('INVALID_PARAMS', 'Model is unavailable on this SSH host; choose a remote Codex model');
  return descriptor;
}
