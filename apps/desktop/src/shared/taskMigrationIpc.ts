import type { TaskMigrationRequest, TaskMigrationView } from '@cindy/device-link';

export type TaskProjectMoveRequest = Extract<TaskMigrationRequest, { action: 'move-project' }>;

/** Only trusted local IPC can return this receipt without a Device Link identity. */
export interface LocalTaskProjectMoveReceipt {
  supported: true;
  projectMove: NonNullable<TaskMigrationView['projectMove']>;
}

/** Remote responses retain the required deviceId in the shared wire contract. */
export type TaskMigrationIpcResult<Request extends TaskMigrationRequest> =
  Request extends TaskProjectMoveRequest
    ? LocalTaskProjectMoveReceipt | TaskMigrationView
    : TaskMigrationView;
