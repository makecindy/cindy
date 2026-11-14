import type { Session } from '@cindy/maker-core';
import { createIpcError } from '../../shared/ipc-errors.js';
import { getCurrentDbClientSnapshot } from '../localDb/client/current.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import { isSendToSessionLockHeldByCurrentCall } from './sendToSessionLock.js';

/** Account-local revisions bridge async persistence and the final synchronous provider call. */
interface PermissionRevision {
  revision: number;
  pending: number;
  failures: number;
  changes: Promise<void>;
}
const revisions = new WeakMap<object, Map<string, PermissionRevision>>();
// Only an error emitted by the local pre-provider guard is retryable. Neither
// IPC error text nor a provider's PRECONDITION_FAILED is evidence of non-dispatch.
const undispatched = new WeakMap<object, {
  owner: NonNullable<ReturnType<typeof getCurrentDbClientSnapshot>>;
  state: PermissionRevision;
  sessionId: string;
  botId: string;
  failures: number;
}>();

function rejectChangingPermission(
  receipt: NonNullable<ReturnType<typeof undispatched.get>>,
  message: string,
): never {
  const error = createIpcError('PRECONDITION_FAILED', message);
  undispatched.set(error, receipt);
  throw error;
}

/** Welcome-only recovery; the caller must release its send fence before retrying. */
export async function retryBotWelcomePermissionDispatch<T>(
  sessionId: string,
  signal: AbortSignal | undefined,
  send: () => Promise<T>,
  canRetry: () => boolean,
  onUndispatchedRetry?: () => void,
): Promise<T> {
  try { return await send(); }
  catch (error) {
    const receipt = error && typeof error === 'object' ? undispatched.get(error) : undefined;
    if (!receipt || receipt.sessionId !== sessionId || !signal || signal.aborted
      || receipt.owner !== getCurrentDbClientSnapshot()
      || isSendToSessionLockHeldByCurrentCall(sessionId) || !canRetry()) throw error;
    undispatched.delete(error as object);
    onUndispatchedRetry?.();
    // The failed send has released its fence and reservation. A writer may now
    // restart the runtime. Stop/clear cancels this wait; a stuck writer or repeated
    // edits must eventually return the original, traceable failure to the queue.
    await new Promise<void>((resolve, reject) => {
      const done = (failure?: unknown) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        if (failure) reject(failure); else resolve();
      };
      const abort = () => done(error);
      const timer = setTimeout(() => done(error), 5_000);
      signal.addEventListener('abort', abort, { once: true });
      void receipt.state.changes.then(() => done(), () => done(error));
    });
    if (signal.aborted || receipt.state.failures !== receipt.failures
      || receipt.owner !== getCurrentDbClientSnapshot() || !canRetry()) throw error;
    const [active] = await receipt.owner.client.query(`SELECT 1 FROM bot_session_links l
      JOIN sessions s ON s.id = l.session_id JOIN bot_profiles p ON p.id = l.bot_id
      JOIN bot_profile_versions v ON v.bot_id = p.id AND v.version = p.current_version
      WHERE l.session_id = ? AND l.bot_id = ? AND l.archived_at IS NULL
      AND l.role IN ('canonical', 'channel', 'group', 'thread', 'routine')
      AND s.source = 'bot' AND s.status = 'active' AND p.status = 'active'`, [sessionId, receipt.botId]);
    if (!active || signal.aborted || receipt.state.failures !== receipt.failures
      || receipt.owner !== getCurrentDbClientSnapshot() || !canRetry()) throw error;
    // Re-enter the ordinary send entry (including permission reconciliation and
    // a fresh final guard), retaining the same queue item, UUID and tool policy.
    // Deliberately outside the catch: a second race is not retried indefinitely.
    return send();
  }
}

function revisionFor(owner: object, botId: string): PermissionRevision {
  let bots = revisions.get(owner);
  if (!bots) { bots = new Map(); revisions.set(owner, bots); }
  let state = bots.get(botId);
  if (!state) {
    state = { revision: 0, pending: 0, failures: 0, changes: Promise.resolve() };
    bots.set(botId, state);
  }
  return state;
}

