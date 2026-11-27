import type { RemoteUtilityResponse } from '@cindy/device-link';
import type { UtilityTextRequestOptions } from '../oneShotCandidatesCore.js';
import type { UtilityTextResult } from '../../../shared/utilityTextResult.js';
import type { RemoteAuxiliaryRoute } from '../../../shared/remoteAuxiliaryModelRef.js';

/**
 * The transport the short-text client needs, injected by the Desktop assembly.
 *
 * Keeping it a port instead of importing the Device Link entry keeps this module
 * loadable from the widely imported auxiliary facade: the entry pulls in the whole
 * IPC dispatcher, which would drag `maker-ipc/register` into unrelated tests and
 * tear the module-init order they rely on.
 */
export interface RemoteUtilityTextTransport {
  backgroundInvoke(
    deviceId: string,
    channel: string,
    args: unknown[],
    options?: { preSend?: () => void },
  ): Promise<{ ok: boolean; result?: unknown }>;
  invokeOnExistingLink(
    deviceId: string,
    channel: string,
    args: unknown[],
    options: { preSend: () => void },
  ): Promise<{ ok: boolean; result?: unknown }>;
  linkCloseEpoch(deviceId: string): number;
}

export interface RemoteUtilityTextClient {
  readCapabilities(deviceId: string): Promise<Extract<RemoteUtilityResponse, { op: 'caps' }> | null>;
  request(route: RemoteAuxiliaryRoute, prompt: string, opts?: UtilityTextRequestOptions): Promise<UtilityTextResult>;
}
