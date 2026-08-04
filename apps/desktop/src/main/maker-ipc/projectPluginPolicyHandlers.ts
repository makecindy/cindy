/**
 * Project-level plugin policy IPC handlers.
 *
 * These handlers only persist the policy used when future agent sessions are
 * created. Runtime lifecycles such as an active Orca team deliberately remain
 * outside this boundary.
 */

import type { PluginRegistry } from '../maker-host/plugins/plugin-registry.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import { MAKER_INVOKE } from './channels.js';
import type { IpcHandlerRegistry } from './ipcHandlerRegistry.js';

/** Minimal plugin registry surface required by project policy handlers. */
export type ProjectPluginPolicyRegistry = Pick<
  PluginRegistry,
  'setProjectEnabled' | 'clearProjectEnabled'
>;

/** Host dependencies for project-level plugin policy IPC handlers. */
export interface ProjectPluginPolicyHandlerDeps {
  getPluginRegistry(): ProjectPluginPolicyRegistry;
}

/** Register project policy writes without coupling them to active runtimes. */
export function registerProjectPluginPolicyHandlers(
  registry: IpcHandlerRegistry,
  deps: ProjectPluginPolicyHandlerDeps,
): void {
  registry.handle(
    MAKER_INVOKE.PLUGINS_SET_PROJECT_ENABLED,
    async (_event, workingDir, id, enabled) => {
      if (
        typeof workingDir !== 'string' ||
        typeof id !== 'string' ||
        typeof enabled !== 'boolean'
      ) {
        throwIpcError(
          'INVALID_PARAMS',
          'workingDir (string) + id (string) + enabled (boolean) required',
        );
      }
      const ok = await deps.getPluginRegistry().setProjectEnabled(id, workingDir, enabled);
      if (!ok) {
        throwIpcError('PERMISSION_DENIED', `Cannot modify essential plugin: ${id}`);
      }
    },
  );

  registry.handle(MAKER_INVOKE.PLUGINS_CLEAR_PROJECT_ENABLED, async (_event, workingDir, id) => {
    if (typeof workingDir !== 'string' || typeof id !== 'string') {
      throwIpcError('INVALID_PARAMS', 'workingDir (string) + id (string) required');
    }
    const ok = await deps.getPluginRegistry().clearProjectEnabled(id, workingDir);
    if (!ok) {
      throwIpcError('PERMISSION_DENIED', `Cannot modify essential plugin: ${id}`);
    }
  });
}
