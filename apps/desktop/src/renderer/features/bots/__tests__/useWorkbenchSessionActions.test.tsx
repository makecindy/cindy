// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useWorkbenchSessionActions } from '../useWorkbenchSessionActions';

const m = vi.hoisted(() => ({
  run: vi.fn(),
  unarchive: vi.fn(),
  navigate: vi.fn(),
  confirm: vi.fn(),
  preflight: vi.fn(),
  close: vi.fn(),
  binding: vi.fn(),
  patchMeta: vi.fn(),
  running: new Set<string>(),
  attached: new Set<string>(),
  changed: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  archiveBlockedByRunning: vi.fn(),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (s: string) => s }) }));
vi.mock('react-router-dom', () => ({ useNavigate: () => m.navigate }));
vi.mock('@/features/cc-agent/hooks/useSessionLifecycleActions', () => ({
  useSessionLifecycleActions: () => ({ runSessionAction: m.run, unarchiveSession: m.unarchive,
    archiveBlockedByRunning: m.archiveBlockedByRunning }),
}));
vi.mock('@/hooks/useSessionRunningStatus', () => ({
  useSessionRunningStatus: () => ({ runningSessionIds: m.running, clearNotification: vi.fn() }),
}));
vi.mock('@/hooks/useAttachedSessionIds', () => ({ useAttachedSessionIds: () => m.attached }));
vi.mock('@/components/ui/confirm-dialog-provider', () => ({
  useConfirmDialog: () => ({ confirm: m.confirm }),
}));
vi.mock('@/lib/orcaSessionIdentity', () => ({
  resolveSessionRoute: async (id: string) => '/cc-agent/' + id,
}));
vi.mock('@/lib/worktreeRemovalWarning', () => ({ resolveWorktreeRemovalPreflight: m.preflight }));
vi.mock('@/lib/sessionsStore', () => ({ sessionsStore: { patchLocal: vi.fn() } }));
vi.mock('@/lib/sessionService', () => ({ patchMeta: m.patchMeta }));
vi.mock('@/features/cc-agent/hooks/helpers/sidebarFilterCore', () => ({
  persistManualPinnedOrder: vi.fn(),
}));
vi.mock('@/lib/toast', () => ({ toast: { warning: m.warning, error: m.error } }));

const archivedRow = {
  id: 'original',
  title: 'Original',
  status: 'archived',
  agentKind: 'codex',
  workingDir: '/project',
} as any;
const activeRow = { ...archivedRow, id: 'live', status: 'active', pinnedAt: null } as any;

function setup(rows = [archivedRow, activeRow]) {
  return renderHook(() => useWorkbenchSessionActions(rows, m.changed)).result;
}

beforeEach(() => {
  vi.clearAllMocks();
  m.running = new Set();
  m.archiveBlockedByRunning.mockImplementation((id: string) => {
    if (!m.running.has(id)) return false;
    m.warning('ccAgent.sidebar.archiveBlocked.running');
    return true;
  });
  m.attached = new Set();
  m.confirm.mockResolvedValue(true);
  m.preflight.mockResolvedValue('clean');
  m.close.mockResolvedValue({ closed: ['shared'] });
  m.binding.mockResolvedValue({ attached: false });
  m.patchMeta.mockResolvedValue(undefined);
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: { binding: { resolveSession: m.binding }, sharedTask: { account: m.close } },
  });
});
afterEach(cleanup);

it.each(['clean', 'dirty', 'unknown'])('keeps sharing when a task starts during %s preflight or confirmation', async (preflight) => {
  let finish!: (value: any) => void;
  const pending = new Promise((resolve) => { finish = resolve; });
  m.preflight.mockReturnValue(preflight === 'clean' ? pending : Promise.resolve(preflight));
  m.confirm.mockReturnValue(pending);
  const result = setup();
  let action!: Promise<void>;
  act(() => { action = result.current.action('live', 'archive', 'shared'); });
  await waitFor(() => expect(preflight === 'clean' ? m.preflight : m.confirm).toHaveBeenCalled());
  m.running.add('live');
  await act(async () => {
    finish(preflight === 'clean' ? 'clean' : true);
    await action;
  });
  expect(m.warning).toHaveBeenCalledWith('ccAgent.sidebar.archiveBlocked.running');
  expect(m.close).not.toHaveBeenCalled();
  expect(m.run).not.toHaveBeenCalled();
});

it('opens the original archived session in the task page without restoring it', async () => {
  const result = setup();
  act(() => result.current.open('original'));
  await waitFor(() => expect(m.navigate).toHaveBeenCalledWith('/cc-agent/original'));
  expect(m.unarchive).not.toHaveBeenCalled();
  expect(m.run).not.toHaveBeenCalled();
});

it('restores only through the explicit existing lifecycle action', async () => {
  const result = setup();
  await act(() => result.current.action('original', 'unarchive'));
  expect(m.unarchive).toHaveBeenCalledWith('original');
  expect(m.changed).toHaveBeenCalled();
});

it.each(['running', 'attached'] as const)('retains the %s archive guard', async (kind) => {
  m[kind].add('live');
  const result = setup();
  await act(() => result.current.action('live', 'archive'));
  expect(m.warning).toHaveBeenCalled();
  expect(m.run).not.toHaveBeenCalled();
});

it('archives a clean task without asking and refreshes the list', async () => {
  const result = setup();
  await act(() => result.current.action('live', 'archive'));
  expect(m.confirm).not.toHaveBeenCalled();
  expect(m.run).toHaveBeenCalledWith('live', 'archive', { activeSessionId: null });
  expect(m.changed).toHaveBeenCalled();
});

it('always confirms delete, and cancelling deletes nothing', async () => {
  m.confirm.mockResolvedValue(false);
  const result = setup();
  await act(() => result.current.action('live', 'delete'));
  expect(m.confirm).toHaveBeenCalled();
  expect(m.run).not.toHaveBeenCalled();
});

it('cancelling unknown worktree confirmation does not close sharing or archive', async () => {
  m.preflight.mockResolvedValue('unknown');
  m.confirm.mockResolvedValue(false);
  const result = setup();
  await act(() => result.current.action('live', 'archive', 'shared'));
  expect(m.confirm).toHaveBeenCalled();
  expect(m.close).not.toHaveBeenCalled();
  expect(m.run).not.toHaveBeenCalled();
});

it('does not archive a shared task when existing shared close fails', async () => {
  m.close.mockResolvedValue({ closed: [] });
  const result = setup();
  await act(() => result.current.action('live', 'archive', 'shared'));
  expect(m.close).toHaveBeenCalled();
  expect(m.run).not.toHaveBeenCalled();
  expect(m.error).toHaveBeenCalled();
});

it('pins and unpins through the shared session metadata path', async () => {
  const result = setup();
  await act(() => result.current.togglePin('live'));
  expect(m.patchMeta).toHaveBeenCalledWith('live', { pinnedAt: expect.any(String) });
  const pinned = setup([{ ...activeRow, pinnedAt: '2026-10-01T00:00:00.000Z' }]);
  await act(() => pinned.current.togglePin('live'));
  expect(m.patchMeta).toHaveBeenLastCalledWith('live', { pinnedAt: null });
});