export async function withBotPermissionChangeForBot<T>(
  botId: string,
  change: () => Promise<T>,
): Promise<T> {
  const owner = getCurrentDbClientSnapshot();
  if (!owner) return change();
  const state = revisionFor(owner, botId);
  state.pending++;
  state.revision++;
  const run = () => {
    if (owner !== getCurrentDbClientSnapshot()) throwIpcError('PRECONDITION_FAILED', 'Account changed during permission update');
    return change();
  };
  // Explicit edits from different lanes must share one commit order. Automatic
  // repairs keep canonical/Profile authority unchanged and do not enter this queue.
  const operation = state.changes.then(run);
  state.changes = operation.then(() => undefined, () => undefined);
  try { return await operation; }
  catch (error) { state.failures++; throw error; }
  finally { state.pending--; }
}

export async function withBotPermissionChange<T>(
  sessionId: string,
  change: () => Promise<T>,
): Promise<T> {
  const owner = getCurrentDbClientSnapshot();
  if (!owner) return change();
  const [link] = await owner.client.query<{ botId: string }>(`SELECT bot_id AS botId FROM bot_session_links
    WHERE session_id = ? AND role IN ('canonical', 'channel', 'group', 'thread', 'routine') AND archived_at IS NULL`, [sessionId]);
  if (owner !== getCurrentDbClientSnapshot()) throwIpcError('PRECONDITION_FAILED', 'Account changed during permission update');
  return link ? withBotPermissionChangeForBot(link.botId, change) : change();
}

/** Reject overlapping edits without waiting under a send fence; recheck again after preparation. */
export async function prepareBotPermissionDispatch(session: Session): Promise<() => void> {
  const owner = getCurrentDbClientSnapshot();
  if (!owner) return () => {};
  const [link] = await owner.client.query<{ botId: string }>(`SELECT l.bot_id AS botId FROM bot_session_links l
    JOIN sessions s ON s.id = l.session_id WHERE l.session_id = ?
    AND l.role IN ('canonical', 'channel', 'group', 'thread', 'routine') AND l.archived_at IS NULL
    AND s.source = 'bot' AND s.status = 'active'`, [session.id]);
  if (owner !== getCurrentDbClientSnapshot()) throwIpcError('PRECONDITION_FAILED', 'Account changed before dispatch');
  if (!link) return () => {};
  const state = revisionFor(owner, link.botId);
  const receipt = { owner, state, sessionId: session.id, botId: link.botId, failures: state.failures };
  for (;;) {
    if (owner !== getCurrentDbClientSnapshot()) throwIpcError('PRECONDITION_FAILED', 'Account changed before dispatch');
    // Dispatch may already own the send fence that a permission writer needs
    // for a runtime restart. Waiting for that writer here would deadlock.
    if (state.pending) rejectChangingPermission(receipt, 'Bot permissions are changing before dispatch');
    const revision = state.revision;
    // A saved lane may itself be the stale snapshot under repair. Read the
    // authoritative canonical/Profile value, so repairs need no dispatch fence
    // and concurrent ordinary sends do not invalidate one another.
    const [row] = await owner.client.query<{ mode: string }>(`SELECT CASE
      WHEN c.permission_mode IN ('ask', 'auto', 'bypassPermissions') THEN c.permission_mode
      WHEN l.role = 'canonical' THEN s.permission_mode
      ELSE CASE json_extract(v.capabilities_json, '$.permissions')
        WHEN 'trusted' THEN 'bypassPermissions' WHEN 'auto' THEN 'auto' ELSE 'ask' END END AS mode
      FROM bot_session_links l JOIN sessions s ON s.id = l.session_id
      JOIN bot_profiles p ON p.id = l.bot_id
      JOIN bot_profile_versions v ON v.bot_id = p.id AND v.version = p.current_version
      LEFT JOIN bot_session_links cl ON cl.bot_id = p.id AND cl.role = 'canonical' AND cl.archived_at IS NULL
      LEFT JOIN sessions c ON c.id = cl.session_id AND c.source = 'bot' AND c.status = 'active'
      WHERE l.session_id = ? AND l.archived_at IS NULL AND s.status = 'active' AND p.status = 'active'`, [session.id]);
    if (state.pending) rejectChangingPermission(receipt, 'Bot permissions are changing before dispatch');
    if (state.revision !== revision) continue;
    return () => {
      if (owner !== getCurrentDbClientSnapshot() || !row) {
        throwIpcError('PRECONDITION_FAILED', 'Bot permissions changed before dispatch');
      }
      if (state.pending || state.revision !== revision || session.stablePermissionModeState?.mode !== row.mode) {
        rejectChangingPermission(receipt, 'Bot permissions changed before dispatch');
      }
    };
  }
}
