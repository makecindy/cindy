import type { GrokLoginState } from '@cindy/mcps';
import { activeOwnerScopeKey, isAppSessionBoundaryPending } from '../appSessionState.js';
import {
  hasGrokOAuthLogin,
  isGrokOAuthLoginInProgress,
  runGrokOAuthLogin,
  type GrokDeviceCode,
} from './grok-oauth-login.js';

interface Flight {
  owner: string;
  abort: AbortController;
  state: GrokLoginState;
  codeReady: Promise<GrokLoginState>;
}

let flight: Flight | null = null;
let onConnected: ((owner: string) => Promise<void>) | null = null;

/** Registered by the Desktop bootstrap, which owns provider cache reconciliation. */
export function setGrokDeviceLoginConnectedHandler(
  handler: (owner: string) => Promise<void>,
): void {
  onConnected = handler;
}

function currentOwner(): string | null {
  return isAppSessionBoundaryPending() ? null : activeOwnerScopeKey();
}

/** A single Host-owned flight is shared by every agent and window for the current owner. */
export async function startGrokDeviceLogin(): Promise<GrokLoginState> {
  const owner = currentOwner();
  if (!owner) throw new Error('Owner unavailable');
  if (hasGrokOAuthLogin()) return { status: 'connected' };
  if (
    flight?.owner === owner &&
    (flight.state.status === 'pending' || flight.state.status === 'idle')
  )
    return flight.codeReady;
  if (isGrokOAuthLoginInProgress()) throw new Error('Another Grok login is active');

  let reportCode!: (state: GrokLoginState) => void;
  const codeReady = new Promise<GrokLoginState>((resolve) => {
    reportCode = resolve;
  });
  const next: Flight = { owner, abort: new AbortController(), state: { status: 'idle' }, codeReady };
  flight = next;
  void runGrokOAuthLogin({
    method: 'device',
    cancellationSignal: next.abort.signal,
    onDeviceCode: (code: GrokDeviceCode) => {
      if (flight !== next || currentOwner() !== owner) return;
      next.state = {
        status: 'pending',
        verificationUrl: code.verificationUrl,
        userCode: code.userCode,
        expiresAt: code.expiresAt,
      };
      reportCode(next.state);
    },
  }).then(
    async (result) => {
      if (flight !== next || currentOwner() !== owner) {
        reportCode({ status: 'failed', reason: 'cancelled' });
        return;
      }
      if (result.ok) {
        next.state = { status: 'connected' };
        try {
          await onConnected?.(owner);
        } catch {
          /* login is already persisted */
        }
      } else {
        next.state = {
          status: 'failed',
          reason:
            result.reason === 'timeout'
              ? 'expired'
              : result.reason === 'access_denied'
                ? 'denied'
                : result.reason === 'login_cancelled'
                  ? 'cancelled'
                  : 'error',
        };
      }
      reportCode(next.state);
    },
    () => {
      next.state = { status: 'failed', reason: 'error' };
      reportCode(next.state);
    },
  );
  return codeReady;
}

export function grokDeviceLoginStatus(): GrokLoginState {
  const owner = currentOwner();
  if (!owner) return { status: 'idle' };
  if (hasGrokOAuthLogin()) return { status: 'connected' };
  return flight?.owner === owner ? flight.state : { status: 'idle' };
}

export function cancelGrokDeviceLogin(): GrokLoginState {
  if (flight?.owner !== currentOwner() || !['idle', 'pending'].includes(flight.state.status))
    return grokDeviceLoginStatus();
  flight.abort.abort();
  flight.state = { status: 'failed', reason: 'cancelled' };
  return flight.state;
}
