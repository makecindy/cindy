/**
 * The `memory` port bag of the Host's cindy_memory provider (memory.mjs createHostMemoryMcpProviders),
 * desktop counterpart `mcp-integrations/mcp-providers.ts` (the `memory:` entry, 679-708).
 *
 * In a .ts file so `explicitPorts` is checked: every optional port of the provider's memory deps is
 * written out below, bound for real or `undefined` with the reason.
 */

import type { MakerMemoryManager } from '@cindy/maker-core';
import type { MemoryMcpDeps, SessionSearchFn } from '@cindy/mcps';
import { AsyncLocalStorage } from 'node:async_hooks';

import { searchSessionsWithBotScopeCore } from '../../../desktop/src/main/maker-host/sessionSearchCore.ts';
import { resolveHelperSurface } from '../../../desktop/src/main/mcp-integrations/helperSurface.ts';
import { tryGetDbClient } from '../../../desktop/src/main/localDb/client/current.ts';
import { isAppSessionBoundaryPending } from '../../../desktop/src/main/appSessionState.ts';
import { getPluginHostToolCaller } from '../../../desktop/src/main/mcp-integrations/hostToolCaller.ts';
import { explicitPorts } from './explicit-ports.ts';
import { LOGGER } from './runtime.ts';
import { HOST_PROFILE_IN_USE_BY_DESKTOP } from './profile-coexistence.js';
import { throwIpcError } from '../../../desktop/src/main/utils/ipcValidate.js';

export interface HostMemoryMcpPortInput {
  /** host-tools.ts readsAccountHistory: the cindy_helper history decision for this task. */
  readsAccountHistory(sessionId: string | undefined): Promise<boolean>;
  /** This computer's device id for the task links in the results ('' while unknown). */
  deviceId(): string;
  searchProviders?: MemoryMcpDeps['searchProviders'];
  profileHold?(): string | null;
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

/**
 * The account-data check the desktop wraps every cindy_memory call in (mcp-providers.ts:409-424,
 * copied: that closure is inline there and pluginTaskHelperScope.test.ts reads it from the source
 * text, so it cannot move; release table section 7). The calling task must be a task of the current
 * database, not restricted, and the database must still be current when the call returns. Any
 * failure reaches the Agent as the provider's CAPABILITY_NOT_AVAILABLE result
 * (packages/lizi-mcps/src/account-data-access.ts), the same as on the desktop.
 */
export async function hostAccountDataAccess<T>(sessionId: string | undefined, operation: (assertCurrent: () => Promise<void>) => Promise<T>): Promise<T> {
  const dbClient = tryGetDbClient();
  const plugin = !sessionId ? getPluginHostToolCaller() : undefined;
  if (!dbClient || (!sessionId && !plugin)) throw new Error('Account data caller unavailable');
  const assertAccess = async () => {
    plugin?.assertCurrent();
    if (isAppSessionBoundaryPending() || dbClient !== tryGetDbClient()) throw new Error('Account changed');
    if (sessionId && await resolveHelperSurface(dbClient, sessionId) === 'restricted')
      throw new Error('Account data is unavailable for this task');
    if (isAppSessionBoundaryPending() || dbClient !== tryGetDbClient()) throw new Error('Account changed');
  };
  await assertAccess();
  const result = await operation(assertAccess);
  await assertAccess();
  return result;
}

export function hostMemoryMcpPorts(manager: MakerMemoryManager, input: HostMemoryMcpPortInput): Omit<MemoryMcpDeps, 'workdir'> {
  // The account-access port receives a callback, not a tool name. The shared
  // withStore path requests the manager inside this scope; metadata and history
  // calls do not. The provider's availability check runs outside the scope.
  const memoryCall = new AsyncLocalStorage<{ admitted: boolean }>();
  return explicitPorts<Omit<MemoryMcpDeps, 'workdir'>>({
    getManager: () => {
      const admission = memoryCall.getStore();
      if (admission && !admission.admitted) {
        const held = input.profileHold?.();
        if (held) throwIpcError('PRECONDITION_FAILED', held);
        admission.admitted = true;
      }
      return manager;
    },
    // As the desktop binds it (mcp-providers.ts:684). session_search keeps its own checks inside, as
    // the desktop's does.
    withAccountDataAccess: (sessionId, operation) => hostAccountDataAccess(sessionId, async assertCurrent => {
      const result = await memoryCall.run({ admitted: false }, () => operation(assertCurrent));
      // packages/lizi-mcps/src/memory/_shared.ts withStore uses
      // memory/errors.ts classifyMemoryError, then buildJsonResult encodes
      // {ok:false, code:"INTERNAL", message} as the first text block. The
      // [CODE] prefix comes from createIpcError in apps/desktop/src/shared/ipc-errors.ts.
      // Keep this mapping in sync if either format changes.
      if (!result || typeof result !== 'object' || !('isError' in result) || result.isError !== true
        || !('content' in result) || !Array.isArray(result.content)) return result;
      const block = result.content[0];
      if (block?.type !== 'text' || typeof block.text !== 'string') return result;
      try {
        const body = JSON.parse(block.text);
        if (body?.code === 'INTERNAL' && typeof body.message === 'string'
          && body.message.startsWith(`[PRECONDITION_FAILED] ${HOST_PROFILE_IN_USE_BY_DESKTOP}`)) {
          return { ...result, content: [{ type: 'text', text: JSON.stringify({ ...body, code: 'PRECONDITION_FAILED' }) }] };
        }
      } catch { /* Non-memory tool responses keep their original shape. */ }
      return result;
    }),
    searchProviders: input.searchProviders,
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
