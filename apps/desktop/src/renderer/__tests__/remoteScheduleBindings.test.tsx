// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@/lib/ccAgent.types';
import type { ScheduleBinding } from '@/features/scheduler/lib/scheduleBindingIndex';

const { navigate, ensure, localSchedules } = vi.hoisted(() => ({
  navigate: vi.fn(),
  ensure: vi.fn(async () => []),
  localSchedules: [
    {
      id: 'local',
      name: 'Local',
      targetSessionId: 'task',
      status: 'active',
      cronExpr: '* * * * *',
      manual: false,
      preRunHook: { command: "node gate.mjs 'https://github.com/o/r/pull/7'" },
    },
  ],
}));
vi.mock('@/features/scheduler/lib/schedulesStore', () => ({
  useSchedulesSnapshot: () => localSchedules,
  schedulesStore: { ensure },
}));
vi.mock('react-router-dom', () => ({ useNavigate: () => navigate }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: { name?: string; frequency?: string; defaultValue?: string }) =>
      values?.name ?? values?.frequency ?? values?.defaultValue ?? key,
  }),
}));
vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: {
    Root: ({ children }: { children: ReactNode }) => children,
    Trigger: ({ children }: { children: ReactNode }) => children,
    Content: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  },
}));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() }),
}));

import { useActiveFollowUpSessions, useSessionBoundSchedules } from '@/features/scheduler/lib/scheduleSessionBinding';
import { ScheduleBindingBadge } from '@/features/cc-agent/sidebar/ScheduleBindingBadge';
import { remoteProjectsStore } from '@/features/device-link/remoteProjectsStore';
import { refreshRemoteDeviceSessions } from '@/features/device-link/refreshRemoteSessions';
import { parseScheduleBindings } from '@/features/scheduler/lib/scheduleBindingIndex';
import { setCurrentAuthDeviceId } from '@/lib/authDeviceIdStore';

const binding = (overrides: Partial<ScheduleBinding> = {}): ScheduleBinding => ({
  id: 'remote',
  name: 'Remote',
  targetSessionId: 'task',
  status: 'active',
  cronExpr: '* * * * *',
  manual: false,
  ...overrides,
});
const invoke = vi.fn();
const seed = (device: string) => remoteProjectsStore.setDeviceSessions(device, device, []);
function Badge({ deviceId }: { deviceId?: string }) {
  const schedules = useSessionBoundSchedules('task', deviceId);
  return <ScheduleBindingBadge schedules={schedules} deviceLinkDeviceId={deviceId} />;
}

beforeEach(() => {
  vi.clearAllMocks();
  invoke.mockReset();
  remoteProjectsStore.clear();
  window.electronAPI = { deviceLink: { invoke } } as unknown as typeof window.electronAPI;
});
afterEach(() => {
  cleanup();
  remoteProjectsStore.clear();
});

