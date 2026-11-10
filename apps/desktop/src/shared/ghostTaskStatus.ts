/** Plain-text task-view launcher; no HTML, tool invocation or task contents. */
export const GHOST_TASK_STATUS_CHANNEL = 'ghosts:task-status';
export interface GhostTaskStatus {
  instanceId: string;
  name: string;
  label: string;
  tooltip?: string;
}
export interface GhostTaskStatusRequest {
  type: 'task-status';
  requestId: string;
  sessionId: string;
}
export interface GhostTaskStatusReply {
  requestId: string;
  label: string;
  tooltip?: string;
}
