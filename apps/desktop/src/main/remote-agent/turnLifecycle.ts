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
  private terminalKind: 'done' | 'error' | 'idle' | null = null;
  private priorError = false;
  private dispatchId: string | undefined;

  beginSend(unsettled: boolean, dispatchId: string): void {
    this.priorError = !unsettled && this.terminalKind === 'error';
    this.dispatchId = dispatchId;
    this.priorGeneration = this.generation > 0 && (unsettled || this.terminalKind === 'error')
      ? this.generation : null;
    this.generation += 1;
    this.terminalKind = null;
  }

  acceptSend(dispatchId: string): void {
    // Session only fences a prior error's missing done during dispatch. Once
    // accepted, a result-only done belongs to the new send. Unsettled turns
    // still retain their old-tail fence, and an older RPC cannot clear it.
    if (this.dispatchId !== dispatchId) return;
    if (this.priorError) this.priorGeneration = null;
    this.priorError = false;
    this.dispatchId = undefined;
  }

  observe(event: AgentEvent): boolean {
    if (event.turnScope === 'background') return false;
    if (startsRemoteProductTurn(event)) {
      this.priorGeneration = null;
      this.terminalKind = null;
    }
    const data = event.data as { isRunning?: unknown; silentStop?: unknown } | null;
    if (event.type === 'status' && !event.agentMeta?.parentUuid && data?.isRunning === true) {
      this.priorGeneration = null;
      if (this.terminalKind === 'idle') this.terminalKind = null;
    }
    if (event.type === 'status' && !event.agentMeta?.parentUuid && data?.isRunning === false
      && this.terminalKind !== 'done' && this.terminalKind !== 'error') {
      this.terminalKind = 'idle';
    }
    if (event.type !== 'done' && !isTerminalAgentErrorEvent(event)) return false;
    if (event.type === 'done' && data?.silentStop !== true && this.priorGeneration !== null) {
      this.priorGeneration = null;
      return false;
    }
    // Before any new progress or idle, the consumer may still be waiting on N.
    // Keep its first delayed error off accepted N+1, but not dispatch-time start
    // failures or an accepted result-only error after the idle tail was consumed.
    if (event.type === 'error' && this.priorGeneration !== null
      && this.dispatchId === undefined && this.terminalKind === null) {
      this.terminalKind = 'error';
      return false;
    }
    this.terminalKind = event.type === 'done' ? 'done' : 'error';
    this.priorGeneration = null;
    return true;
  }
}
