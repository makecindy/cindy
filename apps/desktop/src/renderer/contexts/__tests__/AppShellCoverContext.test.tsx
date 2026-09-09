// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({
  isInitializing: false,
  canEnterApp: false,
}));

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => auth,
}));

vi.mock('@/lib/secondaryWindow', () => ({
  isSecondaryWindow: () => false,
}));
vi.mock('@/lib/sidebarWindow', () => ({
  isSidebarWindow: () => false,
}));
vi.mock('@/lib/ghostPanelWindow', () => ({
  isGhostPanelWindow: () => false,
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
});
