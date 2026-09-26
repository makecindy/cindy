/** Ordinary local Session API. No Bot/Orca identity or permission override is accepted. */
export interface PluginTaskRoute {
  agentKind: 'cc' | 'codex' | 'pi';
  providerId: string;
  model: string;
  effort: string;
  fastMode: boolean;
}
export type PluginTaskRunStatus =
  | 'queued'
  | 'running'
  | 'stopping'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted'
  | 'reconciling';
export interface PluginTaskView {
  taskId: string;
  title: string;
  status: 'active' | 'archived' | 'deleted';
  revision: number;
  resolvedConfig: PluginTaskRoute;
  workingDir?: string;
  permissionMode?: string;
}
export interface PluginTaskRun {
  runId: string;
  taskId: string;
  inputMessageId: string;
  status: PluginTaskRunStatus;
  acceptedAt: number;
  acceptedConfig: PluginTaskRoute;
  execution?: { instanceId: string; generation: number };
  /** Host-observed retry input aliases; never supplied by the plugin. */
  inputClientIds?: string[];
  outputMessageId?: string;
  completedAt?: number;
  error?: string;
  usage: { status: 'unavailable'; reason: string };
}
export interface PluginTeamPlan {
  concurrency: number | null;
  items: Array<{label: string; workingDir: string; route: PluginTaskRoute}>;
}
export type PluginTaskRequest =
  | { type: 'tasks-request'; kind: 'capabilities' }
  | {
      type: 'tasks-request';
      kind: 'create';
      requestKey: string;
      title: string;
      route?: PluginTaskRoute;
      isolatedWorkspace?: boolean;
    }
  | { type: 'tasks-request'; kind: 'list'; after?: string; limit?: number }
  | { type: 'tasks-request'; kind: 'get'; taskId: string }
  | { type: 'tasks-request'; kind: 'startTeam' | 'getTeam'; taskId: string }
  | { type: 'tasks-request'; kind: 'setTeamPlan'; taskId: string; plan: PluginTeamPlan }
  | { type: 'tasks-request'; kind: 'releaseWorker'; taskId: string; workerId: string; completedAt: number }
  | { type: 'tasks-request'; kind: 'requestWriteAccess'; taskId: string; mode?: 'acceptEdits' | 'auto' }
  | { type: 'tasks-request'; kind: 'readMessages'; taskId: string; after?: string; limit?: number }
  | {
      type: 'tasks-request';
      kind: 'send';
      taskId: string;
      requestKey: string;
      expectedRevision: number;
      text: string;
    }
  | { type: 'tasks-request'; kind: 'getRun'; runId: string }
  | { type: 'tasks-request'; kind: 'listRuns'; taskId: string; after?: string; limit?: number }
  | { type: 'tasks-request'; kind: 'cancel'; runId: string; requestKey: string };
export type PluginTaskResult =
  | { ok: true; data: unknown }
  | {
      ok: false;
      error: { code: string; message: string; retryable: boolean };
    };
