// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useCallback, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TabKindHostContext } from '../../../types';

const fit = vi.fn();
const proposeDimensions = vi.fn((): { cols: number; rows: number } | undefined => ({ cols: entry.terminal.cols, rows: entry.terminal.rows }));
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
  fitAddon: { fit, proposeDimensions },
  lastSize: { cols: 80, rows: 24 },
  ptyAttached: true,
  closing: false,
  closeCancelledListeners: new Set<() => void>(),
  remoteContext: undefined as import('../../../../../../shared/terminal-bridge').RemoteTerminalContext | undefined,
  remoteDraft: undefined as { contextKey: string; connection?: import('../../../../../../shared/terminal-bridge').RemoteTerminalConnection; submitted: boolean } | undefined,
};

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/components/ui/spinner', () => ({ Spinner: () => null }));
vi.mock('@/i18n', () => ({ i18n: { t: (key: string) => key } }));
vi.mock('@/lib/toast', () => ({ toast: { error: vi.fn() } }));
vi.mock('@/features/device-link/remoteProjectsStore', () => ({ getSessionDeviceId: vi.fn() }));
vi.mock('@/components/ui/select', () => ({
  Select: ({ label, value, options, onValueChange }: { label: string; value: string; options: Array<{ value: string; label: string }>; onValueChange: (value: string) => void }) => (
    <select aria-label={label} value={value} onChange={(event) => onValueChange(event.target.value)}>
      <option value="" />{options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
    </select>
  ),
}));
vi.mock('../lib/xtermPool', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/xtermPool')>()),
  getOrCreateXterm: () => {
    registerClosing('terminal-1', (closing) => {
      const wasClosing = entry.closing;
      entry.closing = closing;
      if (wasClosing && !closing) entry.closeCancelledListeners.forEach(listener => listener());
    });
    return entry;
  },
  getXterm: vi.fn(() => entry),
  disposeXterm: () => { entry.remoteDraft = undefined; },
}));

