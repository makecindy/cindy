/** Requires agent.observe and independent Host consent; metadata only, no messages or files. */
const taskStatuses = ['running', 'awaiting', 'error', 'done', 'idle'] as const;
export type PluginObserveTaskStatus = typeof taskStatuses[number];
export const isPluginObserveTaskStatus = (value: unknown): value is PluginObserveTaskStatus =>
  taskStatuses.some(status => status === value);

export type PluginSessionStatus = { id: string; status: PluginObserveTaskStatus };
export const SESSION_STATUS_PROJECTION = 'sidebar-status';

/** Shared by the plugin slot and the source computer's status-only batch read. */
export function parseSessionStatusIds(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 200) return null;
  const ids = new Set<string>();
  for (const id of value) {
    if (typeof id !== 'string' || !id.trim() || id.length > 256 || id.includes('::') || /[\u0000-\u001f\u007f]/.test(id)) return null;
    ids.add(id);
  }
  return [...ids];
}

export interface PluginObserveTask {
  id: string;
  title: string;
  agentKind: string;
  archived: boolean;
  /** Same projection as the sidebar right-side status. */
  status: PluginObserveTaskStatus;
  /** Unix ms used for sidebar ordering. */
  lastActivityAt: number;
}
