/** Requires agent.observe and independent Host consent; metadata only, no messages or files. */
export type PluginObserveTaskStatus = 'running' | 'awaiting' | 'error' | 'done' | 'idle';

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
