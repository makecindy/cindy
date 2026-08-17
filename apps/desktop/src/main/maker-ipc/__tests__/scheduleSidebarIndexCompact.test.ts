import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  ipcHandle: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcMain: { handle: h.ipcHandle },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  app: {
    getPath: vi.fn(() => '/tmp/cindy-test-user-data'),
    getAppPath: vi.fn(() => '/tmp/cindy-test-app'),
    isPackaged: false,
  },
}));

vi.mock('../../device-link/broadcast-tap.js', () => ({
  getSafeDataOwnerPushStamp: vi.fn(() => undefined),
  tapWindowBroadcast: vi.fn(),
}));

vi.mock('../../agent-island/service.js', () => ({
  getAgentIslandService: () => null,
}));

import { __resetReadinessForTest, registerScheduleHandlers, setSchedulerReady } from '../schedule';

beforeEach(() => {
  h.ipcHandle.mockClear();
  __resetReadinessForTest();
});

describe('schedule sidebar index compact IPC', () => {
  it('passes compact to storage and removes Desktop-only repeated schedule fields', async () => {
    const fullRow = {
      runId: 'binding:schedule:session',
      scheduleId: 'schedule-1',
      scheduleName: 'A very long automation name',
      scheduleStatus: 'active',
      scheduleSource: 'project',
      nextFireAt: 123,
      workingDir: '/a/repeated/working/directory',
      projectConfigId: 'project-config-1',
      sessionId: 'session-1',
      firedAt: 100,
      associationOnly: true,
      status: 'success',
      readAt: 100,
    } as const;
    const storage = {
      listSidebarIndexRuns: vi.fn(async () => [fullRow]),
    };
    const scheduler = {
      listInflightRunIds: vi.fn(() => ['running-1']),
    };
    setSchedulerReady(scheduler as never, storage as never);
    registerScheduleHandlers();

    const handler = h.ipcHandle.mock.calls.find(
      ([channel]) => channel === 'maker:schedule:list-sidebar-index-runs',
    )?.[1] as ((event: unknown, request?: unknown) => Promise<unknown>) | undefined;
    expect(handler).toBeTypeOf('function');

    await expect(handler?.({}, { compact: true })).resolves.toEqual({
      runs: [
        {
          runId: fullRow.runId,
          scheduleId: fullRow.scheduleId,
          sessionId: fullRow.sessionId,
          firedAt: fullRow.firedAt,
          associationOnly: true,
          status: fullRow.status,
          readAt: fullRow.readAt,
        },
      ],
      inflightRunIds: ['running-1'],
    });
    expect(storage.listSidebarIndexRuns).toHaveBeenLastCalledWith({ compact: true });

    await expect(handler?.({})).resolves.toEqual({
      runs: [fullRow],
      inflightRunIds: ['running-1'],
    });
    expect(storage.listSidebarIndexRuns).toHaveBeenLastCalledWith();
  });
});
