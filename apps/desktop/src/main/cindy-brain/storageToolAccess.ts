import type { XdtHelperMcpDeps } from '@cindy/mcps';
import type { HostStorageService } from './storageService.js';
import type { PluginHostToolCaller } from '../mcp-integrations/hostToolCaller.js';

export function createStorageToolExecutor(service: () => HostStorageService,
  pluginCall: () => PluginHostToolCaller | undefined): NonNullable<XdtHelperMcpDeps['storage']> {
  return { async call(context, request, signal) {
    const plugin = pluginCall(), caller = context.hostCaller;
    if (!plugin || !caller || context.sessionId !== undefined || caller.pluginId !== plugin.caller.pluginId ||
        caller.dataOwnerId !== plugin.caller.dataOwnerId || caller.ownerGeneration !== plugin.caller.ownerGeneration) throw new Error('PLUGIN_CONTEXT_REQUIRED');
    const current = () => { try { signal?.throwIfAborted(); plugin.assertCurrent(); return true; } catch { return false; } };
    return service().request(caller.pluginId, request, current);
  } };
}
