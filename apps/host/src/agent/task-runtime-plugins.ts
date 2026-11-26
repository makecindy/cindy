import { holdError, type ProfileHold } from './profile-hold.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Maker } from '@cindy/maker-core';
import type { createRuntimePluginHost } from '../../../desktop/src/main/cindy-brain/runtimePluginHostCore.js';
import {
  createPrepareTaskRuntimePluginTurn, createRuntimePluginInputHooks, createRuntimePluginSettingsHandler, createRuntimePluginTaskPrompt,
} from '../../../desktop/src/main/maker-ipc/runtimePluginTaskBindings.js';
import { revokeTrustedDesktopQueuedOrigin } from '../../../desktop/src/main/maker-ipc/queuedInputOrigin.js';
import { writeRuntimePluginSettings } from '../../../desktop/src/main/maker-host/runtime-plugin-settings.js';
import { captureDataOwnerBroadcastScope, isDataOwnerBroadcastScopeCurrent } from '../../../desktop/src/main/device-link/broadcast-tap.js';
import { throwIpcError } from '../../../desktop/src/main/utils/ipcValidate.js';
import type { Logger } from '../../../desktop/src/main/logger.js';
import type { createHostRuntimeSelection } from './runtime-selection.js';

type PluginHost = ReturnType<typeof createRuntimePluginHost>;
type RuntimeSelection = ReturnType<typeof createHostRuntimeSelection>;

export function createHostTaskRuntimePlugins({
  getMaker, pluginHost, selection, publish, log,
}: {
  getMaker(): Pick<Maker, 'getSession' | 'createSession' | 'closeSession'>;
  pluginHost: PluginHost;
  selection: Pick<RuntimeSelection, 'readSessionRuntimeProfiles' | 'applyPluginRoute'>;
  publish(event: Record<string, unknown>): void;
  log: Pick<Logger, 'info'>;
}) {
  const maker: ReturnType<typeof getMaker> = {
    getSession: id => getMaker().getSession(id),
    createSession: (opts, signal) => getMaker().createSession(opts, signal),
    closeSession: (id, reason) => getMaker().closeSession(id, reason),
  };
  const runtimePluginControl = pluginHost.getGhostRuntimePluginControl();
  const turnGuard = new AsyncLocalStorage<() => void>();
  const prepare = createPrepareTaskRuntimePluginTurn({
    maker, runtimePluginControl, readSessionRuntimeProfiles: selection.readSessionRuntimeProfiles,
    isPluginModelRouteAvailableNow: pluginHost.isPluginModelRouteAvailableNow, log,
    applyRoute(id, route, assertVerdict) {
      const assertTurn = turnGuard.getStore();
      if (!assertTurn) throw new Error('Plugin route has no originating Host turn');
      return selection.applyPluginRoute(id, route, assertVerdict, assertTurn);
    },
  });
  return {
    ...createRuntimePluginTaskPrompt({
      maker, ghostTaskSystemPrompt: pluginHost.ghostTaskSystemPrompt,
      readSessionRuntimeProfiles: selection.readSessionRuntimeProfiles,
    }),
    ...createRuntimePluginInputHooks({
      getStableSessionForTurnBoundary: maker.getSession,
      screenGhostUserMessage: pluginHost.screenGhostUserMessage,
      // Agent Island only previews input on the desktop. A rewritten steer can
      // still carry a previously restored local command receipt, so revoke it.
      rollbackAgentIslandUserPrompt() {}, revokeTrustedDesktopQueueOrigin: revokeTrustedDesktopQueuedOrigin,
      broadcastGhostMessageBlocked: payload => publish({ type: 'plugin_push', channel: 'ghosts:user-message-blocked', payload }),
      broadcastGhostMessageRewritten: payload => publish({ type: 'plugin_push', channel: 'ghosts:user-message-rewritten', payload }),
    }),
    forgetSession: runtimePluginControl.forgetSession,
    composeRuntimeContext: pluginHost.composeGhostRuntimeContext,
    prepareRuntimeTurn(id: string, message: unknown, signal: AbortSignal | undefined, assertTurn: () => void) {
      return turnGuard.run(assertTurn, () => prepare(id, message, signal));
    },
  };
}

export function createHostRuntimePluginSettings(deps: {
  maker: Pick<Maker, 'getSessionMeta'>;
  selection: Pick<RuntimeSelection, 'assertReviewSettingsUnlocked'>;
  resolveGhostControlPointPlugin: PluginHost['resolveGhostControlPointPlugin'];
  profileHold(): ProfileHold | null;
  holdGeneration(): number;
  publish(event: Record<string, unknown>): void;
}) {
  return (sessionId: unknown, value: unknown) => {
    const hold = deps.holdGeneration();
    const owner = captureDataOwnerBroadcastScope();
    const assertCurrent = () => {
      const held = deps.profileHold();
      if (held || hold !== deps.holdGeneration())
        throw holdError(held ?? 'HOST_PROFILE_IN_USE_BY_DESKTOP: Profile ownership changed');
      if (!isDataOwnerBroadcastScopeCurrent(owner)) throwIpcError('PRECONDITION_FAILED', 'Account changed');
    };
    return createRuntimePluginSettingsHandler({
      maker: deps.maker,
      assertCaller: assertCurrent,
      captureDataOwnerBroadcastScope: () => owner,
      isDataOwnerBroadcastScopeCurrent: scope => {
        assertCurrent();
        return isDataOwnerBroadcastScopeCurrent(scope);
      },
      assertReviewSettingsUnlocked: deps.selection.assertReviewSettingsUnlocked,
      resolveGhostControlPointPlugin: deps.resolveGhostControlPointPlugin,
      writeRuntimePluginSettings: (id, settings) => writeRuntimePluginSettings(id, settings, assertCurrent),
      broadcastSessionPatched: (id, patch) => deps.publish({ type: 'session_changed', sessionId: id, patch }),
    })(undefined, sessionId, value);
  };
}
