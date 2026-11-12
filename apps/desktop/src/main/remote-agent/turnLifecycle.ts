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
  private runningGeneration = 0;
  private priorGeneration: number | null = null;
  private terminalKind: 'done' | 'error' | 'prior-error' | 'idle' | null = null;
  private priorError: 'settled' | 'unsettled' | null = null;
  private dispatchId: string | undefined;

  beginSend(unsettled: boolean, dispatchId: string): void {
    this.priorError = this.terminalKind === 'error' ? (unsettled ? 'unsettled' : 'settled') : null;
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
    if (this.priorError === 'settled') this.priorGeneration = null;
    this.priorError = null;
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
      this.runningGeneration = this.generation;
      this.priorGeneration = null;
      if (this.terminalKind === 'idle') this.terminalKind = null;
    }
    if (event.type === 'status' && !event.agentMeta?.parentUuid && data?.isRunning === false
      && this.terminalKind !== 'done' && this.terminalKind !== 'error' && this.terminalKind !== 'prior-error') {
      this.terminalKind = 'idle';
    }
    if (event.type !== 'done' && !isTerminalAgentErrorEvent(event)) return false;
    if (event.type === 'done' && data?.silentStop !== true && this.priorGeneration !== null) {
      this.priorGeneration = null;
      return false;
    }
    // Before acceptance, an idle/error pair can still drain from N. Without
    // that idle evidence a dispatch-time start failure remains current. After
    // acceptance, preserve result-only errors following the consumed idle tail.
    if (event.type === 'error' && this.priorGeneration !== null
      && ((this.dispatchId !== undefined && this.priorError === null && this.terminalKind === 'idle')
        || (this.dispatchId === undefined && this.terminalKind === null))) {
      // Session consumes the prior fence with this error when N had already
      // reported running; otherwise its paired done can still be an old tail.
      if (this.dispatchId !== undefined && this.runningGeneration === this.priorGeneration) {
        this.priorGeneration = null;
      }
      this.terminalKind = 'prior-error';
      return false;
    }
    this.terminalKind = event.type === 'done' ? 'done' : 'error';
    this.priorGeneration = null;
    return true;
  }
}
