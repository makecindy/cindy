import type { XdtHelperMcpDeps } from '@cindy/mcps';
import type { GhostFsSlot } from './fsSlot.js';
import type { PluginHostToolCaller } from '../mcp-integrations/hostToolCaller.js';

/** Trusted caller adapters only; all filesystem behavior lives in GhostFsSlot
 * and the same file-browser core used by Cindy's own file interface. */
export function createFileToolExecutor(service: () => GhostFsSlot,
  pluginCall: () => PluginHostToolCaller | undefined): NonNullable<XdtHelperMcpDeps['files']> {
  return { async call(context, args, signal) {
    const plugin = pluginCall();
    const current = () => {
      try { signal?.throwIfAborted(); plugin?.assertCurrent(); return true; } catch { return false; }
    };
    if (!current()) throw new Error('PERMISSION_DENIED');
    if (context.hostCaller || plugin) {
      const caller = context.hostCaller;
      if (!caller || !plugin || context.sessionId !== undefined || caller.pluginId !== plugin.caller.pluginId ||
        caller.dataOwnerId !== plugin.caller.dataOwnerId || caller.ownerGeneration !== plugin.caller.ownerGeneration) throw new Error('PERMISSION_DENIED');
      return service().handleFsRequest(caller.pluginId, { ...args, root: 'picked' }, current);
    }
    if (!context.sessionId || context.remoteHostId) throw new Error('LOCAL_SESSION_REQUIRED');
    return service().handleTaskFsRequest(context.sessionId, context.sessionInstanceId, args, current, signal);
  } };
}
