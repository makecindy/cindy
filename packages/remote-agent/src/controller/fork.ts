import { parseRemoteAgentForkResult, type RemoteAgentForkRequest } from '@cindy/device-link';
import type { ForkSdkSessionResult } from '@cindy/maker-core';

import { RemoteAgentRunClient, type RemoteAgentInvoke } from './runClient.js';

/** A write is sent once. An unknown outcome never falls back to a local/empty conversation. */
export async function forkRemoteAgentSession(
  invoke: RemoteAgentInvoke,
  request: RemoteAgentForkRequest,
): Promise<ForkSdkSessionResult> {
  const caps = await RemoteAgentRunClient.caps(invoke);
  if (!caps.nativeFork) {
    throw new Error('[REMOTE_AGENT_PEER_TOO_OLD] Update Cindy on the computer running this task to fork it.');
  }
  const result = parseRemoteAgentForkResult(await invoke([{ op: 'fork', ...request }]));
  return { ...result, uuidMap: new Map(result.uuidMap) };
}
