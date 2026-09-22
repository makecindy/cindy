import { SHARED_TASK_CAPABILITY, type DeviceLinkClient } from '@cindy/device-link';
import { getCurrentDbClientSnapshot } from '../localDb/client/current.js';
import {
  closeSharedTasksInJournalForSession,
  createSharedTaskJournal,
  prepareSharedTasksForSession,
  rollbackPreparedSharedTasks,
  finalizePreparedSharedTasks,
  type PreparedSharedTaskClosure,
} from '../localDb/sharedTasks.js';
import { activeOwnerScopeKey, getActiveAppSession, isAppSessionBoundaryPending } from '../appSessionState.js';
import { getAuthState, getCurrentUserId, getDeviceId, getActiveAuthRealm } from '../authManager.js';
import { createLogger } from '../logger.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import { captureSharedTaskBoundaryClose, sharedTaskApi } from './sharedTaskApi.js';
import { SharedTaskHost, type SharedTaskCreationState } from './sharedTaskHost.js';
import { setSharedTaskDispatchHost } from './sharedTaskDispatch.js';

const log = createLogger('shared-task');
interface Binding {
  host: SharedTaskHost;
  stop(): Promise<void>;
  dbEpoch: number;
  database: object;
  creationState: SharedTaskCreationState;
  ownerAccountId: string;
  region: ReturnType<typeof getActiveAuthRealm>;
  current(): boolean;
  rebindIfStable(): void;
}
let binding: Binding | null = null;
let generation = 0;

/** Binds verified authority to one relay owner, account, region and profile database. */
export function startSharedTaskRuntime(options: {
  client: DeviceLinkClient;
  revoke(sharedTaskId: string, memberId?: string): void;
  changed(sharedTaskId: string): void;
}): void {
  const previous = binding;
  void previous?.stop().catch((error) => log.warn('sharedTask runtime disposal failed', error));
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
  const host = new SharedTaskHost({
    api: sharedTaskApi, journal: createSharedTaskJournal(db.client),
    ownerAccountId, hostDeviceId: getDeviceId(), creationState, isCurrent: current,
    async readSession(sessionId) {
      const rows = await db.client.query<{ id: string; title: string; status: string }>(
        'SELECT id, title, status FROM sessions WHERE id = ? LIMIT 1', [sessionId]);
      return rows[0] ?? null;
    },
    revoke: (sharedTaskId, memberId) => {
      // A stable projection recommit replaces authority captures, not members.
      // Sending a permanent 'revoked' close here would strand valid guests.
      if (!preservePeerLinks) options.revoke(sharedTaskId, memberId);
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
    startSharedTaskRuntime(options);
  };
  const refresh = async () => {
    if (!current()) { rebindIfStable(); return; }
    if (refreshing || !current()) return;
    refreshing = true;
    try {
      // Local terminal records must revoke captures even while HTTP/relay is down.
      await host.restore(options.client.hasServerCapability(SHARED_TASK_CAPABILITY) &&
        options.client.getStatus() === 'online');
    }
    catch { if (current()) log.debug('sharedTask authority refresh unavailable; retrying on next tick'); }
    finally { refreshing = false; }
  };
  const timer = setInterval(() => { void refresh(); }, 5_000);
  timer.unref?.();
  binding = { host, dbEpoch: db.clientEpoch, database: db.client, creationState, ownerAccountId, region, current, rebindIfStable, stop() {
    stopped = true;
    clearInterval(timer);
    if (binding?.host === host) setSharedTaskDispatchHost(null);
    return host.dispose();
  } };
  setSharedTaskDispatchHost(host);
  void refresh();
}

/** Ordinary process/relay ownership loss revokes live access but preserves membership. */
export function stopSharedTaskRuntime(): Promise<void> {
  return binding?.stop() ?? Promise.resolve();
}

export function requireSharedTaskHost(): SharedTaskHost {
  binding?.rebindIfStable();
  if (!binding?.current()) throwIpcError('PRECONDITION_FAILED', 'SharedTask host is unavailable');
  return binding.host;
}

/** Must be awaited before disposing the outgoing profile; disk failure aborts handover. */
export async function closeSharedTasksBeforeLogout(): Promise<void> {
  const outgoing = binding;
  if (!outgoing || outgoing.dbEpoch !== getCurrentDbClientSnapshot()?.clientEpoch) return;
  const close = captureSharedTaskBoundaryClose(outgoing.ownerAccountId, outgoing.region);
  const ids = await outgoing.host.closeLocallyForBoundary();
  await outgoing.stop();
  // Journal first; offline/expired credentials leave a durable retry for restore.
  // Close concurrently under a bounded old-identity request before logout returns.
  if (close) {
    const results = await Promise.allSettled(ids.map((id) => close(id)));
    if (results.some((result) => result.status === 'rejected')) {
      log.debug('sharedTask boundary closure pending; retained journal for retry');
    }
  }
}

/** Terminal task state is durable before this runs; never reopen it on a later restore. */
export async function closeSharedTaskForTask(sessionId: string, database: unknown): Promise<void> {
  const db = getCurrentDbClientSnapshot();
  if (!db || db.client !== database) return;
  const outgoing = binding?.database === db.client && binding.dbEpoch === db.clientEpoch ? binding : null;
  // Capture before any await: old-profile cleanup must never use a new account.
  const ownerAccountId = getCurrentUserId();
  const close = ownerAccountId ? captureSharedTaskBoundaryClose(ownerAccountId, getActiveAuthRealm()) : null;
  const localIds = outgoing ? await outgoing.host.closeLocallyForBoundary(sessionId) : [];
  const ids = new Set([...localIds, ...await closeSharedTasksInJournalForSession(db.client, sessionId)]);
  // Network failure is retried from the terminal journal; never undo the task archive.
  if (close) await Promise.allSettled([...ids].map((id) => close(id)));
}

/** Persist a terminal close fence before the session status is changed. */
export async function prepareSharedTaskClosureForTask(
  sessionId: string,
  database: unknown,
): Promise<PreparedSharedTaskClosure | null> {
  const db = getCurrentDbClientSnapshot();
  if (!db || db.client !== database) return null;
  return prepareSharedTasksForSession(db.client, sessionId);
}

/** Compensate a prepare when the corresponding terminal status write aborts. */
export async function rollbackPreparedSharedTaskClosure(
  database: unknown,
  prepared: PreparedSharedTaskClosure | null,
): Promise<void> {
  if (!prepared) return;
  // Rollback must use the captured profile DB even if the account boundary
  // advanced while the terminal status write was being rejected.
  if (!database || typeof (database as { exec?: unknown }).exec !== 'function') return;
  await rollbackPreparedSharedTasks(database as Parameters<typeof rollbackPreparedSharedTasks>[0], prepared);
}

/** Promote a prepared close intent only after the session status is durable. */
export async function finalizePreparedSharedTaskClosure(
  database: unknown,
  prepared: PreparedSharedTaskClosure | null,
): Promise<void> {
  if (!prepared || !database || typeof (database as { exec?: unknown }).exec !== 'function') return;
  await finalizePreparedSharedTasks(database as Parameters<typeof finalizePreparedSharedTasks>[0], prepared);
}
