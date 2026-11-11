/** Product activity which can open an automatic turn after a remote terminal.
 * Match Session's provider-initiated turn boundary, rather than busy snapshots.
 */
import type { AgentEvent } from '@cindy/maker-core';

export function startsRemoteProductTurn(event: AgentEvent): boolean {
  if (event.turnScope === 'background') return false;
  const parent = event.agentMeta?.parentUuid;
  if (typeof parent === 'string' && parent.length > 0) return false;
  if (event.type === 'status') {
    const data = event.data as { isRunning?: unknown; providerInitiatedTurn?: unknown } | null;
    return event.source === 'claude-code' && data?.isRunning === true && data.providerInitiatedTurn === true;
  }
  return event.type === 'text' || event.type === 'thinking' || event.type === 'image'
    || event.type === 'tool_use' || event.type === 'tool_result' || event.type === 'tool_result_full';
}
