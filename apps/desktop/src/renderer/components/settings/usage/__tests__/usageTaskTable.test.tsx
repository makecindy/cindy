// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UsageHistoryPayload, UsageHistoryTask } from '@/hooks/useUsageHistory';
import { UsageTaskTable, buildUsageTaskRows, usageTaskCoverageStart } from '../UsageTaskTable';

const state = vi.hoisted(() => ({
  navigate: vi.fn(),
  remoteSessions: [] as Array<{
    id: string;
    deviceLinkDeviceId?: string;
    deviceLinkConnectionStatus?: string;
  }>,
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
vi.mock('react-router-dom', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-router-dom')>()),
  useNavigate: () => state.navigate,
}));
vi.mock('@/hooks/useProviders', () => ({ useProviders: () => ({ providers: [] }) }));
vi.mock('@/features/device-link/remoteProjectsStore', () => ({
  useRemoteProjectSessions: () => state.remoteSessions,
}));
vi.mock('@/lib/orcaSessionIdentity', () => ({
  resolveSessionRoute: async (id: string) => `/cc-agent/${id}`,
}));
afterEach(() => {
  cleanup();
  state.navigate.mockReset();
  state.remoteSessions = [];
});

function task(deviceId: string, sessionId: string, title = sessionId): UsageHistoryTask {
  return {
    taskKey: `${deviceId}:${sessionId}`,
    deviceId,
    sessionId,
    title,
    model: 'gpt-5.5',
    providerId: null,
    contextTokens: 0,
    contextWindow: 0,
    lastActiveAt: 1,
  };
}

function history(
  taskDaily: UsageHistoryPayload['taskDaily'],
  tasks: UsageHistoryTask[],
): UsageHistoryPayload {
  return { todayKey: '2026-09-26', taskDaily, tasks } as UsageHistoryPayload;
}

describe('buildUsageTaskRows', () => {
  const payload = history(
    [
      { day: '2026-09-26', taskKey: 'local:a', tokens: 100 },
      { day: '2026-09-10', taskKey: 'local:a', tokens: 900 },
      { day: '2026-09-26', taskKey: 'laptop:b', tokens: 300 },
      { day: '2026-09-25', taskKey: 'local:b', tokens: 50 },
    ],
    [task('local', 'a'), task('laptop', 'b'), task('local', 'b')],
  );

  it('sums only the tokens inside the selected range and ranks by them', () => {
    expect(buildUsageTaskRows(payload, 'today').map((r) => [r.taskKey, r.tokens])).toEqual([
      ['laptop:b', 300],
      ['local:a', 100],
    ]);
    expect(buildUsageTaskRows(payload, '30d').map((r) => [r.taskKey, r.tokens])).toEqual([
      ['local:a', 1000],
      ['laptop:b', 300],
      ['local:b', 50],
    ]);
    expect(buildUsageTaskRows(payload, 'day:2026-09-25').map((r) => r.taskKey)).toEqual([
      'local:b',
    ]);
  });

  it('keeps the same session id on two devices as separate tasks', () => {
    expect(buildUsageTaskRows(payload, 'all').map((r) => r.taskKey)).toContain('local:b');
    expect(buildUsageTaskRows(payload, 'all').map((r) => r.taskKey)).toContain('laptop:b');
  });

  it('reports the coverage start only when the range reaches before the first record', () => {
    expect(usageTaskCoverageStart(payload, 'all')).toBe('2026-09-10');
    expect(usageTaskCoverageStart(payload, '30d')).toBe('2026-09-10');
    expect(usageTaskCoverageStart(payload, '7d')).toBeNull();
  });
});

describe('UsageTaskTable navigation', () => {
  it('opens local tasks and reachable remote tasks, and leaves unreachable remote tasks inert', async () => {
    state.remoteSessions = [
      { id: 'remote-ok', deviceLinkDeviceId: 'laptop', deviceLinkConnectionStatus: 'connected' },
      // 断线后保留的快照、以及另一台电脑上的同名任务都不可点击。
      {
        id: 'remote-offline',
        deviceLinkDeviceId: 'laptop',
        deviceLinkConnectionStatus: 'disconnected',
      },
      {
        id: 'other-device',
        deviceLinkDeviceId: 'desktop',
        deviceLinkConnectionStatus: 'connected',
      },
    ];
    const rows = [
      { ...task('local', 'mine', 'Mine'), tokens: 3 },
      { ...task('laptop', 'remote-ok', 'Reachable'), tokens: 2 },
      { ...task('laptop', 'remote-gone', 'Unreachable'), tokens: 1 },
      { ...task('laptop', 'remote-offline', 'Offline'), tokens: 1 },
      { ...task('laptop', 'other-device', 'Elsewhere'), tokens: 1 },
    ];
    const view = render(
      <MemoryRouter>
        <UsageTaskTable
          rows={rows}
          rangeLabel="30d"
          devices={[
            {
              deviceId: 'laptop',
              name: 'Laptop',
              platform: null,
              isSelf: false,
              syncedAt: 1,
              status: 'ok',
            },
          ]}
        />
      </MemoryRouter>,
    );
    fireEvent.click(view.getByRole('link', { name: 'Mine' }));
    await waitFor(() => expect(state.navigate).toHaveBeenLastCalledWith('/cc-agent/mine'));

    fireEvent.click(view.container.querySelector('tr[data-task-key="laptop:remote-ok"]')!);
    await waitFor(() => expect(state.navigate).toHaveBeenLastCalledWith('/cc-agent/remote-ok'));
    expect(view.getAllByText('Laptop')).toHaveLength(4);

    expect(view.queryByRole('link', { name: 'Unreachable' })).toBeNull();
    expect(view.queryByRole('link', { name: 'Offline' })).toBeNull();
    expect(view.queryByRole('link', { name: 'Elsewhere' })).toBeNull();
    fireEvent.click(view.container.querySelector('tr[data-task-key="laptop:remote-gone"]')!);
    expect(state.navigate).toHaveBeenCalledTimes(2);
  });
});
