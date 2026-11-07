import type { PluginObserveTask, PluginObserveFiles } from '../../shared/pluginObserve.js';

export interface PluginObserveAdapter {
  taskFiles?(project: string, taskId: string, scope: string, guard: () => void): Promise<PluginObserveFiles>;
  openFile?(project: string, taskId: string, fileId: string, scope: string, guard: () => void): Promise<void>;
  projectTasks(project: string): Promise<PluginObserveTask[]>;
  /** Rejects with TARGET_UNAVAILABLE unless projectTasks could list the task; calls guard right before opening. */
  openTask(taskId: string, guard: () => void): Promise<void>;
}

const OBSERVE_ERROR_CODES = new Set(['PERMISSION_DENIED', 'HOST_NOT_READY', 'INVALID_PARAMS', 'TARGET_UNAVAILABLE', 'FILE_UNAVAILABLE']);
const MAX_ID_LENGTH = 4096;

const fail = (code: string) => ({ ok: false as const, error: { code, message: code, retryable: false } });
const idParam = (value: unknown) =>
  typeof value === 'string' && value.trim() !== '' && value.length <= MAX_ID_LENGTH ? value : null;

/**
 * Read-only `cindy.observe`. The caller has already confirmed the plugin's
 * independent observe approval; `assertAuthorized` re-checks it after each await.
 */
export async function handlePluginObserveRequest(
  adapter: PluginObserveAdapter | null,
  payload: unknown,
  assertAuthorized: () => void,
  fileScope?: string,
) {
  if (!adapter) return fail('HOST_NOT_READY');
  const request = payload as { kind?: unknown; project?: unknown; taskId?: unknown; fileId?: unknown } | null;
  try {
    if (request?.kind === 'task-files' || request?.kind === 'open-file') {
      assertAuthorized();
      if (!fileScope) return fail('PERMISSION_DENIED');
      const project = idParam(request.project);
      const taskId = idParam(request.taskId);
      if (!project || !taskId) return fail('INVALID_PARAMS');
      if (request.kind === 'task-files') {
        if (!adapter.taskFiles) return fail('HOST_NOT_READY');
        const data = await adapter.taskFiles(project, taskId, fileScope, assertAuthorized);
        assertAuthorized();
        return { ok: true as const, data };
      }
      if (typeof request.fileId !== 'string' || !/^[a-f0-9]{64}$/.test(request.fileId)) return fail('INVALID_PARAMS');
      if (!adapter.openFile) return fail('HOST_NOT_READY');
      await adapter.openFile(project, taskId, request.fileId, fileScope, assertAuthorized);
      return { ok: true as const, data: { opened: true } };
    }
    if (request?.kind === 'project-tasks') {
      const project = idParam(request.project);
      if (!project) return fail('INVALID_PARAMS');
      const tasks = await adapter.projectTasks(project);
      assertAuthorized();
      return { ok: true as const, data: { tasks } };
    }
    if (request?.kind === 'open-task') {
      const taskId = idParam(request.taskId);
      if (!taskId) return fail('INVALID_PARAMS');
      await adapter.openTask(taskId, assertAuthorized);
      return { ok: true as const, data: { opened: true } };
    }
    return fail('INVALID_PARAMS');
  } catch (error) {
    const code = (error as { code?: unknown })?.code ?? (error instanceof Error ? error.message : '');
    return fail(OBSERVE_ERROR_CODES.has(String(code)) ? String(code) : 'HOST_NOT_READY');
  }
}