import { TerminalTabBody } from '../TerminalTabBody';
import { getXterm } from '../lib/xtermPool';
import { TERMINAL_RENDERER_INSTANCE_ID } from '../index';
import { toast } from '@/lib/toast';
import { getSessionDeviceId } from '@/features/device-link/remoteProjectsStore';
import { getTabKind } from '../../../registry';
import { finishClosing, registerClosing, unregisterClosing } from '../../../lib/tabClosingSignal';

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
  vi.mocked(getSessionDeviceId).mockReset();
  vi.mocked(getXterm).mockReset().mockReturnValue(entry as unknown as NonNullable<ReturnType<typeof getXterm>>);
  fit.mockClear();
  proposeDimensions.mockClear();
  resize.mockClear();
  entry.terminal.open.mockClear();
  entry.terminal.onData.mockClear();
  entry.terminal.cols = 80;
  entry.terminal.rows = 24;
  entry.lastSize = { cols: 80, rows: 24 };
  entry.ptyAttached = true;
  entry.closing = false;
  entry.closeCancelledListeners.clear();
  entry.remoteDraft = undefined;
  entry.remoteContext = undefined;
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
        describeRemote: vi.fn(async (params: { sessionId: string; connection?: { host: string } }) => ({ context: { sessionId: params.sessionId }, target: { key: 'target', label: 'Host', cwd: '/remote' }, connection: params.connection ?? null, candidates: [], ...(params.connection ? { ticket: 'prepared-ticket' } : {}) })),
        create: vi.fn(async (params: { remote?: { ticket?: string } }) => {
          if (params.remote && !params.remote.ticket) throw new Error('[PRECONDITION_FAILED] prepare');
          return { shellId: 'zsh', shellDisplayName: 'zsh' };
        }),
        resize,
        dispose: vi.fn(async () => undefined),
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
  finishClosing('terminal-1');
  unregisterClosing('terminal-1');
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('TerminalTabBody sidebar visibility', () => {
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

describe('TerminalTabBody local restart fallback', () => {
  // PR8881 discussion_r4476372739 / unit: first create fails, then a deferred
  // restart reports NOT_FOUND after close/unmount. Existing attach/prepare races
  // miss this fallback, which must not launch an orphan shell. Exercise the real
  // component and close hook; rollback must preserve explicit retry without respawn.
  it.each(['open', 'closed', 'unmounted', 'rollback-before', 'rollback-after'] as const)(
    'checks the local retry lifetime (%s)', async ordering => {
      entry.ptyAttached = false;
      const api = window.electronAPI.terminal;
      vi.mocked(api.create).mockRejectedValueOnce(new Error('[TERMINAL_SPAWN_FAILED] spawn failed'));
      let rejectRestart!: (error: Error) => void;
      vi.mocked(api.restart).mockImplementationOnce(() => new Promise((_, reject) => { rejectRestart = reject; }));
      let rejectDispose!: (error: Error) => void;
      if (ordering.startsWith('rollback')) {
        vi.mocked(api.dispose).mockImplementationOnce(() => new Promise((_, reject) => { rejectDispose = reject; }));
      }
      const ctx = makeContext();
      const state = { created: false, exited: null, title: '', shellId: '', shellDisplayName: '' };
      const view = render(<TerminalTabBody state={state} ctx={ctx} active />);
      fireEvent.click(await screen.findByText('rightSidebar.terminal.restart'));
      expect(api.restart).toHaveBeenCalledWith(ctx.tabId);
      let closing: void | boolean | Promise<void | boolean>;
      if (ordering === 'closed' || ordering.startsWith('rollback')) {
        await act(async () => {
          closing = getTabKind('terminal')!.onBeforeClose!(state, { tabId: ctx.tabId, sessionId: ctx.sessionId });
          if (ordering === 'closed') await closing;
        });
        expect(api.dispose).toHaveBeenCalledOnce();
        expect(entry.closing).toBe(true);
      } else if (ordering === 'unmounted') {
        view.unmount();
      }
      const rollback = async () => {
        await act(async () => {
          rejectDispose(new Error('offline'));
          expect(await closing).toBe(false);
        });
        expect(entry.closing).toBe(false);
      };
      if (ordering === 'rollback-before') await rollback();
      await act(async () => { rejectRestart(new Error('[TERMINAL_NOT_FOUND] missing')); });
      if (ordering === 'open' || ordering === 'rollback-before') {
        expect(api.create).toHaveBeenCalledTimes(2);
        expect(api.create).toHaveBeenLastCalledWith({ id: ctx.tabId, cwd: ctx.workdir, cols: 80, rows: 24 });
        expect(ctx.patchState).toHaveBeenCalledWith(expect.objectContaining({ created: true }));
      } else {
        expect(api.create).toHaveBeenCalledOnce();
        expect(ctx.patchState).not.toHaveBeenCalled();
      }
      if (ordering === 'rollback-after') {
        await rollback();
        expect(api.create).toHaveBeenCalledOnce();
        vi.mocked(api.restart).mockRejectedValueOnce(new Error('[TERMINAL_NOT_FOUND] missing'));
        await act(async () => { fireEvent.click(screen.getByText('rightSidebar.terminal.restart')); });
        expect(api.create).toHaveBeenCalledTimes(2);
        expect(ctx.patchState).toHaveBeenCalledWith(expect.objectContaining({ created: true }));
      }
    },
  );
});

describe('TerminalTabBody remote ownership', () => {
  // Production close hook / unit tier: main-window closeAll must identify a PTY
  // owned by a popped-out renderer. Existing close tests only covered cancellation,
  // not the IPC identity contract. Missing origin must defer to main's owner check,
  // rather than invent a local context. Minimal inputs: remote origin or undefined.
  it.each(['device-1', undefined])('passes disposal identity when closing a terminal (origin: %s)', async (deviceId) => {
    vi.mocked(getSessionDeviceId).mockReturnValue(deviceId);
    const plugin = getTabKind('terminal')!;
    await plugin.onBeforeClose!(plugin.defaultState(), { tabId: 'terminal-1', sessionId: 'session-1' });
    expect(window.electronAPI.terminal.dispose).toHaveBeenCalledWith('terminal-1', deviceId ? {
      sessionId: 'session-1', deviceId,
    } : undefined);
    expect(getSessionDeviceId).toHaveBeenCalledWith('session-1');
  });

  // P1-2 / unit: the production close hook must veto rejected disposal without
  // losing scrollback/drafts or blocking retry. Existing tests only cover success.
  // Red: 3 failures / 2.19s wall; green related suite: 144 tests / 2.13s wall (macOS).
  it('vetoes rejected disposal, keeps the terminal draft and restores closing for retry', async () => {
    registerClosing('terminal-1', closing => { entry.closing = closing; });
    const draft = { contextKey: 'draft', connection: { host: 'example-host' }, submitted: false };
    entry.remoteDraft = draft;
    const dispose = vi.mocked(window.electronAPI.terminal.dispose);
    dispose.mockRejectedValueOnce(new Error('[PERMISSION_DENIED] /synthetic/private/key_ed25519'));
    const plugin = getTabKind('terminal')!;
    const closing = plugin.onBeforeClose!(plugin.defaultState(), { tabId: 'terminal-1', sessionId: 'session-1' });
    expect(entry.closing).toBe(true);
    await expect(closing).resolves.toBe(false);
    expect(entry.remoteDraft).toBe(draft);
    expect(entry.ptyAttached).toBe(true);
    expect(entry.closing).toBe(false);
    expect(toast.error).toHaveBeenCalledWith('rightSidebar.terminal.closeFailed');
    await plugin.onBeforeClose!(plugin.defaultState(), { tabId: 'terminal-1', sessionId: 'session-1' });
    expect(dispose).toHaveBeenCalledTimes(2);
    expect(entry.remoteDraft).toBeUndefined();
  });

  // P1-2 / unit: a temporarily absent device index must not replace the original
  // pooled remote context with local null. Covers the close hook's input contract.
  it('uses the retained remote origin when the device index is temporarily absent', async () => {
    vi.mocked(window.electronAPI.terminal.create).mockResolvedValue({ shellId: 'sh', shellDisplayName: 'SSH', pid: 1 });
    const ctx = makeContext({ deviceLinkDeviceId: 'device-1' });
    render(<TerminalTabBody state={{ created: true, exited: null, title: '', shellId: '', shellDisplayName: '' }} ctx={ctx} active />);
    await waitFor(() => expect(window.electronAPI.terminal.create).toHaveBeenCalled());
    vi.mocked(getSessionDeviceId).mockReturnValue(undefined);
    const plugin = getTabKind('terminal')!;
    await plugin.onBeforeClose!(plugin.defaultState(), { tabId: 'terminal-1', sessionId: 'session-1' });
    expect(window.electronAPI.terminal.dispose).toHaveBeenCalledWith('terminal-1', { sessionId: 'session-1', deviceId: 'device-1' });
  });

  // Production component regression: reload clears created/exit, and window
  // migration has no renderer-local attachment. Both must recover main's exit
  // notification and expose explicit restart without another SSH preparation.
  // Unit tier: fake IPC/xterm; standalone file wall time 1.58s on Node 22.22.3.
  it.each([false, true])('restarts a reattached exited SSH instance (previously created: %s)', async created => {
    entry.ptyAttached = false;
    const api = window.electronAPI.terminal;
    let notifyExit!: Parameters<typeof api.onExit>[0];
    vi.mocked(api.onExit).mockImplementation(callback => { notifyExit = callback; return () => {}; });
    vi.mocked(api.create).mockImplementation(async () => {
      notifyExit({ id: 'terminal-1', exit: { code: 255, signal: null } });
      return { shellId: 'sh', shellDisplayName: 'SSH', pid: 1 };
    });
    vi.mocked(api.restart).mockResolvedValue({ shellId: 'sh', shellDisplayName: 'SSH', pid: 2 });
    const ctx = makeContext({ deviceLinkDeviceId: 'device-1' });
    function Session() {
      const [state, setState] = useState({ created, exited: null as { code: number | null; signal: string | null } | null, title: '', shellId: '', shellDisplayName: '' });
      const patchState = useCallback((patch: unknown) => setState(previous => ({ ...previous, ...(patch as object) })), []);
      return <TerminalTabBody state={state} ctx={{ ...ctx, patchState }} active />;
    }
    render(<Session />);
    const restart = await screen.findByText('rightSidebar.terminal.restart');
    await waitFor(() => expect(entry.ptyAttached).toBe(true));
    expect(api.create).toHaveBeenCalledOnce();
    expect(api.describeRemote).not.toHaveBeenCalled();
    expect(api.restart).not.toHaveBeenCalled();
    fireEvent.click(restart);
    await waitFor(() => expect(api.restart).toHaveBeenCalledWith('terminal-1'));
    await waitFor(() => expect(screen.queryByText('rightSidebar.terminal.restart')).toBeNull());
    expect(api.create).toHaveBeenCalledOnce();
    expect(api.describeRemote).not.toHaveBeenCalled();
  });
  // Invalidating a real auth realm removes the PTY. Its exit notice must expose
  // Restart, and NOT_FOUND on that click must obtain fresh main authorization.
  it('re-prepares a session disposed by an authentication boundary after its exit notice', async () => {
    const api = window.electronAPI.terminal;
    let notifyExit!: Parameters<typeof api.onExit>[0];
    vi.mocked(api.onExit).mockImplementation(callback => { notifyExit = callback; return () => {}; });
    vi.mocked(api.create).mockResolvedValueOnce({ shellId: 'sh', shellDisplayName: 'SSH', pid: 1 });
    vi.mocked(api.restart).mockRejectedValueOnce(new Error('[TERMINAL_NOT_FOUND] Invalidated session'));
    vi.mocked(api.describeRemote).mockResolvedValue({ context: { sessionId: 'session-1' }, target: { key: 'target', label: 'Host', cwd: '/remote' }, connection: { host: 'saved' }, candidates: [], ticket: 'fresh-after-boundary' });
    const ctx = makeContext({ deviceLinkDeviceId: 'device-1' });
    function Session() {
      const [state, setState] = useState({ created: true, exited: null as { code: number | null; signal: string | null } | null, title: '', shellId: '', shellDisplayName: '' });
      const patchState = useCallback((patch: unknown) => setState(previous => ({ ...previous, ...(patch as object) })), []);
      return <TerminalTabBody state={state} ctx={{ ...ctx, patchState }} active />;
    }
    render(<Session />);
    await waitFor(() => expect(entry.ptyAttached).toBe(true));
    act(() => notifyExit({ id: ctx.tabId, exit: { code: null, signal: null } }));
    fireEvent.click(await screen.findByText('rightSidebar.terminal.restart'));
    await waitFor(() => expect(api.create).toHaveBeenCalledWith(expect.objectContaining({ remote: { sessionId: ctx.sessionId, deviceId: 'device-1', ticket: 'fresh-after-boundary' } })));
    await waitFor(() => expect(screen.queryByText('rightSidebar.terminal.restart')).toBeNull());
    expect(api.restart).toHaveBeenCalledOnce();
  });

  // Unit regression: task switches keep the pool and tab state but remove exit
  // listeners. Existing reload/migration cases start with ptyAttached=false and
  // miss this sequence. The real component must recover Restart on return.
  // Standalone file: 32 tests, 2.42s wall time (macOS).
  it('recovers an SSH exit missed while the pooled terminal body is unmounted', async () => {
    const deviceLinkDeviceId = 'device-1';
    entry.ptyAttached = false;
    const api = window.electronAPI.terminal;
    const listeners = new Set<Parameters<typeof api.onExit>[0]>();
    let backendExit: { code: number; signal: null } | null = null;
    vi.mocked(api.onExit).mockImplementation(callback => {
      listeners.add(callback);
      return () => { listeners.delete(callback); };
    });
    vi.mocked(api.create).mockImplementation(async () => {
      if (backendExit) listeners.forEach(callback => callback({ id: 'terminal-1', exit: backendExit! }));
      return { shellId: 'sh', shellDisplayName: 'Shell', pid: 1 };
    });
    vi.mocked(api.restart).mockResolvedValue({ shellId: 'sh', shellDisplayName: 'Shell', pid: 2 });
    const ctx = makeContext({ deviceLinkDeviceId });
    function Session({ visible }: { visible: boolean }) {
      const [state, setState] = useState({ created: false, exited: null as typeof backendExit, title: '', shellId: '', shellDisplayName: '' });
      const patchState = useCallback((patch: unknown) => setState(previous => ({ ...previous, ...(patch as object) })), []);
      return visible ? <TerminalTabBody state={state} ctx={{ ...ctx, patchState }} active /> : null;
    }
    const view = render(<Session visible />);
    await waitFor(() => expect(entry.ptyAttached).toBe(true));
    expect(api.create).toHaveBeenCalledOnce();
    view.rerender(<Session visible={false} />);
    expect(listeners.size).toBe(0);
    backendExit = { code: 0, signal: null };
    listeners.forEach(callback => callback({ id: 'terminal-1', exit: backendExit! }));
    expect(entry.ptyAttached).toBe(true);
    view.rerender(<Session visible />);
    fireEvent.click(await screen.findByText('rightSidebar.terminal.restart'));
    await waitFor(() => expect(screen.queryByText('rightSidebar.terminal.restart')).toBeNull());
    expect(api.restart).toHaveBeenCalledWith('terminal-1');
    expect(api.create).toHaveBeenCalledTimes(2);
    expect(api.describeRemote).not.toHaveBeenCalled();
  });

  // A fresh main process can create a new shell while hydrated tab state still
  // contains the old exit. Clear it before attach, retaining any new exit replay.
  it.each([false, true])('reconciles stale persisted exit before attaching (replayed exit: %s)', async replay => {
    const api = window.electronAPI.terminal;
    let notifyExit!: Parameters<typeof api.onExit>[0];
    vi.mocked(api.onExit).mockImplementation(callback => { notifyExit = callback; return () => {}; });
    vi.mocked(api.create).mockImplementation(async () => {
      if (replay) notifyExit({ id: 'terminal-1', exit: { code: 255, signal: null } });
      return { shellId: 'sh', shellDisplayName: 'Shell', pid: 1 };
    });
    const ctx = makeContext({ deviceLinkDeviceId: 'device-1' });
    function Session() {
      const [state, setState] = useState({ created: true, exited: { code: 0, signal: '0' } as { code: number; signal: string | null } | null, title: '', shellId: '', shellDisplayName: '' });
      const patchState = useCallback((patch: unknown) => setState(previous => ({ ...previous, ...(patch as object) })), []);
      return <TerminalTabBody state={state} ctx={{ ...ctx, patchState }} active />;
    }
    render(<Session />);
    await act(async () => {});
    expect(Boolean(screen.queryByText('rightSidebar.terminal.restart'))).toBe(replay);
    expect(screen.queryByText('rightSidebar.terminal.processKilled')).toBeNull();
    expect(api.create).toHaveBeenCalledOnce();
  });

  // Native reload exposed an old canonical snapshot arriving during attachment.
  // Reconcile on completion too, while preserving a real exit delivered in flight.
  it.each([false, true])('reconciles hydration arriving during attach (live exit: %s)', async replay => {
    const api = window.electronAPI.terminal;
    let notifyExit!: Parameters<typeof api.onExit>[0];
    let finish!: (value: Awaited<ReturnType<typeof api.create>>) => void;
    let restoreSnapshot!: () => void;
    vi.mocked(api.onExit).mockImplementation(callback => { notifyExit = callback; return () => {}; });
    vi.mocked(api.create).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const ctx = makeContext({ deviceLinkDeviceId: 'device-1' });
    function Session() {
      const [state, setState] = useState({ created: true, exited: { code: 7, signal: null } as { code: number; signal: string | null } | null, title: '', shellId: '', shellDisplayName: '' });
      restoreSnapshot = () => setState(previous => ({ ...previous, exited: { code: 7, signal: null } }));
      const patchState = useCallback((patch: unknown) => setState(previous => ({ ...previous, ...(patch as object) })), []);
      return <TerminalTabBody state={state} ctx={{ ...ctx, patchState }} active />;
    }
    render(<Session />);
    await act(async () => {
      restoreSnapshot();
      if (replay) notifyExit({ id: ctx.tabId, exit: { code: 255, signal: null } });
      finish({ shellId: 'sh', shellDisplayName: 'SSH', pid: 1 });
    });
    expect(Boolean(screen.queryByText('rightSidebar.terminal.restart'))).toBe(replay);
    expect(api.create).toHaveBeenCalledOnce();
  });

  it('continues to create a PTY for a confirmed local session', async () => {
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

  it('fails closed while device-link ownership is unresolved', () => {
    const ctx = makeContext({ deviceLinkDeviceId: undefined });
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

  // Remote ownership and first-create failure must not fall back to a local PTY
  // or restart a resource that was never created (remote-and-mobile-adaptation).
  // PR8881 r4475914874 / unit: .work replaces the ordinary valid input to cover
  // the missing leading-dot form submission through the real terminal component.
  it('accepts a manual host without candidates, validates it, and creates against the remote context', async () => {
    const ctx = makeContext({ deviceLinkDeviceId: 'device-1', remoteHostId: 'nested-host' });
    render(<TerminalTabBody state={{ created: false, exited: null, title: '', shellId: '', shellDisplayName: '' }} ctx={ctx} active />);
    const host = await screen.findByLabelText('rightSidebar.terminal.remote.host');
    fireEvent.click(screen.getByText('rightSidebar.terminal.remote.connect'));
    expect(screen.getByText('rightSidebar.terminal.remote.hostInvalid')).toBeTruthy();
    expect(window.electronAPI.terminal.create).toHaveBeenCalledTimes(1);
    fireEvent.change(host, { target: { value: 'host!' } });
    fireEvent.click(screen.getByText('rightSidebar.terminal.remote.connect'));
    expect(screen.getByText('rightSidebar.terminal.remote.hostInvalid')).toBeTruthy();
    fireEvent.change(host, { target: { value: '.work' } });
    fireEvent.change(screen.getByLabelText('rightSidebar.terminal.remote.user'), { target: { value: 'user+name' } });
    fireEvent.click(screen.getByText('rightSidebar.terminal.remote.connect'));
    expect(screen.getByText('rightSidebar.terminal.remote.userInvalid')).toBeTruthy();
    expect(window.electronAPI.terminal.create).toHaveBeenCalledTimes(1);
    fireEvent.change(screen.getByLabelText('rightSidebar.terminal.remote.user'), { target: { value: 'alice' } });
    fireEvent.click(screen.getByText('rightSidebar.terminal.remote.connect'));
    await waitFor(() => expect(window.electronAPI.terminal.describeRemote).toHaveBeenCalledWith({
      id: 'terminal-1', sessionId: 'session-1', deviceId: 'device-1', connection: { host: '.work', user: 'alice' },
    }));
    await waitFor(() => expect(window.electronAPI.terminal.create).toHaveBeenCalledWith(expect.objectContaining({
      remote: { sessionId: 'session-1', deviceId: 'device-1', ticket: 'prepared-ticket' },
    })));
  });

  it('prefills the selected SSH configuration and retains form edits across activation changes', async () => {
    vi.mocked(window.electronAPI.terminal.describeRemote).mockResolvedValueOnce({
      context: { sessionId: 'session-1' }, target: { key: 'target', label: 'Host', cwd: '/remote' }, connection: null,
      candidates: [{ host: 'configured', user: 'bob', port: 2222, hostRef: 'opaque-host' }],
    });
    const ctx = makeContext({ remoteHostId: 'ssh-host-1' });
    const state = { created: false, exited: null, title: '', shellId: '', shellDisplayName: '' };
    const view = render(<TerminalTabBody state={state} ctx={ctx} active />);
    await screen.findByLabelText('rightSidebar.terminal.remote.host');
    fireEvent.change(screen.getByLabelText('rightSidebar.terminal.remote.selectedHost'), { target: { value: '0' } });
    fireEvent.change(screen.getByLabelText('rightSidebar.terminal.remote.user'), { target: { value: 'carol' } });
    fireEvent.change(screen.getByLabelText('rightSidebar.terminal.remote.host'), { target: { value: 'configured-alias' } });
    view.rerender(<TerminalTabBody state={state} ctx={ctx} active={false} />);
    view.rerender(<TerminalTabBody state={state} ctx={ctx} active />);
    expect(window.electronAPI.terminal.describeRemote).toHaveBeenCalledTimes(1);
    expect((screen.getByLabelText('rightSidebar.terminal.remote.user') as HTMLInputElement).value).toBe('carol');
    fireEvent.click(screen.getByText('rightSidebar.terminal.remote.connect'));
    await waitFor(() => expect(window.electronAPI.terminal.describeRemote).toHaveBeenCalledWith({
      id: 'terminal-1', sessionId: 'session-1', connection: { host: 'configured-alias', user: 'carol', port: 2222, hostRef: undefined },
    }));
    await waitFor(() => expect(window.electronAPI.terminal.create).toHaveBeenCalledWith(expect.objectContaining({
      remote: { sessionId: 'session-1', ticket: 'prepared-ticket' },
    })));
  });

  it('prepares a fresh ticket after a failed spawn instead of reusing the consumed ticket', async () => {
    vi.mocked(window.electronAPI.terminal.create)
      .mockRejectedValueOnce(new Error('[PRECONDITION_FAILED] prepare'))
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ shellId: 'sh', shellDisplayName: 'SSH', pid: 1 });
    vi.mocked(window.electronAPI.terminal.describeRemote)
      .mockResolvedValueOnce({ context: { sessionId: 'session-1' }, target: { key: 'target', label: 'Host', cwd: '/remote' }, connection: { host: 'saved' }, candidates: [], ticket: 'first' })
      .mockResolvedValueOnce({ context: { sessionId: 'session-1' }, target: { key: 'target', label: 'Host', cwd: '/remote' }, connection: { host: 'saved' }, candidates: [], ticket: 'second' });
    const ctx = makeContext({ deviceLinkDeviceId: 'device-1' });
    render(<TerminalTabBody state={{ created: false, exited: null, title: '', shellId: '', shellDisplayName: '' }} ctx={ctx} active />);
    fireEvent.click(await screen.findByText('rightSidebar.terminal.restart'));
    await waitFor(() => expect(ctx.patchState).toHaveBeenCalledWith(expect.objectContaining({ created: true })));
    expect(vi.mocked(window.electronAPI.terminal.create).mock.calls.map(([params]) => params.remote?.ticket)).toEqual([undefined, 'first', 'second']);
    expect(window.electronAPI.terminal.describeRemote).toHaveBeenCalledTimes(2);
    expect(window.electronAPI.terminal.restart).not.toHaveBeenCalled();
  });

  // Opaque credential references are scoped to an account generation. Retry must
  // allow fresh selection, never loop on the old ref or fall back to no key.
  it.each([false, true])('recovers an expired host reference through fresh selection (binding only: %s)', async bindingOnly => {
    const ctx = makeContext({ deviceLinkDeviceId: 'device-1' });
    const old = { host: 'build', user: 'builder', hostRef: 'old-ref' };
    entry.remoteDraft = { contextKey: JSON.stringify([ctx.sessionId, ctx.deviceLinkDeviceId, ctx.remoteHostId]), connection: old, submitted: true };
    const fresh = { ...old, hostRef: 'new-ref' };
    const describe = vi.mocked(window.electronAPI.terminal.describeRemote);
    describe.mockRejectedValueOnce(new Error('[PRECONDITION_FAILED] SSH host reference is unavailable'))
      .mockResolvedValueOnce({ context: { sessionId: ctx.sessionId }, target: { key: 'target', label: 'Host', cwd: '/remote' }, connection: fresh, candidates: bindingOnly ? [] : [fresh], ticket: 'unused-edit-ticket' });
    render(<TerminalTabBody state={{ created: false, exited: null, title: '', shellId: '', shellDisplayName: '' }} ctx={ctx} active />);
    fireEvent.click(await screen.findByText('commonUi.retry'));
    const host = await screen.findByLabelText('rightSidebar.terminal.remote.host');
    expect((host as HTMLInputElement).value).toBe('build');
    expect((screen.getByLabelText('rightSidebar.terminal.remote.user') as HTMLInputElement).value).toBe('builder');
    expect(describe.mock.calls[1][0]).toEqual({ id: ctx.tabId, sessionId: ctx.sessionId, deviceId: 'device-1' });
    expect(window.electronAPI.terminal.create).toHaveBeenCalledTimes(1);
    expect(screen.getByText('rightSidebar.terminal.remote.selectAgain')).toBeTruthy();
    expect((screen.getByText('rightSidebar.terminal.remote.connect') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.submit(host.closest('form')!);
    expect(describe).toHaveBeenCalledTimes(2);
    fireEvent.change(screen.getByLabelText('rightSidebar.terminal.remote.selectedHost'), { target: { value: '0' } });
    expect(screen.queryByText('rightSidebar.terminal.remote.selectAgain')).toBeNull();
    expect((screen.getByText('rightSidebar.terminal.remote.connect') as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByText('rightSidebar.terminal.remote.connect'));
    await waitFor(() => expect(describe).toHaveBeenCalledWith({ id: ctx.tabId, sessionId: ctx.sessionId, deviceId: 'device-1', connection: fresh }));
    await waitFor(() => expect(window.electronAPI.terminal.create).toHaveBeenCalledWith(expect.objectContaining({ remote: { sessionId: ctx.sessionId, deviceId: 'device-1', ticket: 'prepared-ticket' } })));
  });

  // A failed preparation must retry the selected connection, not silently use an older binding.
  it('retries preparation with the explicitly selected connection', async () => {
    const describe = vi.mocked(window.electronAPI.terminal.describeRemote);
    describe.mockImplementationOnce(async () => ({ context: { sessionId: 'session-1' }, target: { key: 'target', label: 'Host', cwd: '/remote' }, connection: null, candidates: [] }))
      .mockRejectedValueOnce(new Error('offline'));
    render(<TerminalTabBody state={{ created: false, exited: null, title: '', shellId: '', shellDisplayName: '' }} ctx={makeContext({ deviceLinkDeviceId: 'device-1' })} active />);
    fireEvent.change(await screen.findByLabelText('rightSidebar.terminal.remote.host'), { target: { value: 'new-host' } });
    fireEvent.click(screen.getByText('rightSidebar.terminal.remote.connect'));
    fireEvent.click(await screen.findByText('commonUi.retry'));
    await waitFor(() => expect(window.electronAPI.terminal.create).toHaveBeenCalledWith(expect.objectContaining({ remote: { sessionId: 'session-1', deviceId: 'device-1', ticket: 'prepared-ticket' } })));
    expect(describe.mock.calls.slice(1)).toEqual([
      [{ id: 'terminal-1', sessionId: 'session-1', deviceId: 'device-1', connection: { host: 'new-host', user: undefined } }],
      [{ id: 'terminal-1', sessionId: 'session-1', deviceId: 'device-1', connection: { host: 'new-host', user: undefined } }],
    ]);
  });

  it('ignores a prepared ticket after the terminal is unmounted', async () => {
    let finishPrepare!: (value: { context: { sessionId: string }; target: { key: string; label: string; cwd: string }; connection: { host: string }; candidates: []; ticket: string }) => void;
    vi.mocked(window.electronAPI.terminal.describeRemote).mockImplementationOnce(() => new Promise((resolve) => { finishPrepare = resolve; }));
    const view = render(<TerminalTabBody state={{ created: false, exited: null, title: '', shellId: '', shellDisplayName: '' }} ctx={makeContext({ deviceLinkDeviceId: 'device-1' })} active />);
    await waitFor(() => expect(window.electronAPI.terminal.describeRemote).toHaveBeenCalled());
    view.unmount();
    finishPrepare({ context: { sessionId: 'session-1' }, target: { key: 'target', label: 'Host', cwd: '/remote' }, connection: { host: 'saved' }, candidates: [], ticket: 'expired' });
    await Promise.resolve();
    expect(window.electronAPI.terminal.create).toHaveBeenCalledTimes(1);
  });

  // Unit regressions: close and task switches can occur while host IPC is pending;
  // the existing unmount-only test does not cover a still-mounted closing tab.
  it('ignores preparation after close starts, even after dispose returns while mounted', async () => {
    let finishPrepare!: (value: any) => void;
    let finishDispose!: () => void;
    vi.mocked(window.electronAPI.terminal.describeRemote).mockImplementationOnce(() => new Promise((resolve) => { finishPrepare = resolve; }));
    vi.mocked(window.electronAPI.terminal.dispose).mockImplementationOnce(() => new Promise((resolve) => { finishDispose = resolve; }));
    const ctx = makeContext({ deviceLinkDeviceId: 'device-1' });
    const state = { created: false, exited: null, title: '', shellId: '', shellDisplayName: '' };
    render(<TerminalTabBody state={state} ctx={ctx} active />);
    await waitFor(() => expect(window.electronAPI.terminal.describeRemote).toHaveBeenCalled());
    const closing = getTabKind('terminal')!.onBeforeClose!(state, { tabId: ctx.tabId, sessionId: ctx.sessionId });
    expect(entry.closing).toBe(true);
    await waitFor(() => expect(window.electronAPI.terminal.dispose).toHaveBeenCalled());
    finishDispose();
    await closing;
    await act(async () => { finishPrepare({ context: { sessionId: 'session-1' }, target: { key: 'target', label: 'Host', cwd: '/remote' }, connection: { host: 'saved' }, candidates: [], ticket: 'late' }); });
    expect(window.electronAPI.terminal.create).toHaveBeenCalledTimes(1);
  });

  // PR8881 / unit: real preparation + close hook must recover without a parent
  // render. Existing success/unmount cases miss rejected disposal. Minimal race:
  // describe settles during close, or an older describe settles after rollback.
  it.each(['before', 'after', 'mount-during-close'] as const)('retries preparation after close fails (%s)', async ordering => {
    const api = window.electronAPI.terminal;
    let finishPrepare!: (value: Awaited<ReturnType<typeof api.describeRemote>>) => void;
    let rejectDispose!: (error: Error) => void;
    const description = { context: { sessionId: 'session-1' }, target: { key: 'target', label: 'Host', cwd: '/remote' }, connection: null, candidates: [] };
    const describe = vi.mocked(api.describeRemote);
    if (ordering !== 'mount-during-close') {
      describe.mockImplementationOnce(() => new Promise(resolve => { finishPrepare = resolve; }));
    }
    describe.mockResolvedValue(description);
    vi.mocked(api.dispose).mockImplementationOnce(() => new Promise((_, reject) => { rejectDispose = reject; }));
    const ctx = makeContext({ deviceLinkDeviceId: 'device-1' });
    const state = { created: false, exited: null, title: '', shellId: '', shellDisplayName: '' };
    const mount = () => render(<TerminalTabBody state={state} ctx={ctx} active />);
    if (ordering !== 'mount-during-close') {
      mount();
      await waitFor(() => expect(describe).toHaveBeenCalledOnce());
    }
    let closing: void | boolean | Promise<void | boolean>;
    act(() => { closing = getTabKind('terminal')!.onBeforeClose!(state, { tabId: ctx.tabId, sessionId: ctx.sessionId }); });
    if (ordering === 'mount-during-close') {
      entry.remoteDraft = { contextKey: JSON.stringify([ctx.sessionId, ctx.deviceLinkDeviceId, ctx.remoteHostId]), submitted: false };
      mount();
      expect(describe).not.toHaveBeenCalled();
    }
    await waitFor(() => expect(api.dispose).toHaveBeenCalled());
    if (ordering === 'before') await act(async () => { finishPrepare(description); });
    expect(screen.queryByLabelText('rightSidebar.terminal.remote.host')).toBeNull();
    await act(async () => {
      rejectDispose(new Error('offline'));
      expect(await closing).toBe(false);
    });
    expect(await screen.findByLabelText('rightSidebar.terminal.remote.host')).toBeTruthy();
    if (ordering === 'after') {
      await act(async () => { finishPrepare({ ...description, ticket: 'stale-ticket' }); });
      expect(screen.getByLabelText('rightSidebar.terminal.remote.host')).toBeTruthy();
    }
    expect(describe).toHaveBeenCalledTimes(ordering === 'mount-during-close' ? 1 : 2);
    expect(api.create).toHaveBeenCalledTimes(ordering === 'mount-during-close' ? 0 : 1);
  });

  // PR8881 discussion_r4476128365 / unit: the real body must resume a skipped
  // create/attach after close rollback. Prepare-stage tests miss this stage and
  // the pending-result race. Fake IPC promises control each ordering without waits.
  it.each([null, 'device-1'].flatMap(deviceLinkDeviceId =>
    ['mount', 'result-during-close', 'rollback-before-result', 'reattach-result'].map(ordering => ({ deviceLinkDeviceId, ordering })),
  ))('recovers terminal-stage close cancellation ($deviceLinkDeviceId, $ordering)', async ({ deviceLinkDeviceId, ordering }) => {
    const api = window.electronAPI.terminal;
    const result = { shellId: 'sh' as const, shellDisplayName: 'Shell', pid: 1 };
    vi.mocked(api.create).mockResolvedValue(result);
    let finishCreate!: (value: typeof result) => void;
    let rejectDispose!: (error: Error) => void;
    vi.mocked(api.dispose).mockImplementationOnce(() => new Promise((_, reject) => { rejectDispose = reject; }));
    let ctx = makeContext({ deviceLinkDeviceId });
    const state = { created: ordering === 'reattach-result', exited: null, title: '', shellId: '', shellDisplayName: '' };
    let view: ReturnType<typeof render>;
    if (ordering === 'reattach-result') {
      view = render(<TerminalTabBody state={state} ctx={ctx} active />);
      await act(async () => {});
      entry.ptyAttached = false;
      ctx = { ...ctx, workdir: '/another-workspace' };
    }
    if (ordering !== 'mount') {
      vi.mocked(api.create).mockImplementationOnce(() => new Promise(resolve => { finishCreate = resolve; }));
      if (ordering === 'reattach-result') view!.rerender(<TerminalTabBody state={state} ctx={ctx} active />);
      else view = render(<TerminalTabBody state={state} ctx={ctx} active />);
    }
    const closing = getTabKind('terminal')!.onBeforeClose!(state, { tabId: ctx.tabId, sessionId: ctx.sessionId });
    if (ordering === 'mount') {
      view = render(<TerminalTabBody state={state} ctx={ctx} active />);
      expect(api.create).not.toHaveBeenCalled();
    } else if (ordering !== 'rollback-before-result') {
      await act(async () => { finishCreate(result); });
      expect(ctx.patchState).not.toHaveBeenCalledWith(expect.objectContaining({ created: true }));
    }
    await act(async () => {});
    await act(async () => {
      rejectDispose(new Error('offline'));
      expect(await closing).toBe(false);
    });
    if (ordering === 'rollback-before-result') {
      expect(api.create).toHaveBeenCalledOnce();
      await act(async () => { finishCreate(result); });
    }
    expect(api.create).toHaveBeenCalledTimes(ordering === 'reattach-result' ? 3 : ordering === 'result-during-close' ? 2 : 1);
    expect(entry.ptyAttached).toBe(true);
    if (!state.created) expect(ctx.patchState).toHaveBeenCalledWith(expect.objectContaining({ created: true, shellDisplayName: 'Shell' }));
    expect(screen.queryByText('settings.remote.status.connecting')).toBeNull();
    view!.rerender(<TerminalTabBody state={{ ...state, created: true }} ctx={ctx} active />);
    // A later failed close of an attached shell must neither attach nor restart.
    const calls = vi.mocked(api.create).mock.calls.length;
    vi.mocked(api.dispose).mockRejectedValueOnce(new Error('offline again'));
    await act(async () => { await getTabKind('terminal')!.onBeforeClose!(state, { tabId: ctx.tabId, sessionId: ctx.sessionId }); });
    expect(api.create).toHaveBeenCalledTimes(calls);
    expect(api.restart).not.toHaveBeenCalled();
    expect(api.describeRemote).not.toHaveBeenCalled();
    view!.unmount();
    expect(entry.closeCancelledListeners.size).toBe(0);
  });

  it('blocks a terminal first mounted after close starts and before disposal completes', async () => {
    let finishDispose!: () => void;
    vi.mocked(window.electronAPI.terminal.dispose).mockImplementationOnce(() => new Promise((resolve) => { finishDispose = resolve; }));
    const ctx = makeContext({ deviceLinkDeviceId: 'device-1' });
    const state = { created: false, exited: null, title: '', shellId: '', shellDisplayName: '' };
    const closing = getTabKind('terminal')!.onBeforeClose!(state, { tabId: ctx.tabId, sessionId: ctx.sessionId });
    render(<TerminalTabBody state={state} ctx={ctx} active />);
    expect(entry.closing).toBe(true);
    expect(window.electronAPI.terminal.create).not.toHaveBeenCalled();
    expect(window.electronAPI.terminal.describeRemote).not.toHaveBeenCalled();
    await waitFor(() => expect(window.electronAPI.terminal.dispose).toHaveBeenCalled());
    await act(async () => { finishDispose(); await closing; });
    expect(window.electronAPI.terminal.create).not.toHaveBeenCalled();
  });

  it('prepares a submitted host again when returning after a pending preparation', async () => {
    let finishPrepare!: (value: any) => void;
    const describe = vi.mocked(window.electronAPI.terminal.describeRemote);
    describe.mockImplementationOnce(async () => ({ context: { sessionId: 'session-1' }, target: { key: 'target', label: 'Host', cwd: '/remote' }, connection: null, candidates: [] }))
      .mockImplementationOnce(() => new Promise((resolve) => { finishPrepare = resolve; }));
    const ctx = makeContext({ deviceLinkDeviceId: 'device-1' });
    const state = { created: false, exited: null, title: '', shellId: '', shellDisplayName: '' };
    const view = render(<TerminalTabBody state={state} ctx={ctx} active />);
    fireEvent.change(await screen.findByLabelText('rightSidebar.terminal.remote.host'), { target: { value: 'chosen-host' } });
    fireEvent.click(screen.getByText('rightSidebar.terminal.remote.connect'));
    await waitFor(() => expect(describe).toHaveBeenCalledTimes(2));
    view.unmount();
    render(<TerminalTabBody state={state} ctx={ctx} active />);
    await waitFor(() => expect(window.electronAPI.terminal.create).toHaveBeenCalledWith(expect.objectContaining({ remote: { sessionId: 'session-1', deviceId: 'device-1', ticket: 'prepared-ticket' } })));
    expect(describe).toHaveBeenLastCalledWith(expect.objectContaining({ connection: { host: 'chosen-host', user: undefined } }));
    await act(async () => { finishPrepare({ context: { sessionId: 'session-1' }, target: { key: 'target', label: 'Host', cwd: '/remote' }, connection: { host: 'chosen-host' }, candidates: [], ticket: 'late' }); });
    expect(window.electronAPI.terminal.create).toHaveBeenCalledTimes(3);
  });

  it('attaches a submitted host already created in main before preparing again', async () => {
    entry.remoteDraft = { contextKey: JSON.stringify(['session-1', 'device-1', null]), connection: { host: 'chosen-host' }, submitted: true };
    entry.ptyAttached = false;
    vi.mocked(window.electronAPI.terminal.create).mockResolvedValueOnce({ shellId: 'sh', shellDisplayName: 'SSH', pid: 1 });
    const ctx = makeContext({ deviceLinkDeviceId: 'device-1' });
    render(<TerminalTabBody state={{ created: false, exited: null, title: '', shellId: '', shellDisplayName: '' }} ctx={ctx} active />);
    await waitFor(() => expect(ctx.patchState).toHaveBeenCalledWith(expect.objectContaining({ created: true })));
    expect(window.electronAPI.terminal.create).toHaveBeenCalledWith(expect.objectContaining({ remote: { sessionId: 'session-1', deviceId: 'device-1' } }));
    expect(window.electronAPI.terminal.describeRemote).not.toHaveBeenCalled();
    expect(entry.remoteDraft).toBeUndefined();
  });

  it('retains an unsubmitted draft across task switches without saving a binding', async () => {
    const ctx = makeContext({ deviceLinkDeviceId: 'device-1' });
    const state = { created: false, exited: null, title: '', shellId: '', shellDisplayName: '' };
    const view = render(<TerminalTabBody state={state} ctx={ctx} active />);
    fireEvent.change(await screen.findByLabelText('rightSidebar.terminal.remote.host'), { target: { value: 'draft-host' } });
    fireEvent.change(screen.getByLabelText('rightSidebar.terminal.remote.user'), { target: { value: 'alice' } });
    view.unmount();
    vi.mocked(window.electronAPI.terminal.describeRemote).mockResolvedValueOnce({
      context: { sessionId: 'session-1', deviceId: 'device-1' }, target: { key: 'target', label: 'Host', cwd: '/remote' }, connection: { host: 'saved-host' }, candidates: [],
    });
    render(<TerminalTabBody state={state} ctx={ctx} active />);
    expect((await screen.findByLabelText('rightSidebar.terminal.remote.host') as HTMLInputElement).value).toBe('draft-host');
    expect((screen.getByLabelText('rightSidebar.terminal.remote.user') as HTMLInputElement).value).toBe('alice');
    expect(window.electronAPI.terminal.create).toHaveBeenCalledTimes(1);
  });

  it('subscribes before adopting a pending first connection in a new renderer without a saved binding', async () => {
    let completeAttach!: (result: { shellId: 'sh'; shellDisplayName: string; pid: number }) => void;
    entry.terminal.cols = 120;
    entry.terminal.rows = 40;
    entry.terminal.write.mockClear();
    vi.mocked(window.electronAPI.terminal.create).mockImplementationOnce(() => {
      const onData = vi.mocked(window.electronAPI.terminal.onData).mock.calls[0][0];
      onData({ id: 'terminal-1', chunk: 'Password: ' });
      return new Promise((resolve) => { completeAttach = resolve; });
    });
    const ctx = makeContext({ deviceLinkDeviceId: 'device-1' });
    render(<TerminalTabBody state={{ created: false, exited: null, title: '', shellId: '', shellDisplayName: '' }} ctx={ctx} active />);
    expect(entry.terminal.write).toHaveBeenCalledWith('Password: ');
    expect(window.electronAPI.terminal.onExit).toHaveBeenCalled();
    completeAttach({ shellId: 'sh', shellDisplayName: 'SSH', pid: 1 });
    await waitFor(() => expect(ctx.patchState).toHaveBeenCalledWith(expect.objectContaining({ created: true })));
    expect(resize).toHaveBeenCalledWith('terminal-1', 120, 40);
    expect(window.electronAPI.terminal.create).toHaveBeenCalledTimes(1);
    expect(window.electronAPI.terminal.describeRemote).not.toHaveBeenCalled();
  });

  it.each([80, 120])('syncs a hidden attached terminal on visibility even when the width is %i', async (cols) => {
    entry.ptyAttached = false;
    vi.mocked(window.electronAPI.terminal.create).mockResolvedValueOnce({
      shellId: 'sh', shellDisplayName: 'SSH', pid: 1,
    });
    const ctx = makeContext({ deviceLinkDeviceId: 'device-1' });
    const state = { created: true, exited: null, title: '', shellId: '', shellDisplayName: '' };
    const view = render(<TerminalTabBody state={state} ctx={ctx} active={false} />);
    await waitFor(() => expect(entry.ptyAttached).toBe(true));
    expect(resize).not.toHaveBeenCalled();
    entry.terminal.cols = cols;
    view.rerender(<TerminalTabBody state={state} ctx={ctx} active />);
    expect(resize).toHaveBeenCalledWith('terminal-1', cols, 24);
  });

  it('waits for valid character measurements before resizing an attached terminal', async () => {
    entry.ptyAttached = false;
    proposeDimensions.mockReturnValueOnce(undefined).mockReturnValueOnce(undefined).mockReturnValueOnce(undefined);
    vi.mocked(window.electronAPI.terminal.create).mockResolvedValueOnce({ shellId: 'sh', shellDisplayName: 'SSH', pid: 1 });
    const ctx = makeContext({ deviceLinkDeviceId: 'device-1' });
    render(<TerminalTabBody state={{ created: true, exited: null, title: '', shellId: '', shellDisplayName: '' }} ctx={ctx} active />);
    await waitFor(() => expect(entry.ptyAttached).toBe(true));
    expect(resize).not.toHaveBeenCalled();
    entry.terminal.cols = 120;
    entry.terminal.rows = 40;
    TestResizeObserver.callback?.([], {} as ResizeObserver);
    expect(resize).toHaveBeenCalledWith('terminal-1', 120, 40);
  });

  it('measures a newly visible terminal before an in-flight attach completes', async () => {
    entry.ptyAttached = false;
    let completeAttach!: (result: { shellId: 'sh'; shellDisplayName: string; pid: number }) => void;
    vi.mocked(window.electronAPI.terminal.create).mockImplementationOnce(() => new Promise((resolve) => { completeAttach = resolve; }));
    vi.stubGlobal('requestAnimationFrame', () => 1);
    const ctx = makeContext({ deviceLinkDeviceId: 'device-1' });
    const state = { created: true, exited: null, title: '', shellId: '', shellDisplayName: '' };
    const view = render(<TerminalTabBody state={state} ctx={ctx} active={false} />);
    view.rerender(<TerminalTabBody state={state} ctx={ctx} active />);
    entry.terminal.cols = 120;
    entry.terminal.rows = 40;
    completeAttach({ shellId: 'sh', shellDisplayName: 'SSH', pid: 1 });
    await waitFor(() => expect(resize).toHaveBeenCalledWith('terminal-1', 120, 40));
    expect(resize).not.toHaveBeenCalledWith('terminal-1', 80, 24);
  });

  it('reattaches an existing terminal without requiring device-link metadata', async () => {
    vi.mocked(window.electronAPI.terminal.create).mockResolvedValueOnce({ shellId: 'sh', shellDisplayName: 'SSH', pid: 1 });
    const ctx = makeContext({ deviceLinkDeviceId: 'device-1' });
    render(<TerminalTabBody state={{ created: true, exited: null, title: '', shellId: '', shellDisplayName: '' }} ctx={ctx} active />);
    await act(async () => {});
    expect(entry.terminal.open).toHaveBeenCalled();
    expect(window.electronAPI.terminal.describeRemote).not.toHaveBeenCalled();
    expect(window.electronAPI.terminal.create).toHaveBeenCalledOnce();
  });

  it('does not overwrite an exit delivered before create resolves', async () => {
    let completeCreate!: (value: { shellId: 'sh'; shellDisplayName: string; pid: number }) => void;
    vi.mocked(window.electronAPI.terminal.create).mockImplementationOnce(() => new Promise((resolve) => { completeCreate = resolve; }));
    const ctx = makeContext({ deviceLinkDeviceId: 'device-1' });
    // Apply patches through React so an early created=true would cancel the
    // pending create effect, duplicate attachment, and lose its shell metadata.
    function Session() {
      const [state, setState] = useState({ created: false, exited: null as { code: number | null; signal: string | null } | null, title: '', shellId: '', shellDisplayName: '' });
      const patchState = useCallback((patch: unknown) => {
        ctx.patchState(patch);
        setState(previous => ({ ...previous, ...(patch as object) }));
      }, []);
      return <TerminalTabBody state={state} ctx={{ ...ctx, patchState }} active />;
    }
    render(<Session />);
    await waitFor(() => expect(window.electronAPI.terminal.create).toHaveBeenCalled());
    const onExit = vi.mocked(window.electronAPI.terminal.onExit).mock.calls[0][0];
    act(() => onExit({ id: 'terminal-1', exit: { code: 255, signal: null } }));
    expect(window.electronAPI.terminal.create).toHaveBeenCalledOnce();
    await act(async () => completeCreate({ shellId: 'sh', shellDisplayName: 'SSH', pid: 1 }));
    expect(vi.mocked(ctx.patchState).mock.calls).toEqual([
      [{ rendererInstanceId: TERMINAL_RENDERER_INSTANCE_ID, exited: { code: 255, signal: null } }],
      [{ rendererInstanceId: TERMINAL_RENDERER_INSTANCE_ID, created: true, shellId: 'sh', shellDisplayName: 'SSH' }],
    ]);
    expect(screen.getByText('rightSidebar.terminal.processExited')).toBeTruthy();
    expect(entry.ptyAttached).toBe(true);
    expect(window.electronAPI.terminal.create).toHaveBeenCalledOnce();
  });

  // PR8881 PRRT_kwDOTgdRUs602mMT: production edit callbacks and remounts must
  // retain the old PTY after rejected disposal. Existing coverage only tested
  // mounted success. Unit tier: deferred IPC, no real SSH or account state.
  it.each(['mounted', 'unmounted', 'remounted'] as const)('retains the old connection after edit disposal rejects while %s, then permits release retry', async (timing) => {
    const api = window.electronAPI.terminal;
    let registeredHost: string | undefined = 'old-host';
    let savedHost = 'old-host';
    const usedHosts: string[] = [];
    vi.mocked(api.create).mockImplementation(async ({ remote }) => {
      if (!registeredHost) {
        if (!remote?.ticket) throw new Error('[PRECONDITION_FAILED] prepare');
        registeredHost = savedHost;
      }
      usedHosts.push(registeredHost);
      vi.mocked(api.onExit).mock.calls.at(-1)![0]({ id: 'terminal-1', exit: { code: 255, signal: null } });
      return { shellId: 'sh', shellDisplayName: 'SSH', pid: 1 };
    });
    vi.mocked(api.describeRemote).mockImplementation(async ({ connection }) => {
      if (connection) savedHost = connection.host;
      return { context: { sessionId: 'session-1' }, target: { key: 'target', label: 'Host', cwd: '/remote' }, connection: { host: savedHost }, candidates: [], ticket: 'prepared-ticket' };
    });
    let rejectDispose!: (error: Error) => void;
    let finishDispose!: () => void;
    vi.mocked(api.dispose)
      .mockImplementationOnce(() => new Promise((_, reject) => { rejectDispose = reject; }))
      .mockImplementationOnce(() => new Promise(resolve => { finishDispose = () => { registeredHost = undefined; resolve(); }; }));
    const ctx = makeContext({ deviceLinkDeviceId: 'device-1' });
    const state = { created: true, exited: { code: 255, signal: null }, title: '', shellId: '', shellDisplayName: '' };
    let view = render(<TerminalTabBody state={state} ctx={ctx} active />);
    await act(async () => {});
    fireEvent.click(screen.getByText('rightSidebar.terminal.remote.editConnection'));
    if (timing !== 'mounted') view.unmount();
    if (timing === 'remounted') {
      view = render(<TerminalTabBody state={state} ctx={ctx} active />);
      await act(async () => {});
      expect(screen.queryByLabelText('rightSidebar.terminal.remote.host')).toBeNull();
    }
    await act(async () => { rejectDispose(new Error('[PERMISSION_DENIED] Temporary account boundary')); });
    if (timing !== 'unmounted') view.unmount();
    view = render(<TerminalTabBody state={state} ctx={ctx} active />);
    await act(async () => {});
    expect(screen.queryByLabelText('rightSidebar.terminal.remote.host')).toBeNull();
    expect(api.describeRemote).not.toHaveBeenCalled();
    expect(savedHost).toBe('old-host');
    expect(usedHosts.every(host => host === 'old-host')).toBe(true);
    fireEvent.click(screen.getByText('rightSidebar.terminal.remote.editConnection'));
    expect(api.dispose).toHaveBeenCalledTimes(2);
    expect(screen.queryByLabelText('rightSidebar.terminal.remote.host')).toBeNull();
    await act(async () => { finishDispose(); });
    fireEvent.change(await screen.findByLabelText('rightSidebar.terminal.remote.host'), { target: { value: 'new-host' } });
    fireEvent.click(screen.getByText('rightSidebar.terminal.remote.connect'));
    await act(async () => {});
    expect(savedHost).toBe('new-host');
    expect(usedHosts.at(-1)).toBe('new-host');
  });

  it.each(['unmounted', 'remounted', 'closing', 'disposed', 'replaced'] as const)('handles confirmed edit disposal after becoming %s', async (timing) => {
    const api = window.electronAPI.terminal;
    vi.mocked(api.create).mockResolvedValue({ shellId: 'sh', shellDisplayName: 'SSH', pid: 1 });
    let finishDispose!: () => void;
    vi.mocked(api.dispose).mockImplementationOnce(() => new Promise(resolve => { finishDispose = resolve; }));
    const ctx = makeContext({ deviceLinkDeviceId: 'device-1' });
    const state = { created: true, exited: { code: 255, signal: null }, title: '', shellId: '', shellDisplayName: '' };
    const view = render(<TerminalTabBody state={state} ctx={ctx} active />);
    await act(async () => {});
    fireEvent.click(screen.getByText('rightSidebar.terminal.remote.editConnection'));
    view.unmount();
    if (timing === 'closing') entry.closing = true;
    if (timing === 'disposed') vi.mocked(getXterm).mockReturnValue(undefined);
    if (timing === 'replaced') vi.mocked(getXterm).mockReturnValue({ ...entry } as unknown as NonNullable<ReturnType<typeof getXterm>>);
    const remounted = timing === 'remounted' ? render(<TerminalTabBody state={state} ctx={ctx} active />) : undefined;
    await act(async () => {});
    expect(screen.queryByLabelText('rightSidebar.terminal.remote.host')).toBeNull();
    vi.mocked(ctx.patchState).mockClear();
    await act(async () => { finishDispose(); });
    expect(ctx.patchState).not.toHaveBeenCalled();
    if (timing === 'closing' || timing === 'disposed' || timing === 'replaced') {
      expect(entry.remoteDraft).toBeUndefined();
      expect(api.describeRemote).not.toHaveBeenCalled();
    } else {
      remounted?.unmount();
      render(<TerminalTabBody state={state} ctx={ctx} active />);
      expect(await screen.findByLabelText('rightSidebar.terminal.remote.host')).toBeTruthy();
      expect(api.create).toHaveBeenCalledTimes(timing === 'remounted' ? 2 : 1);
    }
  });

  it('recovers on close rollback after edit disposal successfully releases the retained PTY', async () => {
    const api = window.electronAPI.terminal;
    vi.mocked(api.create).mockResolvedValueOnce({ shellId: 'sh', shellDisplayName: 'SSH', pid: 1 });
    let finishEdit!: () => void;
    let rejectClose!: (error: Error) => void;
    vi.mocked(api.dispose)
      .mockImplementationOnce(() => new Promise(resolve => { finishEdit = resolve; }))
      .mockImplementationOnce(() => new Promise((_, reject) => { rejectClose = reject; }));
    const ctx = makeContext({ deviceLinkDeviceId: 'device-1' });
    const state = { created: true, exited: { code: 255, signal: null }, title: '', shellId: '', shellDisplayName: '' };
    const view = render(<TerminalTabBody state={state} ctx={ctx} active />);
    await act(async () => {});
    fireEvent.click(screen.getByText('rightSidebar.terminal.remote.editConnection'));
    const closing = getTabKind('terminal')!.onBeforeClose!(state, { tabId: ctx.tabId, sessionId: ctx.sessionId });
    view.unmount();
    render(<TerminalTabBody state={state} ctx={ctx} active />);
    await act(async () => {});
    await act(async () => { finishEdit(); });
    expect(entry.ptyAttached).toBe(false);
    expect(entry.remoteDraft).toBeUndefined();
    expect(api.create).toHaveBeenCalledOnce();
    await act(async () => { rejectClose(new Error('close failed')); await closing; });
    expect(entry.closing).toBe(false);
    expect(api.create).toHaveBeenCalledTimes(2);
    expect(await screen.findByLabelText('rightSidebar.terminal.remote.host')).toBeTruthy();
  });

  it('disposes the exited PTY before editing and creating a new remote connection', async () => {
    vi.mocked(window.electronAPI.terminal.create).mockImplementationOnce(async () => {
      const onExit = vi.mocked(window.electronAPI.terminal.onExit).mock.calls.at(-1)![0];
      onExit({ id: 'terminal-1', exit: { code: 255, signal: null } });
      return { shellId: 'sh', shellDisplayName: 'SSH', pid: 1 };
    });
    let finishDispose!: () => void;
    vi.mocked(window.electronAPI.terminal.dispose).mockImplementationOnce(() => new Promise<void>((resolve) => { finishDispose = resolve; }));
    const ctx = makeContext({ deviceLinkDeviceId: 'device-1' });
    function Session() {
      const [state, setState] = useState({ created: true, exited: { code: 255, signal: null } as { code: number | null; signal: string | null } | null, title: '', shellId: '', shellDisplayName: '' });
      const patchState = useCallback((patch: unknown) => setState(previous => ({ ...previous, ...(patch as object) })), []);
      return <TerminalTabBody state={state} ctx={{ ...ctx, patchState }} active />;
    }
    render(<Session />);
    await act(async () => {});
    fireEvent.click(screen.getByText('rightSidebar.terminal.remote.editConnection'));
    expect(window.electronAPI.terminal.dispose).toHaveBeenCalledWith('terminal-1');
    expect(screen.queryByLabelText('rightSidebar.terminal.remote.host')).toBeNull();
    finishDispose();
    const host = await screen.findByLabelText('rightSidebar.terminal.remote.host');
    fireEvent.change(host, { target: { value: 'new-host' } });
    fireEvent.click(screen.getByText('rightSidebar.terminal.remote.connect'));
    await waitFor(() => expect(window.electronAPI.terminal.create).toHaveBeenCalledWith(expect.objectContaining({ remote: { sessionId: 'session-1', deviceId: 'device-1', ticket: 'prepared-ticket' } })));
    expect(vi.mocked(window.electronAPI.terminal.dispose).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(window.electronAPI.terminal.create).mock.invocationCallOrder[1]);
  });

  it('does not reuse a previous target or draft when the context changes', async () => {
    const describe = vi.mocked(window.electronAPI.terminal.describeRemote);
    describe.mockImplementation(async (context) => ({ context, target: { key: context.sessionId, label: 'Host', cwd: '/remote' }, connection: null, candidates: [] }));
    const state = { created: false, exited: null, title: '', shellId: '', shellDisplayName: '' };
    const ctx = makeContext({ deviceLinkDeviceId: 'device-1' });
    const view = render(<TerminalTabBody state={state} ctx={ctx} active />);
    fireEvent.change(await screen.findByLabelText('rightSidebar.terminal.remote.host'), { target: { value: 'old-host' } });
    view.rerender(<TerminalTabBody state={state} ctx={{ ...ctx, sessionId: 'session-2', remoteHostId: 'nested-2' }} active />);
    await waitFor(() => expect(describe).toHaveBeenCalledWith({ id: 'terminal-1', sessionId: 'session-2', deviceId: 'device-1' }));
    expect((await screen.findByLabelText('rightSidebar.terminal.remote.host') as HTMLInputElement).value).toBe('');
    expect(window.electronAPI.terminal.create).toHaveBeenCalledTimes(2);
  });
});
