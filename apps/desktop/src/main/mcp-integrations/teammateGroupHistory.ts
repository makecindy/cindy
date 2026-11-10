import type { XdtHelperMcpDeps } from '@cindy/mcps';
import type { DbClient } from '../localDb/client/DbClient.js';
import type { resolveBotHistoryScope } from '../localDb/botHistoryScope.js';
import type { authorizeGroupTool } from '../maker-ipc/botGroupToolAuthorization.js';
import type { TeammateGroupHistoryQuery, TeammateGroupHistoryResult } from '../maker-ipc/teammateGroupHistory.js';

/** Host boundary: persisted lane attribution never replaces live group authority. */
export function createTeammateGroupHistoryProvider(deps: {
  getDbClient(): Pick<DbClient, 'queryOne'>;
  activeOwnerScopeKey(): string;
  isAppSessionBoundaryPending(): boolean;
  resolveBotHistoryScope: typeof resolveBotHistoryScope;
  authorizeGroupTool: typeof authorizeGroupTool;
  getReader(): ((input: TeammateGroupHistoryQuery) => Promise<TeammateGroupHistoryResult>) | undefined;
}): NonNullable<XdtHelperMcpDeps['teammateGroupHistory']> {
  return async input => {
    const db = deps.getDbClient();
    const scope = deps.activeOwnerScopeKey();
    const current = () => !deps.isAppSessionBoundaryPending() && deps.getDbClient() === db && deps.activeOwnerScopeKey() === scope;
    try {
      const caller = await deps.resolveBotHistoryScope(input.callerSessionId, undefined);
      if (!current() || caller.kind !== 'bot') return { ok: false, errorCode: 'CALLER_UNAVAILABLE' };
      const link = await db.queryOne<{ role: string }>('SELECT role FROM bot_session_links WHERE session_id = ? LIMIT 1', [input.callerSessionId]);
      if (!current() || !link) return { ok: false, errorCode: 'CALLER_UNAVAILABLE' };
      if (!['canonical', 'thread', 'routine', 'group'].includes(link.role)) return { ok: false, errorCode: 'PERMISSION_DENIED' };
      const authority = link.role === 'group' ? await deps.authorizeGroupTool(input.callerSessionId, caller.botId, 'read-self') : null;
      // The model receives a group name, not its internal ID. Only a live tools
      // grant may resolve an omitted ID to its own group; it never discovers others.
      const groupId = input.groupId ?? (authority?.mode === 'tools' ? authority.sourceGroup?.groupId : undefined);
      if (authority && authority.mode !== 'owner' && (!groupId || groupId !== authority.sourceGroup?.groupId))
        return { ok: false, errorCode: 'PERMISSION_DENIED' };
      if (!current()) return { ok: false, errorCode: 'OWNER_CHANGED' };
      const read = deps.getReader();
      if (!read) return { ok: false, errorCode: 'HOST_NOT_READY' };
      const data = await read({ ...input, groupId, botId: caller.botId });
      // The requester can lose membership or its tools grant while history is in
      // flight, before the execution's background revocation poll catches up.
      await authority?.refresh();
      authority?.assertCurrent();
      if (!current()) return { ok: false, errorCode: 'OWNER_CHANGED' };
      return { ok: true, data: { ...data } };
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : error instanceof Error ? error.message : '';
      const allowed = ['PERMISSION_DENIED', 'CONVERSATION_NOT_FOUND', 'AUTH_REQUIRED', 'CALLER_UNAVAILABLE', 'OWNER_CHANGED', 'GROUP_AUTHORIZATION_REQUIRED', 'GROUP_AUTHORIZATION_UNAVAILABLE'];
      return { ok: false, errorCode: allowed.includes(code) ? code : 'GROUP_HISTORY_UNAVAILABLE' };
    }
  };
}
