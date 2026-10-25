import { parseRemoteAgentForkResult, type RemoteAgentForkRequest } from '@cindy/device-link';
import type { ForkSdkSessionResult } from '@cindy/maker-core';

import { RemoteAgentRunClient, type RemoteAgentInvoke } from './runClient';

/** A write is sent once. An unknown outcome never falls back to a local/empty conversation. */
export async function forkRemoteAgentSession(
  invoke: RemoteAgentInvoke,
  request: RemoteAgentForkRequest,
): Promise<ForkSdkSessionResult> {
  const caps = await RemoteAgentRunClient.caps(invoke);
  if (!caps.nativeFork) {
    throw new Error('[REMOTE_AGENT_PEER_TOO_OLD] Update Cindy on the computer running this task to fork it.');
  }
  // 本端有 REMOTE_AGENT_FORK_FAILED 的文案；不声明的旧控制端由被控端回原来的 UNAVAILABLE。
  const result = parseRemoteAgentForkResult(await invoke([{ op: 'fork', ...request, acceptsForkFailed: true }]));
  return { ...result, uuidMap: new Map(result.uuidMap) };
}
