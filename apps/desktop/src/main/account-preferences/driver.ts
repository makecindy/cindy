/** Full small snapshots converge after edits, peer presence and reconnect, without replaying commands. */
import {
  parseAccountPreferencesSyncFrame,
  type AccountPreferencesState,
  type AccountPreferencesSyncFrame,
} from '@cindy/device-link';
import {
  activeOwnerScopeKey,
  getActiveAppSession,
  isAppSessionBoundaryPending,
  onAppSessionInvalidated,
} from '../appSessionState.js';
import { createLogger } from '../logger.js';
import {
  loadAccountPreferencesSnapshot,
  mergeAccountPreferencesSyncState,
  onAccountPreferencesChanged,
  readAccountPreferencesSyncState,
} from './store.js';

export interface AccountPreferencesSyncTransport {
  /** Already-authenticated same-account peers only; scoped sharing/guest peers must be excluded. */
  peers(): string[];
  /** Recheck revocation and current transport authority at the actual send/receive edge. */
  allowed(deviceId: string): boolean;
  send(deviceId: string, frame: AccountPreferencesSyncFrame): void;
}

export interface AccountPreferencesSyncDependencies {
  owner(): { dataOwnerId: string | null; scope: string; enabled: boolean };
  readState(): AccountPreferencesState;
  mergeState(state: AccountPreferencesState, isSourceCurrent: () => boolean): Promise<boolean>;
  subscribe(listener: () => void): () => void;
  /** Hold initial outgoing snapshots until the one-time renderer legacy import is settled. */
  canSendState?(): boolean;
  onInvalidated?(listener: () => void): () => void;
  reportError?(): void;
}

const CHANGE_DEBOUNCE_MS = 150;
const RECONCILE_INTERVAL_MS = 30 * 60 * 1000;

export function createAccountPreferencesSyncDriver(deps: AccountPreferencesSyncDependencies) {
  let transport: AccountPreferencesSyncTransport | null = null;
  let generation = 0;
  let changeTimer: ReturnType<typeof setTimeout> | undefined;
  let reconcileTimer: ReturnType<typeof setInterval> | undefined;
  let unsubscribe: (() => void) | undefined;
  let unsubscribeInvalidation: (() => void) | undefined;

  function current(scope: string, epoch: number): boolean {
    const owner = deps.owner();
    return transport !== null && generation === epoch && owner.enabled && owner.scope === scope;
  }

  function send(deviceId: string, requestReply = false): void {
    const activeTransport = transport;
    const epoch = generation;
    const owner = deps.owner();
    if (!activeTransport || !owner.enabled || !owner.dataOwnerId || !activeTransport.allowed(deviceId)) return;
    try {
      if (deps.canSendState && !deps.canSendState()) return;
      const frame: AccountPreferencesSyncFrame = {
        version: 1, dataOwnerId: owner.dataOwnerId, state: deps.readState(),
        ...(requestReply ? { requestReply: true } : {}),
      };
      if (!parseAccountPreferencesSyncFrame(frame) || !current(owner.scope, epoch)
        || activeTransport !== transport || !activeTransport.allowed(deviceId)) return;
      activeTransport.send(deviceId, frame);
    } catch { deps.reportError?.(); }
  }

  function broadcastNow(): void {
    if (changeTimer) clearTimeout(changeTimer);
    changeTimer = undefined;
    for (const peer of transport?.peers() ?? []) send(peer, true);
  }

  function stop(): void {
    generation += 1;
    transport = null;
    if (changeTimer) clearTimeout(changeTimer);
    if (reconcileTimer) clearInterval(reconcileTimer);
    changeTimer = undefined;
    reconcileTimer = undefined;
    unsubscribe?.();
    unsubscribeInvalidation?.();
    unsubscribe = undefined;
    unsubscribeInvalidation = undefined;
  }

  function connect(next: AccountPreferencesSyncTransport): void {
    stop();
    transport = next;
    const scope = deps.owner().scope;
    const epoch = generation;
    unsubscribe = deps.subscribe(() => {
      if (!current(scope, epoch)) return;
      if (changeTimer) clearTimeout(changeTimer);
      changeTimer = setTimeout(() => {
        changeTimer = undefined;
        if (current(scope, epoch)) broadcastNow();
      }, CHANGE_DEBOUNCE_MS);
      changeTimer.unref?.();
    });
    unsubscribeInvalidation = deps.onInvalidated?.(stop);
    reconcileTimer = setInterval(() => {
      if (current(scope, epoch)) broadcastNow();
    }, RECONCILE_INTERVAL_MS);
    reconcileTimer.unref?.();
    broadcastNow();
  }

  async function receive(deviceId: string, payload: unknown): Promise<void> {
    const activeTransport = transport;
    const epoch = generation;
    const owner = deps.owner();
    if (!activeTransport || !owner.enabled || !owner.dataOwnerId || !activeTransport.allowed(deviceId)) return;
    const frame = parseAccountPreferencesSyncFrame(payload);
    if (!frame || frame.dataOwnerId !== owner.dataOwnerId) return;
    try {
      const changed = await deps.mergeState(frame.state, () => current(owner.scope, epoch)
        && activeTransport === transport && activeTransport.allowed(deviceId));
      if (!current(owner.scope, epoch) || activeTransport !== transport || !activeTransport.allowed(deviceId)) return;
      // A reply never requests another reply. A duplicate snapshot therefore stops in one round trip.
      if (changed || frame.requestReply === true) send(deviceId);
    } catch { deps.reportError?.(); }
  }

  return { connect, stop, broadcastNow, receive, peerOnline: (deviceId: string) => send(deviceId, true) };
}

const log = createLogger('account-preferences:sync');
export const accountPreferencesSyncDriver = createAccountPreferencesSyncDriver({
  owner: () => {
    const session = getActiveAppSession();
    return {
      dataOwnerId: session.dataOwnerId,
      scope: activeOwnerScopeKey(),
      enabled: session.mode === 'cloud' && !!session.dataOwnerId && !isAppSessionBoundaryPending(),
    };
  },
  readState: readAccountPreferencesSyncState,
  mergeState: mergeAccountPreferencesSyncState,
  subscribe: listener => onAccountPreferencesChanged(listener),
  canSendState: () => !loadAccountPreferencesSnapshot().legacyImportAllowed,
  onInvalidated: onAppSessionInvalidated,
  reportError: () => log.warn('account preference exchange failed; the next exchange will reconcile'),
});
