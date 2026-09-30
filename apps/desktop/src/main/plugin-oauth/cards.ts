import type { PluginOauthAction, PluginConnectionInput } from '@cindy/device-link';
import { randomBytes } from 'node:crypto';
import {
  createPluginSecretPresentation,
  createPluginConnectionPresentation,
} from '../../shared/pluginOauth.js';
import { getRemoteOauthContext } from './context.js';
import type { GhostSetupInteractionBridge } from '../cindy-brain/ghostSetupInteractionBridge.js';
import type { BotAuthorizationService } from '../maker-ipc/botAuthorizationService.js';
import { initializePluginOauthHost, type OauthKeyLoader } from './runtime.js';
import type { OauthIdentityScope } from './identityStore.js';
import type { OauthCardBinding } from './transactions.js';

/** Bind existing Host cards; no new plugin manifest or generic setup permission. */
export function initializePluginOauthCards(deps: {
  bridge: GhostSetupInteractionBridge;
  bots(): BotAuthorizationService | null;
  owner(): string | null;
  available(peer: string): boolean;
  identity: () => OauthIdentityScope | null;
  loadKey: OauthKeyLoader;
  bindConnection?(args: {
    ghostId: string;
    actionId: string;
    onCommitted(): void;
  }): ((value: PluginConnectionInput) => boolean) | null;
}): void {
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
  initializePluginOauthHost(
    {
      owner: deps.owner,
      available: deps.available,
      bind: async (action) =>
        findCardAction(action)?.binding ?? (await deps.bots()?.bindRemoteOauth(action)) ?? null,
      run: async (action) => {
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
    },
    deps.identity,
    deps.loadKey,
  );
}
