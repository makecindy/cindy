// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { resolvedLanguage: 'en' },
  }),
}));

vi.mock('react-router-dom', () => ({
  useLocation: () => ({ pathname: '/', search: '' }),
  useNavigate: () => vi.fn(),
}));

vi.mock('@/lib/checkForUpdateWithToast', () => ({
  checkForUpdateWithToast: vi.fn(),
}));

import { MenuButton } from '@/components/title-bar/MenuButton';
import { PerformanceTrace } from '@/components/performance-trace/PerformanceTrace';
import type { PerformanceTraceState } from '../../../../shared/performanceTrace';
vi.mock('@/features/device-link/useSharedTaskTasks', () => ({ useSharedTaskTasks: vi.fn() }));
vi.mock('@/features/device-link/JoinSharedTaskDialog', () => ({
  JoinSharedTaskDialog: () => null,
}));
vi.mock('@/features/device-link/SharedTaskEndedNotice', () => ({
  SharedTaskEndedNotice: () => null,
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

describe('MenuButton tooltip and dropdown interaction', () => {
  // Review: secondary windows mount the shared menu but no PerformanceTrace host.
  // Unit: the real startup URL flag must hide this dead action, retaining other menu entries.
  it('does not offer performance tracing in a secondary window', async () => {
    window.history.replaceState(null, '', '/?secondaryWindow=1');
    const user = userEvent.setup();
    render(<MenuButton />);
    await user.click(screen.getByRole('button', { name: 'titleBar.menu' }));
    expect(screen.queryByRole('menuitem', { name: 'performanceTrace.title' })).toBeNull();
    expect(screen.getByRole('menuitem', { name: 'titleBar.menuItems.resourceUsage' })).toBeTruthy();
  });
  // Unit: real menu/dialog lifecycle; reopening a completed capture must offer a new recording,
  // not imply the previous report was just created. The former start-only case missed this.
  // Minimal regression: stop, enter a note, close, reopen from the menu.
  // Standalone Vitest: 3.36s on Windows (2026-10-29), test execution 1.82s.
  it('starts a new recording on menu reentry while keeping the previous report accessible', async () => {
    let state: PerformanceTraceState = {
      phase: 'idle',
      startedAt: null,
      reportId: null,
      uploaded: false,
      partial: false,
      durationMs: 0,
    };
    const command = vi.fn(async (action: string) => {
      if (action === 'start')
        state = {
          ...state,
          phase: 'recording',
          startedAt: Date.now(),
          reportId: 'ABCD-EFGH',
          uploaded: false,
        };
      if (action === 'stop') state = { ...state, phase: 'ready', durationMs: 3000 };
      if (action === 'upload') state = { ...state, uploaded: true };
      return state;
    });
    vi.stubGlobal('electronAPI', {
      performanceTrace: { command, events: vi.fn(), onState: () => () => {} },
    });
    const user = userEvent.setup();
    render(
      <>
        <MenuButton />
        <PerformanceTrace />
      </>,
    );
    await user.click(screen.getByRole('button', { name: 'titleBar.menu' }));
    await user.click(screen.getByRole('menuitem', { name: 'performanceTrace.title' }));
    expect(await screen.findByRole('alertdialog', { name: 'performanceTrace.title' })).toBeTruthy();
    expect(screen.queryByRole('menu')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'performanceTrace.start' }));
    expect(await screen.findByRole('button', { name: 'performanceTrace.stop' })).toBeTruthy();
    expect(command).toHaveBeenCalledWith('start', undefined);
    await user.click(screen.getByRole('button', { name: 'performanceTrace.stop' }));
    await user.type(screen.getByRole('textbox'), 'Slow typing');
    await user.click(screen.getByRole('button', { name: 'performanceTrace.close' }));
    const reopen = async () => {
      await user.click(screen.getByRole('button', { name: 'titleBar.menu' }));
      await user.click(screen.getByRole('menuitem', { name: 'performanceTrace.title' }));
      expect(await screen.findByRole('button', { name: 'performanceTrace.start' })).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'performanceTrace.submit' })).toBeNull();
    };
    await reopen();
    await user.click(screen.getByRole('button', { name: 'performanceTrace.previous' }));
    expect(
      screen.getByRole('alertdialog', { name: 'performanceTrace.previousResult' }),
    ).toBeTruthy();
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('Slow typing');
    await user.click(screen.getByRole('button', { name: 'performanceTrace.submit' }));
    expect(command).toHaveBeenCalledWith('upload', 'Slow typing');
    await user.click(screen.getByRole('button', { name: 'performanceTrace.close' }));
    await reopen();
    await user.click(screen.getByRole('button', { name: 'performanceTrace.start' }));
    await user.click(await screen.findByRole('button', { name: 'performanceTrace.stop' }));
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('');
  });
  it('dismisses the tooltip when the menu opens', async () => {
    const user = userEvent.setup();
    render(<MenuButton />);

    const trigger = screen.getByRole('button', { name: 'titleBar.menu' });
    await user.hover(trigger);

    expect((await screen.findByRole('tooltip')).textContent).toContain('titleBar.menu');

    await user.click(trigger);

    expect(screen.getByRole('menu')).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull());
  });
});
