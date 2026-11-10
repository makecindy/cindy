// @vitest-environment jsdom
// unit: actual status launcher and task-page navigation, previously absent.
// Minimal regressions: a task-switch reply arrives late; a disabled plugin remains
// visible; hidden windows keep polling. Main-process isolation has separate tests.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { PluginTaskStatus } from '../PluginTaskStatus';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';

const mocks = vi.hoisted(() => ({
  open: vi.fn(),
  ghosts: [
    {
      manifest: { id: 'demo', name: 'Demo', taskView: { html: 'task.html', statusBar: true } },
      enabled: true,
      approval: { state: 'approved', revision: 'one' },
    },
  ],
  disabled: new Set<string>(),
}));
vi.mock('../useInstalledGhosts', () => ({ useInstalledGhosts: () => mocks.ghosts }));
vi.mock('../ghostWorkdirFilter', () => ({ useWorkdirDisabledGhostIds: () => mocks.disabled }));
vi.mock('@/features/right-sidebar/lib/openPluginTaskTab', () => ({
  openPluginTaskTab: mocks.open,
}));
vi.mock('@/components/ui/tooltip', () => ({
  Tip: ({ children }: { children: React.ReactNode }) => children,
}));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  mocks.disabled.clear();
  mocks.open.mockReset();
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
