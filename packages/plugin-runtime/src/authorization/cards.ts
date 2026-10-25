import { createInputHandoffAuthorization } from '@cindy/plugin-runtime/authorization/inputHandoffBinding';
import {
  INPUT_HANDOFF_ACTION_ID,
  INPUT_HANDOFF_GHOST_ID,
  inputHandoffPresentation,
  type PluginOauthAction,
  type PluginConnectionInput,
  type InputHandoffSubmission,
} from '@cindy/device-link';
import type { InputHandoffService } from '@cindy/remote-agent/input-handoff/service';
import { randomBytes } from 'node:crypto';
import {
  createPluginSecretPresentation,
  createPluginConnectionPresentation,
} from '../shared/pluginOauth.js';
import { getRemoteOauthContext } from './context.js';
import type { GhostSetupInteractionBridge } from '../ghostSetupInteractionBridge.js';
import type { OauthCardBinding, OauthTransactionDeps } from './transactions.js';

/** Bind existing Host cards; no new plugin manifest or generic setup permission. */
export function createPluginOauthCardBindings(deps: {
  bridge: GhostSetupInteractionBridge;
  bots(): { bindRemoteOauth(action: PluginOauthAction): Promise<OauthCardBinding | null> | OauthCardBinding | null; resolveRemoteOauth(action: PluginOauthAction): Promise<boolean> | boolean } | null;
  inputHandoff?(): InputHandoffService | null;
  owner(): string | null;
  available(peer: string): boolean;
  bindConnection?(args: {
    ghostId: string;
    actionId: string;
    onCommitted(): void;
  }): ((value: PluginConnectionInput) => boolean) | null;
  settings?: {
    bind(action: PluginOauthAction): OauthCardBinding | null;
    bindAuthorization(action: PluginOauthAction): OauthCardBinding | null;
    runAuthorization(action: PluginOauthAction): boolean;
    request(
      peer: string,
      request: import('@cindy/device-link').PluginSettingsRequest,
    ): Promise<unknown>;
  };
}): OauthTransactionDeps {
  const findCardAction = (action: PluginOauthAction) => {
    const found = deps.bridge
      .pendingSnapshots()
      .find((e) => e.request.requestId === action.requestId);
    if (!found || found.request.terminal || found.request.revision !== action.expectedRevision)
      return null;
    const step = found.request.steps.find(
      (s) =>
        s.action?.id === action.actionId &&
        (s.action.kind === 'oauth_connect' ||
          (found.request.remoteSecret === true && s.action.kind === 'inline_form') ||
          (found.request.remoteConnection === true &&
            !!deps.bindConnection &&
            s.action.kind === 'manage_connection')) &&
        (s.phase === 'pending' || s.phase === 'failed'),
    );
    if (!step) return null;
    const binding: OauthCardBinding = {
      ghostId: found.request.ghost.id,
      current: () =>
        deps.bridge
          .pendingSnapshots(found.sessionId)
          .some((e) => e.request.requestId === action.requestId && !e.request.terminal),
    };
    return { snapshot: found.request, step, binding };
  };
  const { find: findHandoffStep, run: runHandoffStep } = createInputHandoffAuthorization(() => deps.inputHandoff?.());
  return {
      owner: deps.owner,
      available: deps.available,
      bind: async (action) =>
        deps.settings?.bind(action) ??
        deps.settings?.bindAuthorization(action) ??
        findCardAction(action)?.binding ??
        findHandoffStep(action)?.binding ??
        (await deps.bots()?.bindRemoteOauth(action)) ??
        null,
      run: async (action) => {
        if (deps.settings?.bindAuthorization(action)) return deps.settings.runAuthorization(action);
        if (findHandoffStep(action)) return runHandoffStep(action);
        const card = findCardAction(action);
        if (card) {
          const { snapshot, step } = card;
          if (step.action?.kind === 'manage_connection') {
            const remote = getRemoteOauthContext();
            if (!remote?.submitConnection || !deps.bindConnection) return false;
            const save = deps.bindConnection({
              ghostId: snapshot.ghost.id,
              actionId: action.actionId,
              onCommitted: () => {
                deps.bridge.connectionCommitted(
                  action.requestId,
                  action.actionId,
                  action.expectedRevision,
                );
              },
            });
            if (!save) return false;
            const presentation = createPluginConnectionPresentation(snapshot, step);
            void (async () => {
              let value: PluginConnectionInput | undefined;
              try {
                value = await remote.submitConnection!({
                  kind: 'connection-entry',
                  state: randomBytes(32).toString('base64url'),
                  presentation,
                });
                remote.assertCurrent();
                if (!findCardAction(action) || !save(value))
                  throw new Error('PLUGIN_CONNECTION_UNAVAILABLE');
              } catch {
                remote.finish(false);
              } finally {
                value = undefined;
              }
            })();
            return true;
          }
          if (step.action?.kind === 'inline_form') {
            const remote = getRemoteOauthContext();
            const submitSecret = remote?.submitSecret;
            if (!remote || !submitSecret) return false;
            const field = step.action.form.fields[0];
            const presentation = createPluginSecretPresentation(snapshot, step, field);
            void (async () => {
              try {
                let value = await submitSecret({
                  kind: 'secret-entry',
                  state: randomBytes(32).toString('base64url'),
                  presentation,
                });
                remote.assertCurrent();
                // No optimistic write: the same card/revision/action must still be
                // pending, then the ordinary executor re-resolves its actual vault key.
                if (!findCardAction(action)) throw new Error('PLUGIN_SECRET_UNAVAILABLE');
                const accepted = deps.bridge.submitInline(action.requestId, {
                  actionId: action.actionId,
                  expectedRevision: action.expectedRevision,
                  value,
                });
                value = '';
                if (!accepted) throw new Error('PLUGIN_SECRET_UNAVAILABLE');
              } catch {
                remote.finish(false);
              }
            })();
            return true;
          }
          return deps.bridge.resolve(action.requestId, {
            kind: 'plugin_setup',
            action: 'run_action',
            actionId: action.actionId,
            expectedRevision: action.expectedRevision,
          });
        }
        return (await deps.bots()?.resolveRemoteOauth(action)) ?? false;
      },
      settingsRequest: (peer, request) =>
        deps.settings?.request(peer, request) ??
        Promise.reject(new Error('PLUGIN_PAGE_UNAVAILABLE')),
  };
}
