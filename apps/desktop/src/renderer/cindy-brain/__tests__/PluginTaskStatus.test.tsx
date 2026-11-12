// @vitest-environment jsdom
// unit: actual status launcher and task-page navigation, previously absent.
// Minimal regressions: a task-switch reply arrives late; a disabled plugin remains
// visible; hidden windows keep polling. Main-process isolation has separate tests.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { PluginTaskStatus } from '../PluginTaskStatus';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { OrcaSplitView } from '@/features/cc-agent/OrcaSplitView';

const mocks = vi.hoisted(() => ({
  open: vi.fn(),
  ghosts: [
    {
      manifest: { id: 'demo', name: 'Demo', taskView: { html: 'task.html', statusBar: true } },
      enabled: true,
      taskStatusCapabilityApproved: true,
      approval: { state: 'approved', revision: 'one' },
    },
  ],
  disabled: new Set<string>(),
  realPolicy: false,
}));
vi.mock('../useInstalledGhosts', () => ({ useInstalledGhosts: () => mocks.ghosts }));
vi.mock('../ghostWorkdirFilter', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ghostWorkdirFilter')>();
  return { ...actual, useWorkdirDisabledGhostIds: (...args: Parameters<typeof actual.useWorkdirDisabledGhostIds>) =>
    mocks.realPolicy ? actual.useWorkdirDisabledGhostIds(...args) : mocks.disabled };
});
vi.mock('@/features/right-sidebar/lib/openPluginTaskTab', () => ({
  openPluginTaskTab: mocks.open,
}));
vi.mock('@/components/ui/tooltip', () => ({
  Tip: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('@/hooks/useCCSessions', () => ({ useCCSessions: () => ({ sessions: [{ id: 'lead' }, { id: 'worker' }] }) }));
vi.mock('@/features/device-link/remoteProjectsStore', () => ({ useRemoteProjectSessions: () => [] }));
vi.mock('@/features/cc-agent/hooks/useOrcaWorkerSelection', () => ({ useOrcaWorkerSelection: () => ({ workerSessionId: 'worker' }) }));
vi.mock('@/features/cc-agent/hooks/useStopOrcaCollab', () => ({ useStopOrcaCollabWithoutNavigation: () => ({ requestStop: vi.fn() }) }));
vi.mock('@/features/cc-agent/lib/workerAttentionStore', () => ({ useWorkerAttentionSnapshot: () => 0, clearWorkerAttention: vi.fn() }));
vi.mock('@/hooks/useAgentIslandSettings', () => ({ isAgentIslandSupported: () => false }));
vi.mock('@/features/cc-agent/CCAgentSessionView', () => ({
  CCAgentSessionView: ({ sessionIdProp, sidebarTargetSessionId }: { sessionIdProp: string; sidebarTargetSessionId?: string }) =>
    <PluginTaskStatus sessionId={sessionIdProp} sidebarTargetSessionId={sidebarTargetSessionId} />,
}));

const originalGhosts = mocks.ghosts;
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  mocks.disabled.clear();
  mocks.realPolicy = false;
  mocks.open.mockReset();
  mocks.ghosts = originalGhosts;
});
const status = (label: string) => [{ instanceId: 'demo', name: 'Demo', label }];
function bridge(taskStatus: unknown) {
  Object.defineProperty(document, 'hidden', { value: false, configurable: true });
  Object.assign(window, { electronAPI: { ghosts: { taskStatus } } });
  setDataOwnerGeneration('owner');
}

it('opens only its own task page and immediately hides disabled launchers', async () => {
  bridge(vi.fn(async () => status('50%')));
  const view = render(<PluginTaskStatus sessionId="one" />);
  await act(async () => {});
  fireEvent.click(screen.getByRole('button', { name: 'Demo: 50%' }));
  expect(mocks.open).toHaveBeenCalledExactlyOnceWith('one', 'demo', { userInitiated: true });
  mocks.disabled.add('demo');
  view.rerender(<PluginTaskStatus sessionId="one" />);
  expect(screen.queryByRole('button')).toBeNull();
});

it('discards late replies after a task or owner switch', async () => {
  const pending = new Map<string, (v: ReturnType<typeof status>) => void>();
  bridge(vi.fn((id: string) => new Promise((resolve) => pending.set(id, resolve))));
  const view = render(<PluginTaskStatus sessionId="one" />);
  view.rerender(<PluginTaskStatus sessionId="two" />);
  await act(async () => {
    pending.get('two')!(status('new'));
  });
  await act(async () => {
    pending.get('one')!(status('old'));
  });
  expect(screen.getByRole('button').textContent).toBe('Demo: new');
  setDataOwnerGeneration('other');
  view.rerender(<PluginTaskStatus sessionId="two" />);
  expect(screen.queryByRole('button')).toBeNull();
});

it('stops polling in a hidden document and clears failed status results', async () => {
  vi.useFakeTimers();
  const request = vi.fn(async () => status('fresh'));
  bridge(request);
  render(<PluginTaskStatus sessionId="one" />);
  await act(async () => {});
  Object.defineProperty(document, 'hidden', { value: true, configurable: true });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60_000);
  });
  expect(request).toHaveBeenCalledTimes(1);
  request.mockRejectedValue(new Error('unavailable'));
  Object.defineProperty(document, 'hidden', { value: false, configurable: true });
  await act(async () => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
  expect(screen.queryByRole('button')).toBeNull();
});

