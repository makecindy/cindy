import type { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import type { ListSessionsToolDeps } from './list_sessions.js';
import { historyDeviceShape, HISTORY_DEVICE_DESCRIPTION, queryHistoryDevices } from './_history_devices.js';
import { resolveHistoryScope } from './_history_scope.js';
import { errorPayload, okPayload } from './_payload.js';
import { z } from 'zod';
import { decodeCursor, encodeCursor } from './_history_cursor.js';

export function registerListTeammatesTool(registry: XdtHelperToolRegistry, deps: ListSessionsToolDeps): void {
  if (!deps.history.listTeammates) return;
  registry.register({
    name: 'list_teammates', category: 'history',
    description: `${HISTORY_DEVICE_DESCRIPTION} Page the account's teammate directory, including hidden, paused and archived profiles. Pass teammate_id to page that teammate's persisted task relationships (private chats, topics, routines and channels). Follow nextCursor while hasMore; limit defaults to 100, maximum 1000. Uses persisted identities, never guesses relationships from workdirs. list_sessions(teammate_id) reads the related tasks; list_agents remains the teammate messaging directory.`,
    inputShape: { ...historyDeviceShape,
      teammate_id: z.string().min(1).max(256).optional().describe('Omit to page profiles; provide a profile id to page its relationships.'),
      limit: z.number().int().min(1).max(1000).default(100),
      cursor: z.string().optional().describe('nextCursor from the same device and filters; malformed cursors restart the first page.'),
    },
    handler: async args => {
      if (args.device !== 'local') return queryHistoryDevices(registry, deps, 'list_teammates', args);
      const scope = await resolveHistoryScope(deps.history, deps.getSessionContext, null);
      if (!scope.ok) return errorPayload(scope.errorCode, scope.message);
      if (scope.sessionIds !== null) return errorPayload('HISTORY_SCOPE_DENIED', 'Account directory is unavailable for this caller.');
      const result = await deps.history.listTeammates!({ teammateId: args.teammate_id, limit: args.limit,
        cursor: decodeCursor(args.cursor) }, deps.getSessionContext?.()?.sessionId);
      if (!result.ok) return errorPayload(result.errorCode, result.message);
      const { page } = result;
      return okPayload({ ...(args.teammate_id ? { teammateId: args.teammate_id, relationships: page.items } : { teammates: page.items }),
        nextCursor: page.nextCursor ? encodeCursor(page.nextCursor) : null, hasMore: page.hasMore, scope: 'local' });
    },
  });
}
