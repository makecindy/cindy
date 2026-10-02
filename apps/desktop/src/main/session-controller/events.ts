import { tapWindowBroadcast } from '../device-link/broadcast-tap.js';
import { SESSION_CONTROL_CHANGED } from './signals.js';

/** Called only at existing authoritative input boundaries, never on RPC success.
 * Payloads are invalidations with correlation IDs, not another event/state store. */
export function publishSessionInputChange(sessionId: string, inputId: string,
  kind: 'input-accepted' | 'input-dispatched' | 'input-withdrawn'): void {
  tapWindowBroadcast(SESSION_CONTROL_CHANGED, { sessionId, inputId, kind });
}