describe('remote schedule binding badges', () => {
  it('keeps same-ID local and two remote tasks separate; reads remote metadata once per device', async () => {
    seed('A');
    seed('B');
    const bindings = [binding()];
    invoke.mockImplementation(async (_device: string, channel: string) =>
      channel === 'maker:schedule:list' ? bindings : { runs: [] },
    );
    const { rerender } = render(
      <>
        <Badge deviceId="A" />
        <Badge deviceId="A" />
        <Badge deviceId="A" />
      </>,
    );
    expect(screen.queryByRole('img')).toBeNull();
    expect(ensure).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
    await act(async () => {
      await refreshRemoteDeviceSessions('A', undefined, { scope: 'schedule' });
    });
    expect(screen.getAllByRole('img')).toHaveLength(3);
    expect(
      invoke.mock.calls.filter(([, channel]) => channel === 'maker:schedule:list'),
    ).toHaveLength(1);
    expect(remoteProjectsStore.getSessionScheduleBindings('B', 'task')).toEqual([]);
    fireEvent.click(screen.getAllByRole('img')[0]);
    expect(navigate).not.toHaveBeenCalled();
    rerender(<Badge deviceId="B" />);
    expect(screen.queryByRole('img')).toBeNull();
    rerender(<Badge />);
    fireEvent.click(screen.getByRole('button'));
    expect(navigate).toHaveBeenCalledWith('/cc-agent/scheduled?focus=local');
    expect(ensure).toHaveBeenCalledOnce();
  });

  it('updates pause/resume and removes deleted, expired or detached bindings without a run', async () => {
    seed('A');
    let bindings = [binding(), binding({ id: 'second', name: 'Second', status: 'paused' })];
    invoke.mockImplementation(async (_device: string, channel: string) =>
      channel === 'maker:schedule:list' ? bindings : { runs: [] },
    );
    const { container } = render(<Badge deviceId="A" />);
    const refresh = () =>
      act(async () => {
        await refreshRemoteDeviceSessions('A', undefined, { scope: 'schedule' });
      });
    await refresh();
    expect(screen.getByText(/^Second/)).toBeTruthy();
    expect(container.querySelector('[data-automation-paused-indicator]')).toBeNull();
    bindings = [binding({ status: 'paused' })];
    await refresh();
    expect(container.querySelector('[data-automation-paused-indicator]')).not.toBeNull();
    bindings = [binding()];
    await refresh();
    expect(container.querySelector('[data-automation-paused-indicator]')).toBeNull();
    for (const next of [
      [],
      [binding({ status: 'expired' })],
      [binding({ targetSessionId: undefined })],
    ]) {
      bindings = next;
      await refresh();
      expect(screen.queryByRole('img')).toBeNull();
    }
  });

  it('retains stable snapshots on failures and clears only the removed device', async () => {
    seed('A');
    seed('B');
    remoteProjectsStore.setDeviceScheduleBindings('A', [binding()]);
    remoteProjectsStore.setDeviceScheduleBindings('B', [binding({ name: 'B' })]);
    const before = remoteProjectsStore.getSessionScheduleBindings('A', 'task');
    remoteProjectsStore.setDeviceScheduleBindings('A', [binding()]);
    expect(remoteProjectsStore.getSessionScheduleBindings('A', 'task')).toBe(before);
    invoke.mockImplementation(async (_device: string, channel: string) => {
      if (channel === 'maker:schedule:list') throw new Error('CHANNEL_NOT_ALLOWED');
      return { runs: [] };
    });
    await refreshRemoteDeviceSessions('A', undefined, { scope: 'schedule' });
    expect(remoteProjectsStore.getSessionScheduleBindings('A', 'task')).toBe(before);
    remoteProjectsStore.setDeviceSessions('A', 'A', [{ id: 'task', status: 'active' } as Session]);
    expect(remoteProjectsStore.getSessionScheduleBindings('A', 'task')).toBe(before);
    remoteProjectsStore.removeDevice('A');
    expect(remoteProjectsStore.getSessionScheduleBindings('A', 'task')).toEqual([]);
    expect(remoteProjectsStore.getSessionScheduleBindings('B', 'task')[0].name).toBe('B');
  });

  it.each(['markDeviceDisconnected', 'removeDevice', 'clear'] as const)(
    'discards late binding responses after %s',
    async (action) => {
      seed('A');
      let resolve!: (value: unknown) => void;
      const pending = new Promise((done) => {
        resolve = done;
      });
      invoke.mockImplementation(async (_device: string, channel: string) =>
        channel === 'maker:schedule:list' ? pending : { runs: [] },
      );
      const refresh = refreshRemoteDeviceSessions('A', undefined, { scope: 'schedule' });
      await vi.waitFor(() =>
        expect(invoke).toHaveBeenCalledWith('A', 'maker:schedule:list', [
          null,
          { sessionBindings: true },
        ]),
      );
      if (action === 'clear') remoteProjectsStore.clear();
      else remoteProjectsStore[action]('A');
      resolve([binding()]);
      expect(await refresh).toBe('superseded');
      expect(remoteProjectsStore.getSessionScheduleBindings('A', 'task')).toEqual([]);
    },
  );

  it('projects only display fields and rejects malformed responses', () => {
    expect(parseScheduleBindings([{ ...binding(), prompt: 'private execution prompt' }])).toEqual([
      binding(),
    ]);
    expect(() => parseScheduleBindings({})).toThrow();
    expect(() => parseScheduleBindings([{ ...binding(), cronExpr: null }])).toThrow();
    for (const invalid of [0, -1, Infinity, NaN, '600000']) {
      expect(() => parseScheduleBindings([{ ...binding(), intervalMs: invalid }])).toThrow();
    }
    expect(() => parseScheduleBindings([{ ...binding(), recurring: 'false' }])).toThrow();
  });

  it('keeps the persistent-session flag only when true, so archive confirmation can skip it', () => {
    expect(parseScheduleBindings([{ ...binding(), persistentSession: true }])).toEqual([
      { ...binding(), persistentSession: true },
    ]);
    expect(parseScheduleBindings([{ ...binding(), persistentSession: false }])).toEqual([binding()]);
  });

  // PR #13451 P1 regression: preserve known schedule source values through parseScheduleBindings
  // so remote archive confirmation can distinguish user vs project automations and fail closed
  // when an older peer omits source or sends an unknown value (unit tier).
  it('preserves known schedule source values and omits absent or unknown sources', () => {
    expect(
      parseScheduleBindings([
        { ...binding(), id: 'u', source: 'user' },
        { ...binding(), id: 'p', source: 'project' },
        { ...binding(), id: 'b', source: 'bot' },
        { ...binding(), id: 'legacy' },
        { ...binding(), id: 'future', source: 'future-kind' },
      ]),
    ).toEqual([
      { ...binding(), id: 'u', source: 'user' },
      { ...binding(), id: 'p', source: 'project' },
      { ...binding(), id: 'b', source: 'bot' },
      { ...binding(), id: 'legacy' },
      { ...binding(), id: 'future' },
    ]);
  });

  it.each([
    [{ intervalMs: 600_000 }, 'Every 10 minutes'],
    [{ intervalMs: 1_680_000 }, 'Every 28 minutes'],
    [{ intervalMs: 90_000 }, 'Every 1.5 minutes'],
    [{ intervalMs: 7_200_000 }, 'Every 2 hours'],
    [{ recurring: false, intervalMs: 600_000 }, 'scheduler.cell.subtitleOnce'],
    [{ manual: true, recurring: false, intervalMs: 600_000 }, 'scheduler.detail.manualTrigger'],
    [{}, 'Every 5 minutes'],
  ])('uses authoritative timing for local and remote badges: %j', (timing, expected) => {
    const schedule = binding({ cronExpr: '*/5 * * * *', ...timing });
    const { rerender } = render(<ScheduleBindingBadge schedules={[schedule]} />);
    expect(screen.getByText(expected)).toBeTruthy();
    seed('A');
    remoteProjectsStore.setDeviceScheduleBindings('A', parseScheduleBindings([schedule]));
    rerender(<Badge deviceId="A" />);
    expect(screen.getByText(expected)).toBeTruthy();
  });

  it('reads bindings even when the older peer lacks the run index, and propagates revoked access', async () => {
    seed('A');
    invoke.mockImplementation(async (_device: string, channel: string) => {
      if (channel === 'maker:schedule:list') return [binding()];
      throw new Error('CHANNEL_NOT_ALLOWED');
    });
    await refreshRemoteDeviceSessions('A', undefined, { scope: 'schedule', maxAttempts: 1 });
    expect(remoteProjectsStore.getSessionScheduleBindings('A', 'task')).toEqual([binding()]);
    invoke.mockImplementation(async (_device: string, channel: string) => {
      if (channel === 'maker:schedule:list') throw new Error('DEVICE_LINK_ACCESS_REVOKED');
      return { runs: [] };
    });
    expect(await refreshRemoteDeviceSessions('A', undefined, { scope: 'schedule' })).toBe(
      'revoked',
    );
  });
});

