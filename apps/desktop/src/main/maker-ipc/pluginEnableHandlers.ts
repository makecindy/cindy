/** Persist builtin tool overrides and refresh machine-wide MCP startup snapshots. */
import type { PluginRegistry } from '../maker-host/plugins/plugin-registry.js';
import { GLOBAL_PLUGIN_IDS } from '../maker-host/plugins/types.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import { MAKER_INVOKE } from './channels.js';
import type { IpcHandlerRegistry } from './ipcHandlerRegistry.js';

/** Existing host lifecycle operations; ordinary defaults do not rebuild shared bridges. */
export interface PluginEnableHandlerDeps {
  getPluginRegistry(): Pick<PluginRegistry, 'setEnabled' | 'clearEnabled'>;
  invalidatePiEnvironment(): void;
  refreshCodexMcpEnvironment(): Promise<{ codexMcpRefreshed: boolean }>;
}

/** Settings and remote callers share persistence, validation and refresh ordering. */
export function registerPluginEnableHandlers(
  registry: IpcHandlerRegistry,
  deps: PluginEnableHandlerDeps,
): void {
  registry.handle(MAKER_INVOKE.PLUGINS_SET_ENABLED, async (_e, id: unknown, enabled: unknown) => {
    if (typeof id !== 'string' || typeof enabled !== 'boolean') {
      throwIpcError('INVALID_PARAMS', 'id (string) + enabled (boolean) required');
    }
    const ok = await deps.getPluginRegistry().setEnabled(id, enabled);
    if (!ok) {
      throwIpcError('PERMISSION_DENIED', `Cannot modify essential plugin: ${id}`);
    }
    // Ordinary plugins are user defaults: existing sessions keep their frozen
    // policy and only new sessions observe changes, so no shared environment
    // refresh is needed.
    if (!GLOBAL_PLUGIN_IDS.has(id) && id !== 'browser') {
      return { codexMcpRefreshed: true };
    }
    // Machine-wide tools keep their existing lifecycle. The preference is
    // already durable at this point, so refresh best-effort; a busy turn must
    // keep using the existing bridge and must not turn a successful save into
    // an IPC failure. Renderer surfaces the deferred state explicitly.
    // New Pi sessions use the committed setting. Retired generations retain
    // their leases, so changing the preference never interrupts an active Pi.
    deps.invalidatePiEnvironment();
    return deps.refreshCodexMcpEnvironment();
  });

  registry.handle(MAKER_INVOKE.PLUGINS_CLEAR_ENABLED, async (_e, id: unknown) => {
    if (typeof id !== 'string') {
      throwIpcError('INVALID_PARAMS', 'id (string) required');
    }
    const ok = await deps.getPluginRegistry().clearEnabled(id);
    if (!ok) {
      throwIpcError('PERMISSION_DENIED', `Cannot modify essential plugin: ${id}`);
    }
    if (!GLOBAL_PLUGIN_IDS.has(id) && id !== 'browser') {
      return { codexMcpRefreshed: true };
    }
    // New Pi sessions use the committed setting. Retired generations retain
    // their leases, so changing the preference never interrupts an active Pi.
    deps.invalidatePiEnvironment();
    return deps.refreshCodexMcpEnvironment();
  });
}