// unit regression: switching the selected model in the same task must immediately
// remove the old model's quota and request a fresh status, not wait 30 seconds.
it('refreshes on a route change and does not show the previous route while waiting', async () => {
  let resolve!: (value: ReturnType<typeof status>) => void;
  const request = vi
    .fn()
    .mockResolvedValueOnce(status('old'))
    .mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
  bridge(request);
  const view = render(<PluginTaskStatus sessionId="one" routeKey="magpie/model-one" />);
  await act(async () => {});
  expect(screen.getByRole('button').textContent).toBe('Demo: old');
  view.rerender(<PluginTaskStatus sessionId="one" routeKey="magpie/model-two" />);
  expect(screen.queryByRole('button')).toBeNull();
  expect(request).toHaveBeenCalledTimes(2);
  await act(async () => {
    resolve(status('new'));
  });
  expect(screen.getByRole('button').textContent).toBe('Demo: new');
});

// unit regression: 其它插件的 OAuth 角标等投影更新会替换整份 ghosts 数组,
// 不能因此重启轮询,也不能让已有状态在回复前消失。
it('does not restart polling when an unrelated ghost projection changes', async () => {
  const request = vi.fn(async () => status('50%'));
  bridge(request);
  const view = render(<PluginTaskStatus sessionId="one" />);
  await act(async () => {});
  expect(screen.getByRole('button').textContent).toBe('Demo: 50%');
  mocks.ghosts = [...mocks.ghosts];
  view.rerender(<PluginTaskStatus sessionId="one" />);
  expect(request).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('button').textContent).toBe('Demo: 50%');
});

// unit: 内嵌在他人侧栏里的会话(Orca worker、侧聊)打开的是宿主任务的页签桶,
// 点了看不到插件任务页,所以不显示入口也不轮询。
it('hides the launcher when the sidebar belongs to another task', async () => {
  const request = vi.fn(async () => status('50%'));
  bridge(request);
  render(<PluginTaskStatus sessionId="worker" sidebarTargetSessionId="lead" />);
  await act(async () => {});
  expect(request).not.toHaveBeenCalled();
  expect(screen.queryByRole('button')).toBeNull();
});

it('keeps the file-browser Worker launcher out of the Lead sidebar', async () => {
  const request = vi.fn(async () => status('50%'));
  bridge(request);
  render(<OrcaSplitView leadSessionId="lead" />);
  await act(async () => {});
  expect(screen.getByRole('button', { name: 'Demo: 50%' })).toBeTruthy();
  request.mockClear();
  fireEvent.click(screen.getAllByRole('tab')[1]);
  await act(async () => {});
  expect(request).not.toHaveBeenCalled();
  expect(screen.queryByRole('button', { name: 'Demo: 50%' })).toBeNull();
});

it('does not poll an old declaration without a task-status approval', async () => {
  const request = vi.fn(async () => status('50%'));
  bridge(request);
  mocks.ghosts = mocks.ghosts.map(g => ({ ...g, taskStatusCapabilityApproved: false }));
  render(<PluginTaskStatus sessionId="one" />);
  await act(async () => {});
  expect(request).not.toHaveBeenCalled();
  expect(screen.queryByRole('button')).toBeNull();
});

// Unit #9676 P2: real hook's transient null was hidden by the old policy mock.
// A display-only roster update must not hide the launcher or restart its timer.
it('keeps a workdir launcher stable across unrelated projections using the real policy hook', async () => {
  vi.useFakeTimers();
  mocks.realPolicy = true;
  const request = vi.fn(async () => status('50%'));
  bridge(request);
  const policy = vi.fn(async () => ({ workdirKey: '/project', disabled: [] }));
  Object.assign(window.electronAPI.ghosts, { workdirPrefs: policy });
  const view = render(<PluginTaskStatus sessionId="one" workingDir="/project" />);
  await act(async () => {});
  expect(screen.getByRole('button').textContent).toBe('Demo: 50%');
  mocks.ghosts = mocks.ghosts.map(g => ({ ...g }));
  view.rerender(<PluginTaskStatus sessionId="one" workingDir="/project" />);
  expect(screen.getByRole('button').textContent).toBe('Demo: 50%');
  await act(async () => { await vi.advanceTimersByTimeAsync(29_000); });
  expect(request).toHaveBeenCalledTimes(1);
  expect(policy).toHaveBeenCalledTimes(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
  expect(request).toHaveBeenCalledTimes(2);
});