// Integration: the inbox subscription shares authoritative bindings with badges, including devices.
it('updates follow-up grouping when bindings pause, resume, retarget or disappear', () => {
  seed('A');
  seed('B');
  const sessions = [
    { id: 'task' },
    { id: 'task', deviceLinkDeviceId: 'A' },
    { id: 'task', deviceLinkDeviceId: 'B' },
  ];
  function Following() {
    const active = useActiveFollowUpSessions(sessions);
    return <div data-testid="following">{sessions.filter((s) => active.has(s)).map((s) => s.deviceLinkDeviceId ?? 'local').join(',')}</div>;
  }
  render(<Following />);
  expect(screen.getByTestId('following').textContent).toBe('local');
  // 2026-11-18 user decision: any active automation bound to the task counts, not only PR follow-ups.
  act(() => remoteProjectsStore.setDeviceScheduleBindings('A', parseScheduleBindings([binding()])));
  expect(screen.getByTestId('following').textContent).toBe('local,A');
  // Hosts from before that decision may still send followsPr; it is ignored.
  expect(parseScheduleBindings([{ ...binding(), followsPr: 'yes' }])).toEqual([binding()]);
  act(() => remoteProjectsStore.setDeviceScheduleBindings('A', [binding(), binding({ id: 'paused', status: 'paused' })]));
  expect(screen.getByTestId('following').textContent).toBe('local,A');
  act(() => remoteProjectsStore.setDeviceScheduleBindings('A', [binding({ status: 'paused' })]));
  expect(screen.getByTestId('following').textContent).toBe('local');
  act(() => remoteProjectsStore.setDeviceScheduleBindings('A', [binding()]));
  expect(screen.getByTestId('following').textContent).toBe('local,A');
  act(() => remoteProjectsStore.setDeviceScheduleBindings('A', [binding({ targetSessionId: 'other' })]));
  expect(screen.getByTestId('following').textContent).toBe('local');
  act(() => remoteProjectsStore.setDeviceScheduleBindings('B', [binding()]));
  expect(screen.getByTestId('following').textContent).toBe('local,B');
  act(() => remoteProjectsStore.removeDevice('B'));
  expect(screen.getByTestId('following').textContent).toBe('local');
});

