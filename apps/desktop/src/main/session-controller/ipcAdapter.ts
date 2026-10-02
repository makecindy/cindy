import type { IpcMain } from 'electron';
import type { SessionOperation } from '@cindy/maker-shared/session-controller';
import { MAKER_INVOKE as C } from '../maker-ipc/channels.js';
import { createSessionController, sessionOperation, type SessionControllerDeps } from './controller.js';
import { requireSessionCaller } from './callerContext.js';
import { withUiSessionCaller } from './uiCaller.js';

/** Transport aliases only. The original handlers retain validation, locks and
 * source-specific result shapes; no JSON roundtrip is added inside Main.
 */
export const SESSION_IPC_OPERATIONS: Readonly<Record<string, SessionOperation>> = {
  [C.CREATE_SESSION]: 'ensureRuntime',
  [C.SEND]: 'send', [C.STEER]: 'steer',
  [C.LIST_ACTIVE]: 'listActive',
  [C.SESSION_TURN_ACTIVE]: 'inspect', [C.SESSION_IN_TURN]: 'inspect',
  [C.GET_CONTEXT_USAGE]: 'inspect',
  [C.INPUT_GET_PROJECTION]: 'inspectQueue', [C.INPUT_ENQUEUE]: 'enqueue',
  [C.INPUT_COMPACT]: 'compact', [C.INPUT_STEER]: 'steer',
  [C.INPUT_STOP]: 'pauseQueue', [C.INPUT_RESUME]: 'resumeQueue',
  [C.INPUT_RETRY_LAST_ERROR]: 'retryInput', [C.INPUT_CLEAR_ERROR]: 'clearInputError',
  [C.INPUT_REMOVE]: 'withdrawOwnedInput', [C.INPUT_UPDATE_TEXT]: 'editOwnedInput',
  [C.INPUT_UPDATE_CONTENT]: 'editOwnedInput', [C.INPUT_MOVE]: 'moveInput',
  [C.INPUT_SET_EXPANDED]: 'updateInputPresentation',
  [C.INPUT_SET_INTERACTION_LOCK]: 'setInputLock', [C.INPUT_SET_EDIT_LOCK]: 'setInputLock',
  [C.INPUT_CLEAR_SESSION]: 'clearInputs',
  [C.ABORT_SESSION]: 'abortTurn', [C.CLOSE_SESSION]: 'closeRuntime',
  [C.STOP_SESSION_BACKGROUND_TASKS]: 'closeRuntime',
  [C.STOP_AGENT_TASK]: 'stopBackgroundTask', [C.LIST_SESSION_BACKGROUND_TASKS]: 'listBackgroundTasks',
  [C.RESOLVE_INTERACTION]: 'resolveInteraction', [C.GET_PENDING_INTERACTIONS]: 'inspectInteractions',
  [C.SET_MODEL]: 'selectRuntime', [C.SWITCH_SESSION_AGENT]: 'selectRuntime',
  [C.SET_EFFORT]: 'selectRuntime', [C.SET_FAST_MODE]: 'selectRuntime',
  [C.SET_THINKING_ENABLED]: 'selectRuntime', [C.GET_SESSION_AGENT_SWITCH_INTENT]: 'inspectRuntime',
  [C.SET_PERMISSION_MODE]: 'changePermission', [C.SET_PLAN_MODE]: 'changePermission',
  [C.COMPACT_SESSION]: 'compact', [C.GET_SESSION_TREE]: 'inspectHistory',
  [C.NAVIGATE_SESSION_TREE]: 'rewind', [C.REWIND_PREVIEW]: 'inspectHistory',
  [C.REWIND_COMMIT]: 'rewind', [C.FORK]: 'fork', [C.FORK_STRIP_ENCRYPTED]: 'fork',
  [C.DELETE_MESSAGE]: 'deleteMessage',
};

type Handler = Parameters<IpcMain['handle']>[1];
type Event = Parameters<Handler>[0];

export function createSessionIpcAdapter(
  registry: Pick<IpcMain, 'handle'>,
  deps: SessionControllerDeps & {
    interactionSessionId(requestId: string): string | undefined;
    withCaller?: <T>(event: Event, run: () => Promise<T>) => Promise<T>;
  },
): Pick<IpcMain, 'handle'> {
  return {
    handle(channel, handler) {
      const operation = SESSION_IPC_OPERATIONS[channel];
      if (!operation) { registry.handle(channel, handler); return; }
      const controller = createSessionController(deps, {
        execute: sessionOperation({
          operation,
          targets: (_event: Event, ...args: unknown[]) => {
            if (operation === 'listActive') return [];
            const first = args[0];
            if (operation === 'resolveInteraction') {
              const id = typeof first === 'string' ? deps.interactionSessionId(first) : undefined;
              return id ? [id] : [];
            }
            // IPC validation remains in the existing handler. An invalid payload
            // cannot supply caller identity and receives its original error there.
            const id = typeof first === 'string' ? first
              : first && typeof first === 'object' && 'sessionId' in first ? first.sessionId
                : first && typeof first === 'object' && 'id' in first ? first.id : undefined;
            return typeof id === 'string' ? [id] : [];
          },
          execute: (_scope, event: Event, ...args: unknown[]) => handler(event, ...args),
        }),
      });
      registry.handle(channel, (event, ...args) => (deps.withCaller ?? withUiSessionCaller)(event,
        () => controller.invoke(controller.issueCaller(requireSessionCaller()), 'execute', event, ...args)));
    },
  };
}
