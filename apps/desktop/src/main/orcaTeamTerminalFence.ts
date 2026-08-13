export interface OrcaTeamTerminalTransition {
  readonly teamId: string;
  readonly token: symbol;
}

export interface OrcaTeamDispatchReservation {
  readonly teamId: string;
  readonly token: symbol;
}

interface OrcaTeamTerminalFenceEntry {
  terminal: boolean;
  pending: Set<symbol>;
  dispatchReservations: Set<symbol>;
  pendingWaiters: Set<(state: Exclude<OrcaTeamTerminalFenceState, 'pending'>) => void>;
}

export type OrcaTeamTerminalFenceState = 'open' | 'pending' | 'terminal';

/**
 * Synchronous main-process fence for the async DB transition-to-vendor window.
 * Pending transitions are never evicted; committed history is bounded.
 */
export class OrcaTeamTerminalFence {
  private readonly entries = new Map<string, OrcaTeamTerminalFenceEntry>();
  private readonly order: string[] = [];

  constructor(private readonly maxEntries = 512) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
      throw new Error('maxEntries must be a positive safe integer');
    }
  }

  begin(teamId: string): OrcaTeamTerminalTransition {
    const token = Symbol(teamId);
    let entry = this.entries.get(teamId);
    if (!entry) {
      entry = {
        terminal: false,
        pending: new Set(),
        dispatchReservations: new Set(),
        pendingWaiters: new Set(),
      };
      this.entries.set(teamId, entry);
      this.order.push(teamId);
    }
    entry.pending.add(token);
    this.trimCommittedHistory();
    return { teamId, token };
  }

  commit(transition: OrcaTeamTerminalTransition): void {
    const entry = this.entries.get(transition.teamId);
    if (!entry || !entry.pending.delete(transition.token)) return;
    entry.terminal = true;
    this.settlePendingWaiters(entry);
    this.trimCommittedHistory();
  }

  rollback(transition: OrcaTeamTerminalTransition): void {
    const entry = this.entries.get(transition.teamId);
    if (!entry || !entry.pending.delete(transition.token)) return;
    this.settlePendingWaiters(entry);
    if (!entry.terminal && entry.pending.size === 0 && entry.dispatchReservations.size === 0) {
      this.deleteEntry(transition.teamId);
    }
    this.trimCommittedHistory();
  }

  has(teamId: string): boolean {
    return this.getState(teamId) !== 'open';
  }

  getState(teamId: string): OrcaTeamTerminalFenceState {
    const entry = this.entries.get(teamId);
    if (entry?.terminal) return 'terminal';
    if (entry && entry.pending.size > 0) return 'pending';
    return 'open';
  }

  waitForPendingTransition(
    teamId: string,
  ): Promise<Exclude<OrcaTeamTerminalFenceState, 'pending'>> {
    const entry = this.entries.get(teamId);
    if (!entry || entry.pending.size === 0) {
      return Promise.resolve(entry?.terminal ? 'terminal' : 'open');
    }
    if (entry.terminal) return Promise.resolve('terminal');
    return new Promise((resolve) => {
      entry.pendingWaiters.add(resolve);
    });
  }

  reserveDispatch(teamId: string): OrcaTeamDispatchReservation {
    const token = Symbol(teamId);
    let entry = this.entries.get(teamId);
    if (!entry) {
      entry = {
        terminal: false,
        pending: new Set(),
        dispatchReservations: new Set(),
        pendingWaiters: new Set(),
      };
      this.entries.set(teamId, entry);
      this.order.push(teamId);
    }
    entry.dispatchReservations.add(token);
    this.trimCommittedHistory();
    return { teamId, token };
  }

  releaseDispatch(reservation: OrcaTeamDispatchReservation): void {
    const entry = this.entries.get(reservation.teamId);
    if (!entry || !entry.dispatchReservations.delete(reservation.token)) return;
    if (!entry.terminal && entry.pending.size === 0 && entry.dispatchReservations.size === 0) {
      this.deleteEntry(reservation.teamId);
    }
    this.trimCommittedHistory();
  }

  markTerminal(teamId: string): void {
    const transition = this.begin(teamId);
    this.commit(transition);
  }

  private trimCommittedHistory(): void {
    while (this.entries.size > this.maxEntries) {
      const evictableIndex = this.order.findIndex((teamId) => {
        const entry = this.entries.get(teamId);
        return (
          !!entry &&
          entry.terminal &&
          entry.pending.size === 0 &&
          entry.dispatchReservations.size === 0
        );
      });
      if (evictableIndex < 0) return;
      const [teamId] = this.order.splice(evictableIndex, 1);
      if (teamId !== undefined) this.entries.delete(teamId);
    }
  }

  private settlePendingWaiters(entry: OrcaTeamTerminalFenceEntry): void {
    const state = entry.terminal ? 'terminal' : entry.pending.size === 0 ? 'open' : 'pending';
    if (state === 'pending') return;
    const waiters = [...entry.pendingWaiters];
    entry.pendingWaiters.clear();
    for (const resolve of waiters) resolve(state);
  }

  private deleteEntry(teamId: string): void {
    this.entries.delete(teamId);
    const index = this.order.indexOf(teamId);
    if (index >= 0) this.order.splice(index, 1);
  }
}

export const orcaTeamTerminalFence = new OrcaTeamTerminalFence();
