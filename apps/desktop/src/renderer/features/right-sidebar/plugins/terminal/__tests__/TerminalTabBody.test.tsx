// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TabKindHostContext } from '../../../types';
import type { TerminalExitEvent } from '@/../shared/terminal-bridge';

const fit = vi.fn();
const resize = vi.fn(async () => undefined);
const entry = {
  terminal: {
    options: {
      fontFamily: '"SF Mono", Menlo, Monaco, "Cascadia Code", "Courier New", monospace',
      fontSize: 13,
    },
    cols: 80,
    rows: 24,
    element: undefined,
    open: vi.fn(),
    onData: vi.fn(() => ({ dispose: vi.fn() })),
    write: vi.fn(),
    focus: vi.fn(),
  },
  fitAddon: { fit },
  lastSize: { cols: 80, rows: 24 },
  ptyAttached: true,
};

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/components/ui/spinner', () => ({ Spinner: () => null }));
vi.mock('../lib/xtermPool', () => ({
  getOrCreateXterm: () => entry,
  detachXterm: vi.fn(),
  getXtermExit: vi.fn(() => null),
  setXtermExit: vi.fn(),
  onXtermExit: vi.fn(() => () => undefined),
  needsXtermAttach: () => !entry.ptyAttached,
  restartXterm: (params: Parameters<typeof window.electronAPI.terminal.create>[0]) => window.electronAPI.terminal.restart(params.id),
  attachXterm: (params: Parameters<typeof window.electronAPI.terminal.create>[0]) => window.electronAPI.terminal.create(params),
}));

import { TerminalTabBody } from '../TerminalTabBody';
import { detachXterm, getXtermExit, onXtermExit } from '../lib/xtermPool';

class TestResizeObserver {
  static callback: ResizeObserverCallback | null = null;
  constructor(callback: ResizeObserverCallback) {
    TestResizeObserver.callback = callback;
  }
  observe() {}
  disconnect() {}
  unobserve() {}
}

function makeContext(overrides: Partial<TabKindHostContext> = {}): TabKindHostContext {
  return {
    tabId: 'terminal-1',
    sessionId: 'session-1',
    workdir: '/workspace',
    remoteHostId: null,
    deviceLinkDeviceId: null,
    patchState: vi.fn(),
    onVisibilityChange: vi.fn(),
    setCloseInterceptor: vi.fn(() => vi.fn()),
    ...overrides,
  };
}