// 规则：task-inbox.md；此前 useActiveFollowUpSessions 只查 Lead 自身绑定，
// 协同 Worker（同机或跨设备）绑了启用中自动化时 Lead 不会进入「进行中」。
it('marks an Orca Lead as following when its active local or remote Worker has an active automation', () => {
  setCurrentAuthDeviceId('self-mac');
  try {
    const leadA = { id: 'lead-a', status: 'active', orcaRole: 'lead', deviceLinkDeviceId: 'A' } as Session;
    const leadLocal = { id: 'lead-local', status: 'active', orcaRole: 'lead' } as Session;
    const workerOnA = {
      id: 'worker-a',
      status: 'active',
      orcaRole: 'worker',
      orcaLeadSessionId: 'lead-a',
      deviceLinkDeviceId: 'A',
    } as Session;
    const remoteWorkerOnB = {
      id: 'worker-b',
      status: 'active',
      deviceLinkDeviceId: 'B',
      orcaRemoteLead: {
        leadDeviceId: 'self-mac',
        leadDeviceName: 'Self',
        leadSessionId: 'lead-local',
        leadTitle: 'Local Lead',
        workerLabel: 'relay',
      },
    } as Session;
    remoteProjectsStore.setDeviceSessions('A', 'A', [leadA, workerOnA]);
    remoteProjectsStore.setDeviceSessions('B', 'B', [remoteWorkerOnB]);
    const sessions = [leadA, leadLocal];
    function Following() {
      const active = useActiveFollowUpSessions(sessions);
      return <div data-testid="orca-following">{sessions.filter((s) => active.has(s)).map((s) => s.id).join(',')}</div>;
    }
    render(<Following />);
    expect(screen.getByTestId('orca-following').textContent).toBe('');
    act(() => remoteProjectsStore.setDeviceScheduleBindings('A', [binding({ id: 's-a', targetSessionId: 'worker-a' })]));
    expect(screen.getByTestId('orca-following').textContent).toBe('lead-a');
    act(() => remoteProjectsStore.setDeviceScheduleBindings('B', [binding({ id: 's-b', targetSessionId: 'worker-b' })]));
    expect(screen.getByTestId('orca-following').textContent).toBe('lead-a,lead-local');
    act(() => remoteProjectsStore.setDeviceScheduleBindings('A', [binding({ id: 's-a', targetSessionId: 'worker-a', status: 'paused' })]));
    expect(screen.getByTestId('orca-following').textContent).toBe('lead-local');
  } finally {
    cleanup();
    setCurrentAuthDeviceId(null);
  }
});
