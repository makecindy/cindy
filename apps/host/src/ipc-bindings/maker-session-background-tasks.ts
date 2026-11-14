import type { BackgroundTaskSnapshot } from '@cindy/maker-core';
import {
  snapshotSessionBackgroundTasks,
  type SessionBackgroundTasks,
  type SessionBackgroundTasksSource,
} from '../../../desktop/src/main/maker-ipc/sessionBackgroundTasksSnapshot.js';
import type { HostIpcBinding, HostIpcResultFields, ResultFields } from './index.js';

export interface MakerSessionBackgroundTasksDeps {
  /** The Host's live session, if this Host is running it; undefined before the owner runtime starts. */
  readonly getLiveSession: (sessionId: string) => SessionBackgroundTasksSource | undefined;
}

/**
 * Result objects of this family, keyed by the types the handler returns: a
 * field added, removed or made optional in maker-core fails type checking here,
 * and the route test compares the tables with the registry schema.
 */
export const MAKER_SESSION_BACKGROUND_TASKS_RESULT_FIELDS = {
  'maker:session-background-tasks:list': {
    result: { pendingContinuations: 'required', tasks: 'required' } satisfies ResultFields<SessionBackgroundTasks>,
    'result.tasks[]': {
      backgroundCommandKind: 'optional',
      outputFile: 'optional',
      provider: 'optional',
      taskId: 'required',
      taskType: 'optional',
      title: 'optional',
      toolUseId: 'optional',
    } satisfies ResultFields<BackgroundTaskSnapshot>,
  },
} as const satisfies HostIpcResultFields;

/** Registry family `maker-session-background-tasks`. */
export function makerSessionBackgroundTasksIpcBindings(deps: MakerSessionBackgroundTasksDeps): Record<string, HostIpcBinding> {
  return {
    'maker:session-background-tasks:list': ([sessionId]) => snapshotSessionBackgroundTasks(deps.getLiveSession(sessionId as string)),
  };
}
