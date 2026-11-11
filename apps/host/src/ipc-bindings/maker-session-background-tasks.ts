import {
  snapshotSessionBackgroundTasks,
  type SessionBackgroundTasksSource,
} from '../../../desktop/src/main/maker-ipc/sessionBackgroundTasksSnapshot.js';
import type { HostIpcBinding } from './index.js';

export interface MakerSessionBackgroundTasksDeps {
  /** The Host's live session, if this Host is running it; undefined before the owner runtime starts. */
  readonly getLiveSession: (sessionId: string) => SessionBackgroundTasksSource | undefined;
}

/** Registry family `maker-session-background-tasks`. */
export function makerSessionBackgroundTasksIpcBindings(deps: MakerSessionBackgroundTasksDeps): Record<string, HostIpcBinding> {
  return {
    'maker:session-background-tasks:list': ([sessionId]) => snapshotSessionBackgroundTasks(deps.getLiveSession(sessionId as string)),
  };
}
