import type { Session } from '@cindy/maker-core';
import { getCurrentDbClientSnapshot } from '../localDb/client/current.js';
import { throwIpcError } from '../utils/ipcValidate.js';

/** Account-local revisions bridge async persistence and the final synchronous provider call. */
interface PermissionRevision {
  revision: number;
  pending: number;
  changes: Promise<void>;
}
const revisions = new WeakMap<object, Map<string, PermissionRevision>>();

function revisionFor(owner: object, botId: string): PermissionRevision {
  let bots = revisions.get(owner);
  if (!bots) { bots = new Map(); revisions.set(owner, bots); }
  let state = bots.get(botId);
  if (!state) {
    state = { revision: 0, pending: 0, changes: Promise.resolve() };
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
  finally { state.pending--; }
}

export async function withBotPermissionChange<T>(
  sessionId: string,
  change: () => Promise<T>,
): Promise<T> {
  const owner = getCurrentDbClientSnapshot();
  if (!owner) return change();
  const [link] = await owner.client.query<{ botId: string }>(`SELECT bot_id AS botId FROM bot_session_links
    WHERE session_id = ? AND role IN ('canonical', 'channel', 'group', 'thread') AND archived_at IS NULL`, [sessionId]);
  if (owner !== getCurrentDbClientSnapshot()) throwIpcError('PRECONDITION_FAILED', 'Account changed during permission update');
  return link ? withBotPermissionChangeForBot(link.botId, change) : change();
}

/** Reject overlapping edits without waiting under a send fence; recheck again after preparation. */
export async function prepareBotPermissionDispatch(session: Session): Promise<() => void> {
  const owner = getCurrentDbClientSnapshot();
  if (!owner) return () => {};
  const [link] = await owner.client.query<{ botId: string }>(`SELECT l.bot_id AS botId FROM bot_session_links l
    JOIN sessions s ON s.id = l.session_id WHERE l.session_id = ?
    AND l.role IN ('canonical', 'channel', 'group', 'thread') AND l.archived_at IS NULL
    AND s.source = 'bot' AND s.status = 'active'`, [session.id]);
  if (owner !== getCurrentDbClientSnapshot()) throwIpcError('PRECONDITION_FAILED', 'Account changed before dispatch');
  if (!link) return () => {};
  const state = revisionFor(owner, link.botId);
  for (;;) {
    if (owner !== getCurrentDbClientSnapshot()) throwIpcError('PRECONDITION_FAILED', 'Account changed before dispatch');
    // Dispatch may already own the send fence that a permission writer needs
    // for a runtime restart. Waiting for that writer here would deadlock.
    if (state.pending) throwIpcError('PRECONDITION_FAILED', 'Bot permissions are changing before dispatch');
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
    if (state.pending) throwIpcError('PRECONDITION_FAILED', 'Bot permissions are changing before dispatch');
    if (state.revision !== revision) continue;
    return () => {
      if (owner !== getCurrentDbClientSnapshot() || state.pending || state.revision !== revision
        || !row || session.stablePermissionModeState?.mode !== row.mode) {
        throwIpcError('PRECONDITION_FAILED', 'Bot permissions changed before dispatch');
      }
    };
  }
}
