import type { InstalledGhost } from '../../shared/ghost.js';
import type { PluginTaskRequest, PluginTaskResult } from '../../shared/pluginTasks.js';

export const PLUGIN_TASK_OPERATIONS = [
  'capabilities',
  'requestWriteAccess',
  'startTeam',
  'getTeam',
  'setTeamPlan',
  'releaseWorker',
  'create',
  'list',
  'get',
  'send',
  'getRun',
  'listRuns',
  'cancel',
  'readMessages',
] as const;
export type PluginTaskHandler = (pluginId: string, request: PluginTaskRequest) => Promise<unknown>;
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown, max: number) =>
  typeof v === 'string' && v.trim().length > 0 && v.length <= max;
export function validPluginTaskRequest(value: unknown): value is PluginTaskRequest {
  if (!object(value) || value.type !== 'tasks-request') return false;
  const allowed: Record<string, string[]> = {
    capabilities: [],
    create: ['requestKey', 'title', 'route', 'isolatedWorkspace'],
    list: ['after', 'limit'],
    get: ['taskId'],
    requestWriteAccess: ['taskId', 'mode'],
    startTeam: ['taskId'],
    getTeam: ['taskId'],
    setTeamPlan: ['taskId', 'plan'],
    releaseWorker: ['taskId', 'workerId', 'completedAt'],
    send: ['taskId', 'requestKey', 'expectedRevision', 'text'],
    getRun: ['runId'],
    listRuns: ['taskId', 'after', 'limit'],
    readMessages: ['taskId', 'after', 'limit'],
    cancel: ['runId', 'requestKey'],
  };
  if (typeof value.kind !== 'string' || !Object.hasOwn(allowed, value.kind)) return false;
  const kind = value.kind;
  if (Object.keys(value).some((key) => !['type', 'kind', ...allowed[kind]].includes(key)))
    return false;
  if (kind === 'requestWriteAccess' && value.mode !== undefined && !['acceptEdits', 'auto'].includes(String(value.mode))) return false;
  const requires = (key: string) => text(value[key], 128);
  if (['create', 'send', 'cancel'].includes(value.kind) && !requires('requestKey')) return false;
  if (['get', 'send', 'listRuns', 'readMessages', 'requestWriteAccess', 'startTeam', 'getTeam', 'setTeamPlan', 'releaseWorker'].includes(value.kind) && !requires('taskId'))
    return false;
  if (['getRun', 'cancel'].includes(value.kind) && !requires('runId')) return false;
  if (value.isolatedWorkspace !== undefined && typeof value.isolatedWorkspace !== 'boolean') return false;
  if (value.kind === 'create' && !text(value.title, 100)) return false;
  if (
    value.kind === 'send' &&
    (!text(value.text, 32768) ||
      !Number.isSafeInteger(value.expectedRevision) ||
      (value.expectedRevision as number) < 0)
  )
    return false;
  if (value.after !== undefined && !text(value.after, 1024)) return false;
  if (
    value.limit !== undefined &&
    (!Number.isInteger(value.limit) || (value.limit as number) < 1 || (value.limit as number) > 100)
  )
    return false;
  if (kind === 'releaseWorker' && (!requires('workerId') || !Number.isSafeInteger(value.completedAt) || (value.completedAt as number) <= 0)) return false;
  if (kind === 'setTeamPlan') {
    const p = value.plan;
    if (!object(p) || Object.keys(p).some(k => !['concurrency','items'].includes(k)) ||
        (p.concurrency !== null && (!Number.isSafeInteger(p.concurrency) || (p.concurrency as number) < 1)) ||
        !Array.isArray(p.items) || !p.items.length || p.items.length > 1000) return false;
    const labels = new Set<string>();
    for (const item of p.items) {
      if (!object(item) || Object.keys(item).some(k => !['label','workingDir','route'].includes(k)) ||
          !text(item.label,32) || !/^[a-z0-9][a-z0-9_-]*$/.test(String(item.label)) || labels.has(String(item.label)) || !text(item.workingDir,4096) ||
          !validPluginTaskRequest({type:'tasks-request',kind:'create',requestKey:'validate',title:'validate',route:item.route}) || !item.route) return false;
      labels.add(String(item.label));
    }
  }
  if (value.route !== undefined) {
    const r = value.route;
    if (
      !object(r) ||
      Object.keys(r).some(
        (k) => !['agentKind', 'providerId', 'model', 'effort', 'fastMode'].includes(k),
      )
    )
      return false;
    if (
      !['cc', 'codex', 'pi'].includes(String(r.agentKind)) ||
      !text(r.providerId, 128) ||
      !text(r.model, 256) ||
      !text(r.effort, 32) ||
      typeof r.fastMode !== 'boolean'
    )
      return false;
  }
  return true;
}

/** Sender binding is performed by the pipe; the payload can never claim a plugin identity. */
export async function handlePluginTaskRequest(
  pluginId: string,
  value: unknown,
  deps: {
    getGhost(id: string): InstalledGhost | null;
    handler: PluginTaskHandler | null;
    isCurrent: () => boolean;
  },
): Promise<PluginTaskResult> {
  const permitted = () =>
    deps.isCurrent() &&
    deps.getGhost(pluginId)?.enabled === true &&
    deps.getGhost(pluginId)?.manifest.agent?.tasks === true;
  const error = (code: string, message: string, retryable = false): PluginTaskResult => ({
    ok: false,
    error: { code, message, retryable },
  });
  if (!permitted()) return error('PERMISSION_DENIED', 'Plugin task capability is unavailable');
  if (!validPluginTaskRequest(value)) return error('INVALID_REQUEST', 'Invalid task request');
  if (value.kind === 'capabilities')
    return {
      ok: true,
      data: {
        version: 1,
        experimental: true,
        operations: PLUGIN_TASK_OPERATIONS,
        targets: ['own-plugin-local-session'],
        maxPageSize: 100,
        exactRoute: true,
      },
    };
  if (!deps.handler) return error('HOST_NOT_READY', 'Task service is not ready', true);
  try {
    const data = await deps.handler(pluginId, value);
    if (!permitted()) return error('PERMISSION_DENIED', 'Plugin task capability is unavailable');
    return { ok: true, data };
  } catch (err) {
    // Only explicit public errors cross the sandbox boundary, never internal DB/path errors.
    if (
      object(err) &&
      err.name === 'PluginTaskError' &&
      typeof err.code === 'string' &&
      typeof err.message === 'string'
    ) {
      return error(err.code, err.message, err.retryable === true);
    }
    return error(
      'HOST_NOT_READY',
      'Task operation could not be confirmed; reuse the same request key',
      true,
    );
  }
}
