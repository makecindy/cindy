import { throwIpcError } from '../utils/ipcValidate.js';
import {
  CINDY_MAKE_SESSION_SOURCE,
  CINDY_MAKE_VENDOR_OPTION_KEY,
} from '../../shared/cindyMakeSession.js';

export interface CindyMakeStartOptions {
  id?: string;
  remoteHostId?: string | null;
  vendorOptions?: Record<string, unknown>;
}

/**
 * The Cindy Make purpose is persisted by `sessions.source`, never trusted from
 * whichever renderer reconstructs CreateOpts. Every local create/resume funnel
 * passes bootstrapSession, so hydrating the marker there makes the three
 * harness gates (Claude registration, Pi server list, Codex thread config) and
 * the tool's own call-time check all read the same fact.
 */
export async function applyPersistedCindyMakeMarker(
  o: CindyMakeStartOptions,
  readSource: (sessionId: string) => Promise<string | null>,
): Promise<boolean> {
  if (typeof o.id !== 'string' || !o.id) return false;
  if ((await readSource(o.id)) !== CINDY_MAKE_SESSION_SOURCE) return false;
  if (o.remoteHostId) {
    throwIpcError('UNSUPPORTED_CAPABILITY', 'Cindy Make tasks are local-only');
  }
  o.vendorOptions = { ...(o.vendorOptions ?? {}), [CINDY_MAKE_VENDOR_OPTION_KEY]: true };
  return true;
}