beforeEach(() => {
  vi.mocked(detachXterm).mockClear();
  vi.mocked(getXtermExit).mockReturnValue(null);
  vi.mocked(onXtermExit).mockReset();
  vi.mocked(onXtermExit).mockReturnValue(() => undefined);
  entry.ptyAttached = true;
  fit.mockClear();
  resize.mockClear();
  entry.terminal.open.mockClear();
  entry.terminal.onData.mockClear();
  entry.terminal.cols = 80;
  entry.terminal.rows = 24;
  entry.lastSize = { cols: 80, rows: 24 };
  TestResizeObserver.callback = null;
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(480);
  vi.stubGlobal('ResizeObserver', TestResizeObserver);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      terminal: {
        create: vi.fn(async () => ({ shellId: 'zsh', shellDisplayName: 'zsh' })),
        resize,
        restart: vi.fn(),
        write: vi.fn(),
        onData: vi.fn(() => vi.fn()),
        onExit: vi.fn(() => vi.fn()),
      },
    },
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('TerminalTabBody sidebar visibility', () => {
  // Unit: #9815 discussion_r4528361916. A failed pending restart must restore
  // the action in the replacement view, not just the now-unmounted initiator.
  it('shows the restored exit when restart rejects after the view remounts', async () => {
    const oldExit = { code: 0, signal: null };
    const listeners = new Set<(exit: TerminalExitEvent['exit']) => void>();
    vi.mocked(onXtermExit).mockImplementation((_id, listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    });
    let reject!: (error: Error) => void;
    vi.mocked(window.electronAPI.terminal.restart).mockReturnValue(new Promise((_yes, no) => { reject = no; }));
    const ctx = makeContext();
    const state = { created: true, exited: null, title: '', shellId: '', shellDisplayName: '' };
    const original = render(<TerminalTabBody state={{ ...state, exited: oldExit }} ctx={ctx} active />);
    fireEvent.click(screen.getByText('rightSidebar.terminal.restart'));
    original.unmount();
    const replacement = render(<TerminalTabBody state={state} ctx={ctx} active />);
    expect(screen.queryByText('rightSidebar.terminal.restart')).toBeNull();
    await act(async () => {
      for (const listener of listeners) listener(oldExit);
      reject(new Error('spawn failed'));
    });
    expect(screen.getByText('rightSidebar.terminal.restart')).toBeTruthy();
    expect(window.electronAPI.terminal.create).not.toHaveBeenCalled();
    replacement.unmount();
    expect(listeners.size).toBe(0);
  });

  // Unit: #9815 discussion_r4528102364. A returned window can have an old
  // exit even though another window restarted the PTY; native attach is authoritative.
  it('reconciles an old exit after a window handoff before accepting input', async () => {
    const oldExit = { code: 0, signal: null };
    vi.mocked(getXtermExit).mockReturnValue(oldExit);
    entry.ptyAttached = false;
    render(<TerminalTabBody state={{ created: false, exited: null, title: '', shellId: '', shellDisplayName: '' }} ctx={makeContext()} active />);
    await waitFor(() => expect(window.electronAPI.terminal.create).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.queryByText('rightSidebar.terminal.restart')).toBeNull());
    expect(entry.ptyAttached).toBe(true);
    expect(window.electronAPI.terminal.restart).not.toHaveBeenCalled();
  });

  it('retains the restart action when handoff confirms the PTY is still exited', async () => {
    vi.mocked(getXtermExit).mockReturnValue({ code: 0, signal: null });
    entry.ptyAttached = false;
    vi.mocked(window.electronAPI.terminal.create).mockRejectedValueOnce(new Error('terminal session already exists (exited): terminal-1'));
    render(<TerminalTabBody state={{ created: false, exited: null, title: '', shellId: '', shellDisplayName: '' }} ctx={makeContext()} active />);
    await waitFor(() => expect(entry.ptyAttached).toBe(true));
    expect(screen.getByText('rightSidebar.terminal.restart')).toBeTruthy();
    expect(window.electronAPI.terminal.create).toHaveBeenCalledOnce();
    expect(screen.queryByText('rightSidebar.terminal.spawnFailed')).toBeNull();
  });

  it('does not fit or resize the PTY while the sidebar is collapsed, then refits when visible', () => {
    const ctx = makeContext();
    const view = render(
      <TerminalTabBody
        state={{ created: true, exited: null, title: '', shellId: '', shellDisplayName: '' }}
        ctx={ctx}
        active
        shellVisible={false}
      />,
    );

    TestResizeObserver.callback?.([], {} as ResizeObserver);
    expect(fit).not.toHaveBeenCalled();
    expect(resize).not.toHaveBeenCalled();

    entry.terminal.cols = 100;
    view.rerender(
      <TerminalTabBody
        state={{ created: true, exited: null, title: '', shellId: '', shellDisplayName: '' }}
        ctx={ctx}
        active
        shellVisible
      />,
    );

    expect(fit).toHaveBeenCalled();
    expect(resize).toHaveBeenCalledWith('terminal-1', 100, 24);
  });

  it('releases an exited hidden view and restores it without creating a new PTY', () => {
    const ctx = makeContext();
    const state = { created: true, exited: { code: 0, signal: null }, title: '', shellId: '', shellDisplayName: '' };
    const view = render(<TerminalTabBody state={state} ctx={ctx} active shellVisible />);
    view.rerender(<TerminalTabBody state={state} ctx={ctx} active shellVisible={false} />);
    expect(detachXterm).toHaveBeenCalledWith('terminal-1');
    view.rerender(<TerminalTabBody state={state} ctx={ctx} active shellVisible />);
    expect(entry.terminal.open).toHaveBeenCalledTimes(2);
    expect(window.electronAPI.terminal.create).not.toHaveBeenCalled();
  });

  // Unit: hydrateState clears persisted exit flags on each sidebar render.
  // Native exit must remain visible and must not attempt create on an exited PTY.
  it('keeps the runtime exit when the parent hydrates away its exit patch', () => {
    let onExit!: (event: TerminalExitEvent) => void;
    vi.mocked(window.electronAPI.terminal.onExit).mockImplementation(listener => {
      onExit = listener;
      return vi.fn();
    });
    const state = { created: false, exited: null, title: '', shellId: '', shellDisplayName: '' };
    const ctx = makeContext();
    const view = render(<TerminalTabBody state={state} ctx={ctx} active />);
    act(() => onExit({ id: ctx.tabId, exit: { code: 0, signal: null } }));
    view.rerender(<TerminalTabBody state={{ ...state }} ctx={ctx} active />);
    expect(screen.getByText('rightSidebar.terminal.restart')).toBeTruthy();
    expect(window.electronAPI.terminal.create).not.toHaveBeenCalled();
  });

  it('drops an already queued fit when the sidebar collapses before its animation frame', () => {
    let frame: FrameRequestCallback | undefined;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frame = callback;
      return 1;
    });
    const ctx = makeContext();
    const view = render(
      <TerminalTabBody
        state={{ created: true, exited: null, title: '', shellId: '', shellDisplayName: '' }}
        ctx={ctx}
        active
        shellVisible
      />,
    );

    entry.terminal.cols = 2;
    view.rerender(
      <TerminalTabBody
        state={{ created: true, exited: null, title: '', shellId: '', shellDisplayName: '' }}
        ctx={ctx}
        active
        shellVisible={false}
      />,
    );
    frame?.(0);

    expect(resize).not.toHaveBeenCalled();
  });
});

