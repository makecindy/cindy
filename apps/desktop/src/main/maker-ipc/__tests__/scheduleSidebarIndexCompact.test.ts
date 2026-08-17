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

import {
  __resetReadinessForTest,
  parseCompactSidebarIndexRequest,
  registerScheduleHandlers,
  serializeCompactSidebarIndexRuns,
  setSchedulerReady,
} from '../schedule';
import { isIpcErrorCode } from '../../../shared/ipc-errors';

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
      inflightRunIds: [],
    });
    expect(storage.listSidebarIndexRuns).toHaveBeenLastCalledWith({ compact: true });

    await expect(handler?.({})).resolves.toEqual({
      runs: [fullRow],
      inflightRunIds: ['running-1'],
    });
    expect(storage.listSidebarIndexRuns).toHaveBeenLastCalledWith();
  });

  it('strictly validates, deduplicates and caps compact session IDs', () => {
    expect(parseCompactSidebarIndexRequest({
      compact: true,
      sessionIds: ['a', 'a', 'b'],
    })).toEqual({ compact: true, sessionIds: ['a', 'b'] });
    expect(() => parseCompactSidebarIndexRequest({ compact: true, sessionIds: 'a' }))
      .toThrow(/sessionIds must be an array/);
    expect(() => parseCompactSidebarIndexRequest({
      compact: true,
      sessionIds: Array.from({ length: 201 }, (_, index) => `s-${index}`),
    })).toThrow(/at most 200/);
    expect(() => parseCompactSidebarIndexRequest({
      compact: true,
      sessionIds: ['x'.repeat(513)],
    })).toThrow(/at most 512/);
  });

  it('rejects the complete UTF-8 snapshot instead of returning a partial result', () => {
    expect(isIpcErrorCode('PAYLOAD_TOO_LARGE')).toBe(true);
    const huge = {
      runId: `run-${'中\\"'.repeat(200)}`,
      scheduleId: 'schedule-1',
      scheduleName: 'Daily',
      scheduleStatus: 'active',
      sessionId: 'session-1',
      firedAt: 1,
      status: 'success',
    } as const;
    expect(() => serializeCompactSidebarIndexRuns([huge], 256)).toThrow(/PAYLOAD_TOO_LARGE/);
    expect(() => serializeCompactSidebarIndexRuns([huge], 4_096)).not.toThrow();
  });
});
