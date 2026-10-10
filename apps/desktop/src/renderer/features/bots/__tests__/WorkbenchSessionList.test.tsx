// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WorkbenchSessionList } from '../WorkbenchSessionList';
const m = vi.hoisted(() => ({
  run: vi.fn(),
  unarchive: vi.fn(),
  navigate: vi.fn(),
  confirm: vi.fn(),
  preflight: vi.fn(),
  close: vi.fn(),
  binding: vi.fn(),
  running: new Set<string>(),
  attached: new Set<string>(),
  changed: vi.fn(),
  warning: vi.fn(),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (s: string) => s }) }));
vi.mock('react-router-dom', () => ({ useNavigate: () => m.navigate }));
vi.mock('@/features/cc-agent/sidebar/SessionCard', () => ({
  SessionCard: (p: any) => (
    <div data-testid="native-row" data-variant={p.variant} data-status={p.session.status}>
      <button onClick={() => p.onClick(p.session.id)}>open</button>
      <button onClick={() => p.onAction(p.session.id, 'unarchive')}>restore</button>
      <button onClick={() => p.onAction(p.session.id, 'archive', 'shared')}>archive</button>
    </div>
  ),
}));
vi.mock('@/features/cc-agent/hooks/useSessionLifecycleActions', () => ({
  useSessionLifecycleActions: () => ({ runSessionAction: m.run, unarchiveSession: m.unarchive }),
}));
vi.mock('@/features/cc-agent/hooks/useSessionDisplayRunningState', () => ({
  useSessionDisplayRunningState: () => ({ displayRunningSessionIds: m.running }),
}));
vi.mock('@/hooks/useSessionRunningStatus', () => ({
  useSessionRunningStatus: () => ({
    runningSessionIds: m.running,
    notifications: new Set(),
    clearNotification: vi.fn(),
  }),
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
vi.mock('@/lib/sessionService', () => ({ patchMeta: vi.fn(), update: vi.fn() }));
vi.mock('@/features/cc-agent/hooks/helpers/sidebarFilterCore', () => ({
  persistManualPinnedOrder: vi.fn(),
}));
vi.mock('@/lib/toast', () => ({ toast: { warning: m.warning, error: vi.fn() } }));
const row = {
  id: 'original',
  title: 'Original',
  status: 'archived',
  agentKind: 'codex',
  workingDir: '/project',
} as any;
beforeEach(() => {
  vi.clearAllMocks();
  m.running = new Set();
  m.attached = new Set();
  m.confirm.mockResolvedValue(true);
  m.preflight.mockResolvedValue('clean');
  m.close.mockResolvedValue({ closed: ['shared'] });
  m.binding.mockResolvedValue({ attached: false });
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: { binding: { resolveSession: m.binding }, sharedTask: { account: m.close } },
  });
});
afterEach(cleanup);
it('opens the original archived session through the native row without restoring it', async () => {
  render(<WorkbenchSessionList sessions={[row]} onChanged={m.changed} />);
  expect(screen.getByTestId('native-row').getAttribute('data-variant')).toBe('list');
  fireEvent.click(screen.getByText('open'));
  await waitFor(() => expect(m.navigate).toHaveBeenCalledWith('/cc-agent/original'));
  expect(m.unarchive).not.toHaveBeenCalled();
  expect(m.run).not.toHaveBeenCalled();
});
it('restores only through the explicit existing lifecycle action', async () => {
  render(<WorkbenchSessionList sessions={[row]} onChanged={m.changed} />);
  fireEvent.click(screen.getByText('restore'));
  await waitFor(() => expect(m.unarchive).toHaveBeenCalledWith('original'));
});
it.each(['running', 'attached'] as const)('retains the %s archive guard', async (kind) => {
  m[kind].add('original');
  render(<WorkbenchSessionList sessions={[row]} onChanged={m.changed} />);
  fireEvent.click(screen.getByText('archive'));
  await waitFor(() => expect(m.warning).toHaveBeenCalled());
  expect(m.run).not.toHaveBeenCalled();
});
it('cancelling unknown worktree confirmation does not close sharing or archive', async () => {
  m.preflight.mockResolvedValue('unknown');
  m.confirm.mockResolvedValue(false);
  render(<WorkbenchSessionList sessions={[row]} onChanged={m.changed} />);
  fireEvent.click(screen.getByText('archive'));
  await waitFor(() => expect(m.confirm).toHaveBeenCalled());
  expect(m.close).not.toHaveBeenCalled();
  expect(m.run).not.toHaveBeenCalled();
});
it('does not archive a shared task when existing shared close fails', async () => {
  m.close.mockResolvedValue({ closed: [] });
  render(<WorkbenchSessionList sessions={[row]} onChanged={m.changed} />);
  fireEvent.click(screen.getByText('archive'));
  await waitFor(() => expect(m.close).toHaveBeenCalled());
  expect(m.run).not.toHaveBeenCalled();
});
