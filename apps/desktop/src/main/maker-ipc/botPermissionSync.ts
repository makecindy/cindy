import type { PermissionMode } from '@cindy/maker-core';
import { getCurrentDbClientSnapshot } from '../localDb/client/current.js';
import { broadcastSessionPatched } from '../localDb/ipc/sessions.js';
import { getMakerIfReady } from '../maker-host/index.js';
import { forgetCredentialGrants } from '../remote-agent/executor/credentialGrants.js';
import { withSessionPermissionChange } from './sessionPermissionChange.js';

/** Follow committed values under the same fence as explicit permission changes. */
export async function syncBotLanePermission(sessionId: string): Promise<void> {
  const owner = getCurrentDbClientSnapshot();
  if (!owner) return;
  let repairedCanonicalSessionId: string | undefined;
  try {
    await withSessionPermissionChange(sessionId, async () => {
      const assertCurrent = () => {
        if (getCurrentDbClientSnapshot() !== owner) throw new Error('Account changed during lane permission update');
      };
      assertCurrent();
      let saved: { mode: string | null; changed: boolean; canonicalSessionId?: string };
      try {
        saved = await owner.client.tx('bots.reconcileLanePermission', { sessionId });
      } catch (error) {
        assertCurrent();
        const maker = getMakerIfReady();
        if (maker?.getSession(sessionId)) await maker.closeSession(sessionId);
        throw error;
      }
      const { mode, changed } = saved;
      assertCurrent();
      repairedCanonicalSessionId = saved.canonicalSessionId;
      if (!mode) return;
      const maker = getMakerIfReady();
      const live = maker?.getSession(sessionId);
      if (changed || (live && live.stablePermissionModeState?.mode !== mode)) forgetCredentialGrants(sessionId);
      if (live && live.stablePermissionModeState?.mode !== mode) {
        try {
          await live.setPermissionMode(mode as PermissionMode);
        } catch (error) {
          assertCurrent();
          // Never leave a failed tightening running with its previous authority.
          if (maker?.getSession(sessionId) === live) await maker.closeSession(sessionId);
          throw error;
        }
        assertCurrent();
      }
      broadcastSessionPatched(sessionId, { permissionMode: mode });
    });
  } finally {
    // Release the current lane's fence before visiting siblings (including this
    // lane). The transaction has already repaired their saved values atomically.
    // Even a failed hot switch must not strand other running lanes on old authority.
    if (repairedCanonicalSessionId && getCurrentDbClientSnapshot() === owner) {
      await syncBotLinkedLanePermissions(repairedCanonicalSessionId);
    }
  }
}

/** Called after a canonical save; delegated work and archived history keep their own authority. */
export async function syncBotLinkedLanePermissions(canonicalSessionId: string): Promise<void> {
  const owner = getCurrentDbClientSnapshot();
  if (!owner) return;
  const rows = await owner.client.query<{ sessionId: string }>(`SELECT l.session_id AS sessionId
    FROM bot_session_links l JOIN bot_session_links c ON c.bot_id = l.bot_id
    WHERE c.session_id = ? AND c.role IN ('canonical', 'channel', 'group', 'thread', 'routine') AND c.archived_at IS NULL
      AND l.role IN ('canonical', 'channel', 'group', 'thread', 'routine') AND l.archived_at IS NULL
      AND l.session_id != c.session_id`, [canonicalSessionId]);
  if (getCurrentDbClientSnapshot() !== owner) throw new Error('Account changed during lane permission update');
  await syncBotPermissionRows(rows.map(row => row.sessionId));
}

/** Settings can outlive a missing canonical link; those live lanes still need tightening. */
export async function syncBotPermissionsByBotId(botId: string, excludedSessionId = ''): Promise<void> {
  const owner = getCurrentDbClientSnapshot();
  if (!owner) return;
  const rows = await owner.client.query<{ sessionId: string }>(`SELECT session_id AS sessionId
    FROM bot_session_links WHERE bot_id = ? AND role IN ('canonical', 'channel', 'group', 'thread', 'routine')
      AND archived_at IS NULL AND session_id != ?`, [botId, excludedSessionId]);
  if (getCurrentDbClientSnapshot() !== owner) throw new Error('Account changed during lane permission update');
  await syncBotPermissionRows(rows.map(row => row.sessionId));
}

async function syncBotPermissionRows(sessionIds: string[]): Promise<void> {
  // Settle every lane even if one fails, so a failure cannot strand another old runtime.
  const results = await Promise.allSettled(sessionIds.map(sessionId => {
    forgetCredentialGrants(sessionId);
    return syncBotLanePermission(sessionId);
  }));
  const failed = results.find(result => result.status === 'rejected');
  if (failed?.status === 'rejected') throw failed.reason;
}
