import type { LocalNetworkAccess, LocalNetworkReminder } from '../../shared/localNetwork';

/** The "just turned on control" reminder stays relevant for one sitting, not forever. */
const CONTROL_REMINDER_MS = 10 * 60_000;
/** Path flaps are frequent; a known set of relay-only peers re-probes at most this often. */
const RELAY_PROBE_INTERVAL_MS = 30_000;

/**
 * Decides when the missing Local Network permission is worth a reminder.
 * Denied access hides LAN beacons in both directions, so "is the peer on my LAN"
 * cannot be observed; the observable cost is a connected peer stuck on the relay.
 */
export class LocalNetworkReminderState {
  private controlAt: number | null = null;
  private relay: string[] = [];
  private lastRelayProbe = Number.NEGATIVE_INFINITY;

  constructor(private readonly deps: { now(): number }) {}

  controlEnabled(): void {
    this.controlAt = this.deps.now();
  }

  /** Returns whether access should be probed again for this observation. */
  relayOnly(deviceIds: readonly string[]): boolean {
    const next = [...new Set(deviceIds)].sort();
    const added = next.some((id) => !this.relay.includes(id));
    this.relay = next;
    if (next.length === 0) return false;
    const now = this.deps.now();
    if (!added && now - this.lastRelayProbe < RELAY_PROBE_INTERVAL_MS) return false;
    this.lastRelayProbe = now;
    return true;
  }

  /** When the control reminder stops applying, so the owner can push the change at that moment. */
  controlExpiresAt(): number | null {
    if (this.controlAt === null) return null;
    const at = this.controlAt + CONTROL_REMINDER_MS;
    return at > this.deps.now() ? at : null;
  }

  current(access: LocalNetworkAccess): LocalNetworkReminder | null {
    if (access !== 'denied') return null;
    if (this.controlAt !== null && this.deps.now() - this.controlAt < CONTROL_REMINDER_MS) {
      return { reason: 'controlEnabled', at: this.controlAt, deviceIds: [...this.relay] };
    }
    if (this.relay.length) return { reason: 'relayOnly', deviceIds: [...this.relay] };
    return null;
  }
}
