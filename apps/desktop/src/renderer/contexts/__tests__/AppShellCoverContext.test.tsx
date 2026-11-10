// @vitest-environment jsdom

import { cleanup, render, renderHook, screen } from '@testing-library/react';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({
  isInitializing: false,
  canEnterApp: false,
  ownerBoundaryPending: false,
  dataOwnerId: 'owner',
  dataOwnerGeneration: 1,
}));
const env = vi.hoisted(() => ({ status: 'passed' }));

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => auth,
}));
vi.mock('@/contexts/EnvCheckContext', () => ({ useEnvCheck: () => env }));

vi.mock('@/lib/secondaryWindow', () => ({
  isSecondaryWindow: () => false,
}));
vi.mock('@/lib/sidebarWindow', () => ({
  isSidebarWindow: () => false,
}));

import { AppShellCoverProvider, useAppShellCover } from '../AppShellCoverContext';

function Probe() {
  const { coverHeld, localDbGateStatus } = useAppShellCover();
  return (
    <div>
      <span data-testid="cover">{coverHeld ? 'held' : 'open'}</span>
      <span data-testid="gate">{localDbGateStatus}</span>
    </div>
  );
}

function renderCover() {
  return render(
    <AppShellCoverProvider>
      <Probe />
    </AppShellCoverProvider>,
  );
}

describe('AppShellCover', () => {
  afterEach(() => {
    cleanup();
    auth.isInitializing = false;
    auth.canEnterApp = false;
    auth.ownerBoundaryPending = false;
    auth.dataOwnerId = 'owner';
    auth.dataOwnerGeneration = 1;
    env.status = 'passed';
  });

  it('未登录不持盖,让 splash 退到登录页', () => {
    auth.canEnterApp = false;
    renderCover();
    expect(screen.getByTestId('cover').textContent).toBe('open');
  });

  it('已可进应用且 LocalDbGate 仍 pending 时持盖', () => {
    auth.canEnterApp = true;
    renderCover();
    expect(screen.getByTestId('cover').textContent).toBe('held');
    expect(screen.getByTestId('gate').textContent).toBe('pending');
  });

  it('LocalDbGate ready 后放行', () => {
    auth.canEnterApp = true;
    function ReadyProbe() {
      const { reportLocalDbGate, coverHeld } = useAppShellCover();
      return (
        <button type="button" onClick={() => reportLocalDbGate('ready')}>
          {coverHeld ? 'held' : 'open'}
        </button>
      );
    }
    render(
      <AppShellCoverProvider>
        <ReadyProbe />
      </AppShellCoverProvider>,
    );
    expect(screen.getByRole('button').textContent).toBe('held');
    act(() => {
      screen.getByRole('button').click();
    });
    expect(screen.getByRole('button').textContent).toBe('open');
  });

  it('auth 仍在初始化时不持盖,交给 splash 自己的 auth 锚', () => {
    auth.isInitializing = true;
    auth.canEnterApp = true;
    renderCover();
    expect(screen.getByTestId('cover').textContent).toBe('open');
  });

  // unit：真实 provider；裸 gate 状态缺少 owner stamp，换代后会读到上一代 ready/fatal。
  it.each(['ready', 'fatal'] as const)('does not reuse or accept an old generation’s %s', (status) => {
    auth.canEnterApp = true;
    const hook = renderHook(() => useAppShellCover(), { wrapper: AppShellCoverProvider });
    const oldReport = hook.result.current.reportLocalDbGate;
    act(() => oldReport(status));
    expect(hook.result.current.startupTarget).toBe(status === 'ready' ? 'app' : 'database-error');
    auth.dataOwnerGeneration = 2;
    hook.rerender();
    expect(hook.result.current.startupTarget).toBe('splash');
    act(() => hook.result.current.reportLocalDbGate('ready'));
    expect(hook.result.current.startupTarget).toBe('app');
    act(() => oldReport(status));
    expect(hook.result.current.startupTarget).toBe('app');
  });

  it('derives the destination from environment, auth boundary and the current owner database', () => {
    const hook = renderHook(() => useAppShellCover(), { wrapper: AppShellCoverProvider });
    expect(hook.result.current.startupTarget).toBe('login');
    auth.ownerBoundaryPending = true;
    hook.rerender();
    expect(hook.result.current.startupTarget).toBe('splash');
    auth.ownerBoundaryPending = false;
    auth.canEnterApp = true;
    hook.rerender();
    act(() => hook.result.current.reportLocalDbGate('fatal'));
    expect(hook.result.current.startupTarget).toBe('database-error');
    expect(hook.result.current.coverHeld).toBe(false);
    env.status = 'failed';
    hook.rerender();
    expect(hook.result.current.startupTarget).toBe('splash');
    env.status = 'passed';
    auth.isInitializing = true;
    hook.rerender();
    expect(hook.result.current.startupTarget).toBe('splash');
  });
});