describe('TerminalTabBody remote ownership', () => {
  it('continues to create a PTY for a confirmed local session', async () => {
    entry.ptyAttached = false;
    render(
      <TerminalTabBody
        state={{ created: false, exited: null, title: '', shellId: '', shellDisplayName: '' }}
        ctx={makeContext()}
        active
      />,
    );

    await waitFor(() => expect(window.electronAPI.terminal.create).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'terminal-1', cwd: '/workspace' }),
    ));
  });

  it('creates the local PTY after device-link ownership resolves from unknown to local', async () => {
    entry.ptyAttached = false;
    const unresolvedContext = makeContext({ deviceLinkDeviceId: undefined });
    const state = { created: false, exited: null, title: '', shellId: '', shellDisplayName: '' };
    const view = render(<TerminalTabBody state={state} ctx={unresolvedContext} active />);

    expect(screen.getByText('rightSidebar.terminal.remoteUnavailableTitle')).toBeTruthy();
    expect(window.electronAPI.terminal.create).not.toHaveBeenCalled();

    view.rerender(
      <TerminalTabBody
        state={state}
        ctx={{ ...unresolvedContext, deviceLinkDeviceId: null }}
        active
      />,
    );

    await waitFor(() => expect(window.electronAPI.terminal.create).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'terminal-1', cwd: '/workspace' }),
    ));
    expect(screen.queryByText('rightSidebar.terminal.remoteUnavailableTitle')).toBeNull();
  });

  it.each([
    ['an SSH session', { remoteHostId: 'ssh-host-1', deviceLinkDeviceId: null }],
    ['a device-link session', { remoteHostId: null, deviceLinkDeviceId: 'device-1' }],
    ['unresolved device-link ownership', { remoteHostId: null, deviceLinkDeviceId: undefined }],
  ])('fails closed for %s without creating a local PTY', (_label, ownership) => {
    const ctx = makeContext(ownership);
    render(
      <TerminalTabBody
        state={{ created: false, exited: null, title: '', shellId: '', shellDisplayName: '' }}
        ctx={ctx}
        active
      />,
    );

    expect(screen.getByText('rightSidebar.terminal.remoteUnavailableTitle')).toBeTruthy();
    expect(screen.getByText('rightSidebar.terminal.remoteUnavailableDescription')).toBeTruthy();
    expect(window.electronAPI.terminal.create).not.toHaveBeenCalled();
    expect(entry.terminal.open).not.toHaveBeenCalled();
  });
});
