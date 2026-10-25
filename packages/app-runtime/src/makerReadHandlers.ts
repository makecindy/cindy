import type { AgentKind, AuthState, Maker } from '@cindy/maker-core';
import { MAKER_INVOKE } from '@cindy/maker-shared/maker-channels';
import { DL_SESSION_REFERENCE_CAPABILITY_CHANNEL } from '@cindy/device-link';
import { throwIpcError } from '@cindy/remote-agent/ipcValidate';
import type { IpcHandlerRegistry } from './ipcHandlerRegistry.js';
import type { PluginRegistry } from './builtin-tools/plugin-registry.js';
import type { BotToolsetContext } from '@cindy/companion-core/botRemoteCapabilities';
import { isBotToolsetProviderAvailable } from './botToolsetAvailability.js';

const AGENT_KINDS = ['claude-code', 'codex', 'pi'] as const satisfies readonly AgentKind[];
const isAgentKind = (value: unknown): value is AgentKind =>
  typeof value === 'string' && (AGENT_KINDS as readonly string[]).includes(value);

export interface MakerReadHandlerDeps {
  getMaker: () => Pick<Maker, 'getAgentAuthState'>;
  apiKeyPresent: () => boolean;
  recoverImage: (sessionId: string, imageId: string) => Promise<void>;
  assertTrustedRenderer?: (event: unknown) => void;
  isRemoteInvoke: () => boolean;
  assertRemoteInputControlBoundary: (sessionId: string, remote: boolean, opts?: unknown) => Promise<unknown>;
  getPluginRegistry?: () => Pick<PluginRegistry, 'listPlugins' | 'getEnableState' | 'setEnabled' | 'clearEnabled' | 'setProjectEnabled' | 'clearProjectEnabled'>;
  builtinProviders?: () => Parameters<typeof isBotToolsetProviderAvailable>[0];
  isManagedDialogueWorkspace?: (workingDir: string) => boolean;
}

export function registerMakerReadHandlers(
  registry: IpcHandlerRegistry,
  deps: MakerReadHandlerDeps,
): void {
  registry.handle(MAKER_INVOKE.AUTH_GET_STATE, async (_event, agentKind: unknown): Promise<AuthState> => {
    if (!isAgentKind(agentKind)) throwIpcError('INVALID_PARAMS', 'invalid agentKind');
    return deps.getMaker().getAgentAuthState(agentKind);
  });
  registry.handle(MAKER_INVOKE.API_KEY_PRESENT, async () => ({ present: deps.apiKeyPresent() }));
  registry.handle(MAKER_INVOKE.IMAGES_RETRY, async (event, sessionId: unknown, imageId: unknown) => {
    const remote = deps.isRemoteInvoke();
    if (!remote) deps.assertTrustedRenderer?.(event);
    if (typeof sessionId !== 'string' || sessionId.length === 0) throwIpcError('INVALID_PARAMS', 'sessionId required');
    if (typeof imageId !== 'string' || !/^[a-f0-9]{64}$/.test(imageId)) throwIpcError('INVALID_PARAMS', 'invalid image id');
    await deps.assertRemoteInputControlBoundary(sessionId, remote);
    try { await deps.recoverImage(sessionId, imageId); }
    catch { throwIpcError('INTERNAL', 'Image delivery is unavailable'); }
  });
  registry.handle(DL_SESSION_REFERENCE_CAPABILITY_CHANNEL, () => ({ supported: true, version: 1 }));

  if (deps.getPluginRegistry) {
    registry.handle(MAKER_INVOKE.PLUGINS_LIST, async (event, workingDir, includeHidden, botContext) => {
      const wd = typeof workingDir === 'string' ? workingDir : undefined;
      if (botContext === undefined) return deps.getPluginRegistry!().listPlugins(wd, includeHidden === true);
      if (!deps.isRemoteInvoke()) deps.assertTrustedRenderer?.(event);
      if (!botContext || typeof botContext !== 'object') throwIpcError('INVALID_PARAMS', 'Invalid Bot toolset context');
      const context = botContext as BotToolsetContext;
      if (!['claude-code', 'codex', 'pi'].includes(context.agentKind) || typeof context.botId !== 'string') {
        throwIpcError('INVALID_PARAMS', 'Invalid Bot toolset context');
      }
      const items = await deps.getPluginRegistry!().listPlugins(wd, includeHidden === true);
      return items.map(item => ({ ...item, available: item.effectiveEnabled && !!deps.builtinProviders && isBotToolsetProviderAvailable(deps.builtinProviders!(), { ...context, workingDir: wd ?? '', toolsetId: item.id }) }));
    });
    registry.handle(MAKER_INVOKE.PLUGINS_GET_STATE, async (_event, id: unknown, workingDir: unknown, workspaceKind: unknown) => {
      if (typeof id !== 'string') throwIpcError('INVALID_PARAMS', 'id (string) required');
      const wd = typeof workingDir === 'string' ? workingDir : undefined;
      const policyWd = id === 'collab' && wd && workspaceKind === 'dialogue' && deps.isManagedDialogueWorkspace?.(wd) ? undefined : wd;
      const state = await deps.getPluginRegistry!().getEnableState(id, policyWd);
      return id === 'collab' && (workspaceKind === 'project' || workspaceKind === 'dialogue') ? { ...state, collabWorkspaceKind: workspaceKind } : state;
    });
    registry.handle(MAKER_INVOKE.PLUGINS_SET_ENABLED, async (_event, id: unknown, enabled: unknown) => {
      if (typeof id !== 'string' || typeof enabled !== 'boolean') throwIpcError('INVALID_PARAMS', 'id (string) + enabled (boolean) required');
      if (!await deps.getPluginRegistry!().setEnabled(id, enabled)) throwIpcError('PERMISSION_DENIED', `Cannot modify essential plugin: ${id}`);
      return { codexMcpRefreshed: true };
    });
    registry.handle(MAKER_INVOKE.PLUGINS_CLEAR_ENABLED, async (_event, id: unknown) => {
      if (typeof id !== 'string') throwIpcError('INVALID_PARAMS', 'id (string) required');
      if (!await deps.getPluginRegistry!().clearEnabled(id)) throwIpcError('PERMISSION_DENIED', `Cannot modify essential plugin: ${id}`);
      return { codexMcpRefreshed: true };
    });
    registry.handle(MAKER_INVOKE.PLUGINS_SET_PROJECT_ENABLED, async (_event, workingDir: unknown, id: unknown, enabled: unknown) => {
      if (typeof workingDir !== 'string' || typeof id !== 'string' || typeof enabled !== 'boolean') throwIpcError('INVALID_PARAMS', 'workingDir (string) + id (string) + enabled (boolean) required');
      if (!await deps.getPluginRegistry!().setProjectEnabled(id, workingDir, enabled)) throwIpcError('PERMISSION_DENIED', `Cannot modify essential plugin: ${id}`);
    });
    registry.handle(MAKER_INVOKE.PLUGINS_CLEAR_PROJECT_ENABLED, async (_event, workingDir: unknown, id: unknown) => {
      if (typeof workingDir !== 'string' || typeof id !== 'string') throwIpcError('INVALID_PARAMS', 'workingDir (string) + id (string) required');
      if (!await deps.getPluginRegistry!().clearProjectEnabled(id, workingDir)) throwIpcError('PERMISSION_DENIED', `Cannot modify essential plugin: ${id}`);
    });
  }
}
