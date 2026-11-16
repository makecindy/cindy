import { MODEL_REQUEST_CONTROL, type ModelRequestControl, type SendOptions } from '@cindy/maker-core';
import type { GhostModelRoute, GhostRuntimePointData } from '../../shared/ghost.js';
import { assertRuntimeRequestShape, type RuntimePluginSettings } from '../../shared/pluginRuntime.js';
import { createRuntimePluginControl, RuntimePluginControlError } from '../cindy-brain/runtimeControl.js';
import { prependNoteToWireUserMessage, type HandoffWireMessage } from './agentHandoff.js';
import { pluginMessageText } from '../../shared/pluginMessage.js';

/** Read only the separately captured input; do not parse authored JSON as an envelope. */
export function runtimePluginInputText(message: unknown): string {
  if (typeof message === 'string') return message;
  const content = Array.isArray(message) ? message : (message as { content?: unknown } | null)?.content;
  return typeof content === 'string' ? content : Array.isArray(content)
    ? content.filter(item => item?.type === 'text' && typeof item.text === 'string').map(item => item.text).join('\n') : '';
}

/** Ordinary reference material for normal App sends. */
export function appendRuntimePluginContext(message: HandoffWireMessage, context: string): HandoffWireMessage {
  return context ? prependNoteToWireUserMessage(message, pluginMessageText('', context).trimStart()) : message;
}

export function createTaskRuntimePlugins(deps: {
  control: ReturnType<typeof createRuntimePluginControl>;
  readSettings(sessionId: string): RuntimePluginSettings | undefined;
  readRoute(sessionId: string): Promise<GhostModelRoute>;
  routeAvailable(route: GhostModelRoute): Promise<boolean>;
  applyRoute(sessionId: string, route: GhostModelRoute, assertCurrent: () => void): Promise<void>;
  requestSupported?(sessionId: string): boolean;
  changed(sessionId: string, pluginId: string, phase: string): void;
}) {
  return {
    prepare(sessionId: string, message: unknown, signal?: AbortSignal): Promise<Partial<SendOptions>> | undefined {
      const settings = deps.readSettings(sessionId);
      if (!settings?.['will-start-turn']?.length && !settings?.['will-model-request']?.length
        && !settings?.['will-compose-context']?.length && !settings?.['will-search-memory']?.length) return undefined;
      deps.control.beginTurn(sessionId);
      if (!settings['will-start-turn']?.length && !settings['will-model-request']?.length) return Promise.resolve({});
      return (async () => {
        const text = runtimePluginInputText(message);
        const turn = deps.control.run<GhostRuntimePointData>('will-start-turn', sessionId, async () => ({ sessionId,
          route: await deps.readRoute(sessionId), text,
        }), async (result, data, assertCurrent) => {
          if (result.action !== 'route') return;
          if (!await deps.routeAvailable(result.route)) throw new Error('Unavailable model route');
          assertCurrent();
          await deps.applyRoute(sessionId, result.route, assertCurrent);
          deps.changed(sessionId, result.ghostId, 'turn');
          return { ...data, route: result.route };
        }, signal);
        if (turn) await turn;
        if (!settings['will-model-request']?.length) return {};
        const selected = await deps.readRoute(sessionId);
        if (selected.agentKind !== 'pi' || selected.agentDeviceId || deps.requestSupported?.(sessionId) === false) {
          for (const target of settings['will-model-request']) if (target.onFailure !== 'allow') {
            throw new RuntimePluginControlError(target.onFailure, target.pluginId, true, 'unsupported-engine');
          }
          return {};
        }
        let requestBudget: ReturnType<typeof deps.control.requestBudget> | undefined;
        const control: ModelRequestControl = async input => {
          if (input.phase === 'select' || !requestBudget) requestBudget = deps.control.requestBudget();
          const sharedRequestBudget = requestBudget;
          if (input.phase === 'payload') requestBudget = undefined;
          let changedRoute = false;
          const result = deps.control.run<GhostRuntimePointData>('will-model-request', sessionId, async () => ({ sessionId,
            route: { agentKind: 'pi', providerId: input.providerId, model: input.model },
            phase: input.phase, request: input.request,
          }), async (verdict, data, assertCurrent) => {
            if (verdict.action === 'route') {
              if (verdict.route.agentKind !== 'pi' || verdict.route.agentDeviceId || !await deps.routeAvailable(verdict.route)) {
                throw new Error('Per-request route requires an available local Pi model');
              }
              assertCurrent();
              changedRoute = true;
              deps.changed(sessionId, verdict.ghostId, 'select');
              return { ...data, route: verdict.route };
            }
            if (verdict.action === 'transform') {
              assertRuntimeRequestShape(data.request!, verdict.request);
              deps.changed(sessionId, verdict.ghostId, 'payload');
              return { ...data, request: verdict.request };
            }
          }, signal, input.failure ? new Error('Model request exceeds the Pi transport frame budget') : undefined, sharedRequestBudget);
          if (!result) throw new Error('Runtime selection changed');
          let data;
          try { data = await result; }
          catch (error) {
            if (error instanceof RuntimePluginControlError && error.action === 'skip') return { skip: true as const };
            throw error;
          }
          return { ...(changedRoute ? { route: data.route } : {}), ...(input.phase === 'payload' ? { request: data.request } : {}) };
        };
        return { [MODEL_REQUEST_CONTROL]: control };
      })();
    },
  };
}
