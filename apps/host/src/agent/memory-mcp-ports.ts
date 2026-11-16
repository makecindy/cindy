/**
 * The `memory` port bag of the Host's cindy_memory provider (memory.mjs createHostMemoryMcpProviders),
 * desktop counterpart `mcp-integrations/mcp-providers.ts` (the `memory:` entry, 679-708).
 *
 * In a .ts file so `explicitPorts` is checked: every optional port of the provider's memory deps is
 * written out below, bound for real or `undefined` with the reason.
 */

import type { MakerMemoryManager } from '@cindy/maker-core';
import type { MemoryMcpDeps, SessionSearchFn } from '@cindy/mcps';

import { searchSessionsWithBotScopeCore } from '../../../desktop/src/main/maker-host/sessionSearchCore.ts';
import { resolveHelperSurface } from '../../../desktop/src/main/mcp-integrations/helperSurface.ts';
import { tryGetDbClient } from '../../../desktop/src/main/localDb/client/current.ts';
import { isAppSessionBoundaryPending } from '../../../desktop/src/main/appSessionState.ts';
import { explicitPorts } from './explicit-ports.ts';
import { LOGGER } from './runtime.ts';

export interface HostMemoryMcpPortInput {
  /** host-tools.ts readsAccountHistory: the cindy_helper history decision for this task. */
  readsAccountHistory(sessionId: string | undefined): Promise<boolean>;
  /** This computer's device id for the task links in the results ('' while unknown). */
  deviceId(): string;
}

/**
 * session_search with the desktop's checks, in the desktop's order (mcp-providers.ts:687-706, copied:
 * that closure is inline there and pluginTaskHelperScope.test.ts reads it from the source text, so it
 * cannot move; release table section 7). The search itself is the desktop's shared core.
 */
export function createHostSessionSearch(input: HostMemoryMcpPortInput): SessionSearchFn {
  return async (query, opts = {}) => {
    const dbClient = tryGetDbClient();
    if (!dbClient || isAppSessionBoundaryPending() || !opts.callerSessionId)
      throw new Error('Task history caller unavailable');
    // session_search bypasses cindy_helper, so share its account-data surface.
    if (await resolveHelperSurface(dbClient, opts.callerSessionId) === 'restricted')
      throw new Error('Task history search is unavailable for this task');
    if (isAppSessionBoundaryPending() || dbClient !== tryGetDbClient())
      throw new Error('Task history caller unavailable');
    const hits = await searchSessionsWithBotScopeCore(query, opts, {
      botAccountWide: await input.readsAccountHistory(opts.callerSessionId),
      readDeviceId: input.deviceId,
    });
    if (isAppSessionBoundaryPending() || dbClient !== tryGetDbClient())
      throw new Error('Task history caller unavailable');
    if (await resolveHelperSurface(dbClient, opts.callerSessionId) === 'restricted')
      throw new Error('Task history search is unavailable for this task');
    if (isAppSessionBoundaryPending() || dbClient !== tryGetDbClient())
      throw new Error('Task history caller unavailable');
    return hits;
  };
}

export function hostMemoryMcpPorts(manager: MakerMemoryManager, input: HostMemoryMcpPortInput): Omit<MemoryMcpDeps, 'workdir'> {
  return explicitPorts<Omit<MemoryMcpDeps, 'workdir'>>({
    getManager: () => manager,
    // Not bound on the Host before this change either. The desktop wraps every cindy_memory call in
    // it (mcp-providers.ts:405-420: current database, task not restricted). session_search makes the
    // same checks itself (above); for the other memory tools the manager fails closed across an owner
    // change (memory-manager-ports.ts readSession). Whether that is enough is for the reviewer.
    withAccountDataAccess: undefined,
    // Memories provided by enabled plugins: the Host has no plugin runtime context providers yet
    // (release table row 33).
    searchProviders: undefined,
    // Only teammate learning records use it (botLearningTracker.ts:35-38); the Host refuses teammate
    // tasks (send-preflight.ts:19-22).
    beginWrite: undefined,
    // The provider sets it for each task (packages/lizi-mcps/src/providers.ts:470); the desktop does
    // not pass it either.
    getSessionContext: undefined,
    searchSessions: createHostSessionSearch(input),
    logger: LOGGER.child('mcp/cindy_memory'),
  });
}
