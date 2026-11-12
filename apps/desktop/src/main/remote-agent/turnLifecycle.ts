/** Product activity which can open an automatic turn after a remote terminal.
 * Match Session's provider-initiated turn boundary, rather than busy snapshots.
 */
import { isTerminalAgentErrorEvent, type AgentEvent } from '@cindy/maker-core';

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

/** Own terminals by send generation without changing the provider event or wire.
 * An unresolved prior turn may drain one done/idle tail after the next send.
 * Progress proves the new owner; silent-stop and real start errors remain valid.
 */
export class RemoteTurnTerminalOwnership {
  private generation = 0;
  private priorGeneration: number | null = null;
  private terminalKind: 'done' | 'error' | null = null;

  beginSend(unsettled: boolean): void {
    this.priorGeneration = this.generation > 0 && (unsettled || this.terminalKind === 'error')
      ? this.generation : null;
    this.generation += 1;
    this.terminalKind = null;
  }

  observe(event: AgentEvent): boolean {
    if (event.turnScope === 'background') return false;
    if (startsRemoteProductTurn(event)) {
      this.priorGeneration = null;
    }
    const data = event.data as { isRunning?: unknown; silentStop?: unknown } | null;
    if (event.type === 'status' && !event.agentMeta?.parentUuid && data?.isRunning === true) {
      this.priorGeneration = null;
    }
    if (event.type !== 'done' && !isTerminalAgentErrorEvent(event)) return false;
    if (event.type === 'done' && data?.silentStop !== true && this.priorGeneration !== null) {
      this.priorGeneration = null;
      return false;
    }
    this.terminalKind = event.type === 'done' ? 'done' : 'error';
    this.priorGeneration = null;
    return true;
  }
}
