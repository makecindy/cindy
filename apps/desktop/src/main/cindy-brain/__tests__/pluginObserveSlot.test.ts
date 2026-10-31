import { expect, it, vi } from 'vitest';
import { handlePluginObserveRequest, type PluginObserveAdapter } from '../pluginObserveSlot.js';

const task = { id: 't', title: 'Task', agentKind: 'cc', archived: false, status: 'idle' as const, lastActivityAt: 1 };
const adapter = (): PluginObserveAdapter => ({
  projectTasks: vi.fn(async () => [task]),
  openTask: vi.fn(async (_id: string, guard: () => void) => guard()),
});
const denied = () => { throw Object.assign(new Error('PERMISSION_DENIED'), { code: 'PERMISSION_DENIED' }); };

// unit: request parsing and fail-closed authorization around the adapter; no Host or database.
it('returns task metadata and opens a task through the guarded adapter', async () => {
  const a = adapter();
  expect(await handlePluginObserveRequest(a, { kind: 'project-tasks', project: '/repo' }, () => {})).toEqual({ ok: true, data: { tasks: [task] } });
  expect(await handlePluginObserveRequest(a, { kind: 'open-task', taskId: 't' }, () => {})).toEqual({ ok: true, data: { opened: true } });
  expect(a.openTask).toHaveBeenCalledWith('t', expect.any(Function));
});

it.each([
  [{ kind: 'project-tasks' }],
  [{ kind: 'project-tasks', project: ' ' }],
  [{ kind: 'open-task', taskId: 42 }],
  [{ kind: 'open-task', taskId: 'x'.repeat(4097) }],
  [{ kind: 'read-messages', taskId: 't' }],
  [null],
])('rejects %j before touching the adapter', async (payload) => {
  const a = adapter();
  expect(await handlePluginObserveRequest(a, payload, () => {})).toMatchObject({ ok: false, error: { code: 'INVALID_PARAMS' } });
  expect(a.projectTasks).not.toHaveBeenCalled();
  expect(a.openTask).not.toHaveBeenCalled();
});

it('drops results when approval changes during the read and maps unknown failures', async () => {
  const a = adapter();
  expect(await handlePluginObserveRequest(a, { kind: 'project-tasks', project: '/repo' }, denied)).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
  expect(await handlePluginObserveRequest(a, { kind: 'open-task', taskId: 't' }, denied)).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
  a.projectTasks = async () => { throw new Error('TARGET_UNAVAILABLE'); };
  expect(await handlePluginObserveRequest(a, { kind: 'project-tasks', project: '/x' }, () => {})).toMatchObject({ ok: false, error: { code: 'TARGET_UNAVAILABLE' } });
  a.projectTasks = async () => { throw new Error('/secret/path leaked in message'); };
  expect(await handlePluginObserveRequest(a, { kind: 'project-tasks', project: '/x' }, () => {})).toMatchObject({ ok: false, error: { code: 'HOST_NOT_READY', message: 'HOST_NOT_READY' } });
  expect(await handlePluginObserveRequest(null, { kind: 'project-tasks', project: '/x' }, () => {})).toMatchObject({ ok: false, error: { code: 'HOST_NOT_READY' } });
});
