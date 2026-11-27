/** Product activity which can open an automatic turn after a remote terminal.
 * Match Session's provider-initiated turn boundary, rather than busy snapshots.
 */
import { isTerminalAgentErrorEvent, type AgentEvent } from '@cindy/maker-core';
import { isTurnContinuationBoundaryEvent } from '@cindy/maker-shared/turn-continuation';

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
interface TerminalOwnershipState {
  generation: number;
  runningGeneration: number;
  priorTurn: { generation: number; model?: string } | null;
  terminalKind: 'done' | 'error' | 'prior-error' | 'idle' | null;
  priorError: 'settled' | 'unsettled' | null;
  dispatchId: string | undefined;
  sendModel?: string;
  active: boolean;
  aborted: boolean;
}

/** One transition rule also advances the old owner while acceptance is pending. */
function observeOwnership(state: TerminalOwnershipState, event: AgentEvent): 'current' | 'prior' | undefined {
  if (event.turnScope === 'background') return;
  if ((event.type === 'done' || event.type === 'status') && isTurnContinuationBoundaryEvent(event)) return;
  if (startsRemoteProductTurn(event)) {
    if (!state.active && !state.aborted) state.sendModel = undefined;
    if (!state.aborted) state.active = true;
    state.priorTurn = null;
    state.terminalKind = null;
  }
  const data = event.data as { isRunning?: unknown; silentStop?: unknown } | null;
  if (event.type === 'status' && !event.agentMeta?.parentUuid && data?.isRunning === true) {
    state.runningGeneration = state.generation;
    state.priorTurn = null;
    if (state.terminalKind === 'idle') state.terminalKind = null;
  }
  if (event.type === 'status' && !event.agentMeta?.parentUuid && data?.isRunning === false
    && state.terminalKind !== 'done' && state.terminalKind !== 'error' && state.terminalKind !== 'prior-error') {
    state.terminalKind = 'idle';
  }
  if (event.type !== 'done' && !isTerminalAgentErrorEvent(event)) return;
  if (event.type === 'done' && data?.silentStop !== true && state.priorTurn !== null) {
    state.priorTurn = null;
    return 'prior';
  }
  // Before acceptance, an idle/error pair can still drain from N. Without
  // that idle evidence a dispatch-time start failure remains current. After
  // acceptance, preserve result-only errors following the consumed idle tail.
  if (event.type === 'error' && state.priorTurn !== null
    && ((state.dispatchId !== undefined && state.priorError === null && state.terminalKind === 'idle')
      || (state.dispatchId === undefined && state.terminalKind === null))) {
    // Session consumes the prior fence with this error when N had already
    // reported running; otherwise its paired done can still be an old tail.
    if (state.dispatchId !== undefined && state.runningGeneration === state.priorTurn.generation) {
      state.priorTurn = null;
    }
    state.terminalKind = 'prior-error';
    return 'prior';
  }
  state.terminalKind = event.type === 'done' ? 'done' : 'error';
  state.priorTurn = null;
  state.active = false;
  state.aborted = false;
  return 'current';
}

export class RemoteTurnTerminalOwnership {
  private state: TerminalOwnershipState = {
    generation: 0, runningGeneration: 0, priorTurn: null,
    terminalKind: null, priorError: null, dispatchId: undefined,
    active: false, aborted: false,
  };
  private observedPrior: TerminalOwnershipState['priorTurn'] = null;
  // A single fixed-size checkpoint, never an event buffer or a replay path.
  private pending: { callId: string; previous: TerminalOwnershipState } | undefined;

  /** Model selected for this dispatch, retained across setModel and restored on rejection. */
  get sendModel(): string | undefined {
    return this.state.sendModel;
  }

  /** Read immediately after observe, before accounting for the event or accepting another send. */
  modelForObservedEvent(fallback?: string): string | undefined {
    return this.observedPrior ? this.observedPrior.model : this.sendModel ?? fallback;
  }

  beginSend(unsettled: boolean, dispatchId: string, previousActive = unsettled, previousAborted = false, sendModel?: string): void {
    const previous = { ...this.state, active: previousActive, aborted: previousAborted };
    this.pending = { callId: dispatchId, previous };
    this.state = { ...previous };
    this.state.priorError = this.state.terminalKind === 'error' ? (unsettled ? 'unsettled' : 'settled') : null;
    this.state.dispatchId = dispatchId;
    this.state.sendModel = sendModel;
    this.observedPrior = null;
    this.state.priorTurn = this.state.generation > 0 && (unsettled || this.state.terminalKind === 'error')
      ? { generation: this.state.generation, model: previous.sendModel } : null;
    this.state.generation += 1;
    this.state.terminalKind = null;
    this.state.active = true;
    this.state.aborted = false;
  }

  acceptSend(dispatchId: string): void {
    // A settled prior error only fences its missing done until acceptance.
    if (this.state.dispatchId !== dispatchId) return;
    if (this.state.priorError === 'settled') this.state.priorTurn = null;
    this.state.priorError = null;
    this.state.dispatchId = undefined;
    this.pending = undefined;
  }

  isDispatchCurrent(dispatchId: string): boolean {
    return this.state.dispatchId === dispatchId;
  }

  rejectSend(dispatchId: string): { active: boolean; aborted: boolean; terminal: boolean } | undefined {
    if (!this.pending || this.pending.callId !== dispatchId || !this.isDispatchCurrent(dispatchId)) return undefined;
    this.observedPrior = null;
    this.state = this.pending.previous;
    this.pending = undefined;
    return { active: this.state.active, aborted: this.state.aborted,
      terminal: !this.state.aborted && (this.state.terminalKind === 'done' || this.state.terminalKind === 'error') };
  }

  abort(): void {
    this.state.active = false;
    this.state.aborted = true;
    if (this.pending) {
      this.pending.previous.active = false;
      this.pending.previous.aborted = true;
    }
  }

  observe(event: AgentEvent): boolean {
    if (this.pending) observeOwnership(this.pending.previous, event);
    const prior = this.state.priorTurn;
    const owner = observeOwnership(this.state, event);
    this.observedPrior = owner === 'prior' ? prior : null;
    return owner === 'current';
  }
}
