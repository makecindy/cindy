import type { PluginObserveTask } from '../../shared/pluginObserve.js';

export interface PluginObserveAdapter {
  projectTasks(project: string): Promise<PluginObserveTask[]>;
  /** Rejects with TARGET_UNAVAILABLE unless projectTasks could list the task; calls guard right before opening. */
  openTask(taskId: string, guard: () => void): Promise<void>;
}

const OBSERVE_ERROR_CODES = new Set(['PERMISSION_DENIED', 'HOST_NOT_READY', 'INVALID_PARAMS', 'TARGET_UNAVAILABLE']);
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
) {
  if (!adapter) return fail('HOST_NOT_READY');
  const request = payload as { kind?: unknown; project?: unknown; taskId?: unknown } | null;
  try {
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
