import type { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import type { ListSessionsToolDeps } from './list_sessions.js';
import { historyDeviceShape, HISTORY_DEVICE_DESCRIPTION, queryHistoryDevices } from './_history_devices.js';
import { resolveHistoryScope } from './_history_scope.js';
import { errorPayload, okPayload } from './_payload.js';

export function registerListTeammatesTool(registry: XdtHelperToolRegistry, deps: ListSessionsToolDeps): void {
  if (!deps.history.listTeammates) return;
  registry.register({
    name: 'list_teammates', category: 'history',
    description: `${HISTORY_DEVICE_DESCRIPTION} Read the account's teammate directory, including hidden, paused and archived profiles and every stored task relationship (private chats, topics, routines and channels). Uses persisted identities, never guesses relationships from workdirs. list_sessions(teammate_id) reads the related tasks; list_agents remains the teammate messaging directory.`,
    inputShape: historyDeviceShape,
    handler: async args => {
      if (args.device !== 'local') return queryHistoryDevices(registry, deps, 'list_teammates', args);
      const scope = await resolveHistoryScope(deps.history, deps.getSessionContext, null);
      if (!scope.ok) return errorPayload(scope.errorCode, scope.message);
      if (scope.sessionIds !== null) return errorPayload('HISTORY_SCOPE_DENIED', 'Account directory is unavailable for this caller.');
      const result = await deps.history.listTeammates!(deps.getSessionContext?.()?.sessionId);
      return result.ok ? okPayload({ teammates: result.teammates, scope: 'local' }) : errorPayload(result.errorCode, result.message);
    },
  });
}
