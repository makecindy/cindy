import { GhostSetupCoordinator } from '@cindy/plugin-runtime/ghostSetupCoordinator';
import { GhostSetupInteractionBridge } from '@cindy/plugin-runtime/ghostSetupInteractionBridge';
import { executeGhostSetupInlineSubmission } from '@cindy/plugin-runtime/ghostSetupInlineExecutor';
import { executeGhostSetupConnectionSubmission } from '@cindy/plugin-runtime/ghostSetupConnectionExecutor';
import { parseOauthConnectSecretKey } from '@cindy/plugin-runtime/ghostSetupStatus';
import { getRemoteOauthContext } from '@cindy/plugin-runtime/authorization/context';
import { createPluginOauthCardBindings } from '@cindy/plugin-runtime/authorization/cards';
import { classifyGhostVisibility, classifyInstalledGhostVisibility, type GhostVisibilityDeps } from '@cindy/plugin-runtime/ghostVisibility';
import { installedGhostStoragePart } from '@cindy/plugin-runtime/shared/pluginIdentity';
import type { TerminalPlugins } from './host.js';
import { createGhostSetupInteractionSurface } from '@cindy/plugin-runtime/ghostSetupInteractionSurface';

/** The same pending-card coordinator serves GUI, Mobile and terminal callers.
 * Values are committed only by the dedicated executor or signed exchange. */
export class TerminalPluginSetup {
  readonly surface = createGhostSetupInteractionSurface();
  private closed=false;
  readonly bridge: GhostSetupInteractionBridge;
  readonly coordinator: GhostSetupCoordinator;
  readonly authorization: ReturnType<typeof createPluginOauthCardBindings>;
  constructor(private readonly host: TerminalPlugins, private readonly options: {
    visibility: GhostVisibilityDeps;
    owner(): string | null;
    remoteAvailable(peer: string): boolean;
    emit(channel: string, payload: unknown): void;
    navigate(sessionId: string, target: 'plugin_settings' | 'client_settings', ghostId: string): void;
    assertCurrent(): void;
    translate(key: string): string;
    settings?: NonNullable<Parameters<typeof createPluginOauthCardBindings>[0]['settings']>;
  }) {
    const assertActive=()=>{if(this.closed)throw new Error('PLUGIN_SETUP_CLOSED');options.assertCurrent();};
    this.bridge = new GhostSetupInteractionBridge({ channels: { request: 'maker:interaction-request', dismissed: 'maker:interaction-dismissed' }, broadcast: options.emit });
    const validate = (id: string, tool: string | undefined, workingDir?: string | null) => {
      assertActive();
      const installed=host.installed(id);
      const result = installed?classifyInstalledGhostVisibility(installed,workingDir??null,options.visibility):classifyGhostVisibility(id, workingDir ?? null, options.visibility);
      if (!result.ok) return result;
      if (tool && !result.ghost.manifest.tools?.some(item => item.name === tool)) return { ok: false as const, errorCode: 'TOOL_NOT_FOUND' as const, message: 'This plugin does not declare the requested tool.' };
      return { ok: true as const };
    };
    this.coordinator = new GhostSetupCoordinator({
      bridge: this.bridge, changeBus: host.setupChanges, assess: id => host.assessment(id),
      getTargetToken: id => host.credentials.target(id), remoteConnection: true,
      validateTarget: validate,
      getGhostIdentity: id => { const ghost = host.installed(id); return ghost ? { id, name: ghost.manifest.name } : null; },
      executeAction: async ({ sessionId, ghostId, action, assertCurrent }) => {
        assertActive(); assertCurrent?.();
        if (action.kind === 'oauth_connect') {
          const key = parseOauthConnectSecretKey(action.id);
          const ghost = host.installed(ghostId);
          const decl = ghost?.manifest.network?.secrets?.find(secret => secret.key === key && secret.source === 'oauth')?.oauth;
          if (!key || !decl) return { ok: false, errorCode: 'TARGET_UNAVAILABLE' };
          const result = await host.credentials.oauth.connectAccount(ghostId, key, decl, {
            remote: getRemoteOauthContext(), deliveryHosts: ghost?.manifest.network?.hosts,
            expectedConnectTarget: host.credentials.target(ghostId),
            assertCurrent: () => { assertActive(); assertCurrent?.(); },
          });
          return result.ok ? { ok: true } : { ok: false, errorCode: 'ACTION_FAILED' };
        }
        if (['open_plugin_settings', 'manage_connection', 'open_client_settings'].includes(action.kind)) {
          options.navigate(sessionId, action.kind === 'open_client_settings' ? 'client_settings' : 'plugin_settings', ghostId);
          return { ok: true, waitingExternal: true };
        }
        return { ok: false, errorCode: 'ACTION_FAILED' };
      },
      executeInlineAction: input => host.withCredentialMutation(input.ghostId, () => executeGhostSetupInlineSubmission({
        translate: options.translate, getManifest: id => host.installed(id)?.manifest ?? null,
        getAssessment: id => host.assessment(id),
        storeSecret: (id, key, value) => { host.writeSecretSync(id, key, value); return true; },
        emitChange: id => host.credentialsChanged(id),
      }, input)),
    });
    this.authorization = createPluginOauthCardBindings({
      bridge: this.bridge, bots: () => null, owner: options.owner, available: options.remoteAvailable,
      settings: options.settings,
      bindConnection: ({ ghostId, actionId, onCommitted }) => {
        const manifest = host.installed(ghostId)?.manifest;
        if (!manifest) return null;
        const expectedManifest = JSON.stringify(manifest);
        return value => executeGhostSetupConnectionSubmission({
          getManifest: id => host.installed(id)?.manifest ?? null, getAssessment: id => host.assessment(id),
          manager: host.credentials.connections, emitChange: id => host.credentialsChanged(id),
        }, { ghostId, actionId, expectedManifest, value, onCommitted });
      },
    });
  }
  ensure(request: Parameters<GhostSetupCoordinator['ensureReady']>[0]) {
    if(this.closed)throw new Error('PLUGIN_SETUP_CLOSED');this.options.assertCurrent();
    const result = classifyGhostVisibility(request.ghostId, request.workingDir ?? null, this.options.visibility);
    if (!result.ok) return Promise.resolve(result);
    return this.coordinator.ensureReady({ ...request, ghostId: installedGhostStoragePart(result.ghost) });
  }
  close() { this.closed=true;this.bridge.cleanupAll('session_closed'); }
}
