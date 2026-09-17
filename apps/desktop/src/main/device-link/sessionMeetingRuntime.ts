import { SESSION_MEETING_CAPABILITY, type DeviceLinkClient } from '@cindy/device-link';
import { getCurrentDbClientSnapshot } from '../localDb/client/current.js';
import { createSessionMeetingJournal } from '../localDb/sessionMeetings.js';
import { activeOwnerScopeKey, getActiveAppSession, isAppSessionBoundaryPending } from '../appSessionState.js';
import { getAuthState, getCurrentUserId, getDeviceId, getActiveAuthRealm } from '../authManager.js';
import { createLogger } from '../logger.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import { captureSessionMeetingBoundaryClose, sessionMeetingApi } from './sessionMeetingApi.js';
import { SessionMeetingHost, type SessionMeetingCreationState } from './sessionMeetingHost.js';
import { setSessionMeetingDispatchHost } from './sessionMeetingDispatch.js';

const log = createLogger('session-meeting');
interface Binding {
  host: SessionMeetingHost;
  stop(): Promise<void>;
  dbEpoch: number;
  database: object;
  creationState: SessionMeetingCreationState;
  ownerAccountId: string;
  region: ReturnType<typeof getActiveAuthRealm>;
  current(): boolean;
  rebindIfStable(): void;
}
let binding: Binding | null = null;
let generation = 0;

/** Binds verified authority to one relay owner, account, region and profile database. */
export function startSessionMeetingRuntime(options: {
  client: DeviceLinkClient;
  revoke(meetingId: string, memberId?: string): void;
  changed(meetingId: string): void;
}): void {
  const previous = binding;
  void previous?.stop().catch((error) => log.warn('meeting runtime disposal failed', error));
  const db = getCurrentDbClientSnapshot();
  const ownerAccountId = getCurrentUserId();
  if (!db || !ownerAccountId) return;
  const epoch = ++generation;
  const scope = activeOwnerScopeKey();
  const region = getActiveAuthRealm();
  const creationState = previous?.database === db.client && previous.dbEpoch === db.clientEpoch &&
    previous.ownerAccountId === ownerAccountId && previous.region === region
    ? previous.creationState : { pending: new Map(), identities: new Map() };
  let stopped = false;
  let preservePeerLinks = false;
  const current = () => !stopped && generation === epoch && getAuthState().isAuthenticated &&
    getCurrentUserId() === ownerAccountId &&
    !isAppSessionBoundaryPending() && activeOwnerScopeKey() === scope && getActiveAuthRealm() === region &&
    getCurrentDbClientSnapshot()?.clientEpoch === db.clientEpoch;
  const host = new SessionMeetingHost({
    api: sessionMeetingApi, journal: createSessionMeetingJournal(db.client),
    ownerAccountId, hostDeviceId: getDeviceId(), creationState, isCurrent: current,
    async readSession(sessionId) {
      const rows = await db.client.query<{ id: string; title: string; status: string }>(
        'SELECT id, title, status FROM sessions WHERE id = ? LIMIT 1', [sessionId]);
      return rows[0] ?? null;
    },
    revoke: (meetingId, memberId) => {
      // A stable projection recommit replaces authority captures, not members.
      // Sending a permanent 'revoked' close here would strand valid guests.
      if (!preservePeerLinks) options.revoke(meetingId, memberId);
    },
    changed: options.changed,
  });
  let refreshing = false;
  // A same-account stable projection can advance its generation without
  // transferring the relay lease. Retire the old Host rather than relaxing
  // its captured scope, so already-admitted callbacks remain invalid forever.
  const rebindIfStable = () => {
    if (stopped || generation !== epoch || binding?.host !== host || current() ||
        isAppSessionBoundaryPending() || !getAuthState().isAuthenticated ||
        getCurrentUserId() !== ownerAccountId || getActiveAuthRealm() !== region) return;
    const active = getActiveAppSession();
    const latestDb = getCurrentDbClientSnapshot();
    if (active.mode !== 'cloud' || active.dataOwnerId !== ownerAccountId ||
        latestDb?.client !== db.client || latestDb.clientEpoch !== db.clientEpoch ||
        activeOwnerScopeKey() === scope) return;
    preservePeerLinks = true;
    startSessionMeetingRuntime(options);
  };
  const refresh = async () => {
    if (!current()) { rebindIfStable(); return; }
    if (refreshing || !current() || !options.client.hasServerCapability(SESSION_MEETING_CAPABILITY) ||
        options.client.getStatus() !== 'online') return;
    refreshing = true;
    try { await host.restore(); }
    catch { if (current()) log.debug('meeting authority refresh unavailable; retrying on next tick'); }
    finally { refreshing = false; }
  };
  const timer = setInterval(() => { void refresh(); }, 5_000);
  timer.unref?.();
  binding = { host, dbEpoch: db.clientEpoch, database: db.client, creationState, ownerAccountId, region, current, rebindIfStable, stop() {
    stopped = true;
    clearInterval(timer);
    if (binding?.host === host) setSessionMeetingDispatchHost(null);
    return host.dispose();
  } };
  setSessionMeetingDispatchHost(host);
  void refresh();
}

/** Ordinary process/relay ownership loss revokes live access but preserves membership. */
export function stopSessionMeetingRuntime(): Promise<void> {
  return binding?.stop() ?? Promise.resolve();
}

export function requireSessionMeetingHost(): SessionMeetingHost {
  binding?.rebindIfStable();
  if (!binding?.current()) throwIpcError('PRECONDITION_FAILED', 'Meeting host is unavailable');
  return binding.host;
}

/** Must be awaited before disposing the outgoing profile; disk failure aborts handover. */
export async function closeSessionMeetingsBeforeLogout(): Promise<void> {
  const outgoing = binding;
  if (!outgoing || outgoing.dbEpoch !== getCurrentDbClientSnapshot()?.clientEpoch) return;
  const close = captureSessionMeetingBoundaryClose(outgoing.ownerAccountId, outgoing.region);
  const ids = await outgoing.host.closeLocallyForBoundary();
  await outgoing.stop();
  // Journal first; offline/expired credentials leave a durable retry for restore.
  // Close concurrently under a bounded old-identity request before logout returns.
  if (close) {
    const results = await Promise.allSettled(ids.map((id) => close(id)));
    if (results.some((result) => result.status === 'rejected')) {
      log.debug('meeting boundary closure pending; retained journal for retry');
    }
  }
}

/** Terminal task state is durable before this runs; never reopen it on a later restore. */
export async function closeSessionMeetingForTask(sessionId: string, database: unknown): Promise<void> {
  if (getCurrentDbClientSnapshot()?.client !== database) return;
  if (!binding || binding.dbEpoch !== getCurrentDbClientSnapshot()?.clientEpoch) return;
  const ids = await binding.host.closeLocallyForBoundary(sessionId);
  // Network failure is retried from the terminal journal; never undo the task archive.
  for (const id of ids) void sessionMeetingApi.close(id).catch(() => undefined);
}
