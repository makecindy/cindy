// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';

import { openTerminalExternalLink, getXtermExit, setXtermExit, onXtermExit, restartXterm, attachXterm, detachXterm, getOrCreateXterm, suspendExitedXterm, disposeXterm, __resetPoolForTesting } from '../xtermPool';

const { warn } = vi.hoisted(() => ({
  warn: vi.fn(),
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ warn }),
}));

describe('openTerminalExternalLink', () => {
  afterEach(() => {
    __resetPoolForTesting();
    vi.clearAllMocks();
  });

  // Unit: #9815 discussion_r4528556652. Native restart removes the old PTY
  // before spawning; a failed spawn must permit a later explicit retry to create it.
  it('recreates a missing PTY on retry after destructive restart failure, retaining output', async () => {
    const params = { id: 'missing', cwd: '/workspace', cols: 100, rows: 30 };
    const result = { shellId: 'zsh' as const, shellDisplayName: 'zsh', pid: 42 };
    const restart = vi.fn()
      .mockRejectedValueOnce(new Error('[TERMINAL_SPAWN_FAILED] restart failed: unavailable cwd'))
      .mockRejectedValueOnce(new Error('[TERMINAL_NOT_FOUND] pty session not found: missing'));
    const create = vi.fn().mockResolvedValue(result);
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: { terminal: { restart, create } } });
    const entry = getOrCreateXterm(params.id);
    entry.ptyAttached = true;
    entry.terminal.write('retained before failed restart 中文');
    setXtermExit(params.id, { code: 0, signal: null });
    await expect(restartXterm(params)).rejects.toThrow('TERMINAL_SPAWN_FAILED');
    expect(entry.ptyAttached).toBe(false);
    expect(create).not.toHaveBeenCalled();
    expect(await restartXterm(params)).toEqual(result);
    expect(create).toHaveBeenCalledExactlyOnceWith(params);
    expect(entry.ptyAttached).toBe(true);
    expect(getXtermExit(params.id)).toBeNull();
    await new Promise<void>(done => entry.terminal.write('', done));
    expect(entry.terminal.buffer.active.getLine(0)?.translateToString(true)).toBe('retained before failed restart 中文');
  });

  it('does not recreate a missing PTY after its tab was closed during restart', async () => {
    const params = { id: 'closed-restart', cwd: '/workspace' };
    let reject!: (error: Error) => void;
    const create = vi.fn();
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: { terminal: {
      restart: () => new Promise((_yes, no) => { reject = no; }), create,
    } } });
    getOrCreateXterm(params.id);
    const pending = restartXterm(params);
    disposeXterm(params.id);
    reject(new Error('[TERMINAL_NOT_FOUND] pty session not found: closed-restart'));
    await expect(pending).rejects.toThrow('TERMINAL_NOT_FOUND');
    expect(create).not.toHaveBeenCalled();
    expect(getXtermExit(params.id)).toBeNull();
  });

  // Unit: #9815 discussion_r4528102349. The old exit must not release a
  // restarted shell whose IPC reply is still pending after the tab unmounts.
  it.each([
    ['restart', 'success'], ['restart', 'failure'],
    ['attach', 'success'], ['attach', 'failure'],
  ] as const)('retains detached events while %s is pending (%s)', async (operation, outcome) => {
    let data!: (event: unknown) => void;
    let exit!: (event: unknown) => void;
    let resolve!: (value: { shellId: 'zsh'; shellDisplayName: string; pid: number }) => void;
    let reject!: (reason: Error) => void;
    const pending = new Promise<{ shellId: 'zsh'; shellDisplayName: string; pid: number }>((yes, no) => { resolve = yes; reject = no; });
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: { terminal: {
      restart: vi.fn(() => pending),
      create: vi.fn(() => pending),
      onData: (listener: typeof data) => { data = listener; return vi.fn(); },
      onExit: (listener: typeof exit) => { exit = listener; return vi.fn(); },
    } } });
    const entry = getOrCreateXterm('restarting');
    const disposed = vi.spyOn(entry.terminal, 'dispose');
    const oldExit = { code: 0, signal: null };
    setXtermExit('restarting', oldExit);
    const restarted = operation === 'restart' ? restartXterm({ id: 'restarting', cwd: '/workspace' }) : attachXterm({ id: 'restarting', cwd: '/workspace' });
    detachXterm('restarting');
    expect(disposed).not.toHaveBeenCalled();
    // A replacement body subscribes while the old native request is pending.
    const notifyReplacement = vi.fn();
    const offReplacement = onXtermExit('restarting', notifyReplacement);
    if (outcome === 'success') {
      data({ id: 'restarting', chunk: 'output before restart reply 中文\r\n' });
      exit({ id: 'restarting', exit: { code: 7, signal: null } });
      resolve({ shellId: 'zsh', shellDisplayName: 'zsh', pid: 42 });
      await restarted;
      expect(getXtermExit('restarting')).toEqual({ code: 7, signal: null });
      expect(notifyReplacement).toHaveBeenCalledWith({ code: 7, signal: null });
    } else {
      reject(new Error('spawn failed'));
      await expect(restarted).rejects.toThrow('spawn failed');
      expect(getXtermExit('restarting')).toEqual(oldExit);
      expect(notifyReplacement).toHaveBeenCalledWith(oldExit);
    }
    offReplacement();
    await vi.waitFor(() => expect(disposed).toHaveBeenCalledOnce());
    const restored = getOrCreateXterm('restarting');
    await new Promise<void>(done => restored.terminal.write('', done));
    if (outcome === 'success') expect(restored.terminal.buffer.active.getLine(0)?.translateToString(true)).toBe('output before restart reply 中文');
  });

  // Unit: exited tabs previously retained the full xterm buffer. Exercise the
  // real parser and serializer, including pending writes and ANSI restoration.
  it('releases an exited view after draining output and restores its colored history', async () => {
    const before = getOrCreateXterm('history');
    before.terminal.resize(80, 24);
    before.ptyAttached = true;
    before.terminal.write('\u001b[32mRetained output 中文😀\u001b[0m\r\nlast line');
    expect(await suspendExitedXterm('history')).toBe(true);
    const restored = getOrCreateXterm('history');
    await new Promise<void>(resolve => restored.terminal.write('', resolve));
    expect(restored.terminal).not.toBe(before.terminal);
    expect(restored.ptyAttached).toBe(true);
    expect(restored.terminal.buffer.active.getLine(0)?.translateToString(true)).toBe('Retained output 中文😀');
    expect(restored.terminal.buffer.active.getLine(0)?.getCell(0)?.getFgColor()).toBe(2);
    expect(restored.terminal.buffer.active.getLine(1)?.translateToString(true)).toBe('last line');
    await suspendExitedXterm('history');
    disposeXterm('history');
    const cleared = getOrCreateXterm('history');
    expect(cleared.terminal.buffer.active.getLine(0)?.translateToString(true)).not.toContain('Retained');
  });

  it('cancels pending suspension when the tab is opened again', async () => {
    const entry = getOrCreateXterm('race');
    const pending = suspendExitedXterm('race');
    expect(getOrCreateXterm('race')).toBe(entry);
    expect(await pending).toBe(false);
    expect(getOrCreateXterm('race')).toBe(entry);
  });

  // Unit: switching tasks unmounts TabBody; the old component-only subscriptions
  // lost final output/exit. Send the smallest native data + exit after detaching.
  it('captures output and exit while unmounted, releases the view, then restores history', async () => {
    let data!: (event: unknown) => void;
    let exit!: (event: unknown) => void;
    const offData = vi.fn();
    const offExit = vi.fn();
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: { terminal: {
      onData: (listener: typeof data) => { data = listener; return offData; },
      onExit: (listener: typeof exit) => { exit = listener; return offExit; },
    } } });
    const entry = getOrCreateXterm('background');
    const disposed = vi.spyOn(entry.terminal, 'dispose');
    detachXterm('background');
    data({ id: 'background', chunk: 'last background output 中文\r\n' });
    exit({ id: 'background', exit: { code: 7, signal: null } });
    await vi.waitFor(() => expect(disposed).toHaveBeenCalledOnce());
    const restored = getOrCreateXterm('background');
    await new Promise<void>(resolve => restored.terminal.write('', resolve));
    expect(restored).not.toBe(entry);
    expect(restored.terminal.buffer.active.getLine(0)?.translateToString(true)).toBe('last background output 中文');
    expect(getXtermExit('background')).toEqual({ code: 7, signal: null });
    expect(offData).toHaveBeenCalledOnce();
    expect(offExit).toHaveBeenCalledOnce();
    disposeXterm('background');
    expect(getXtermExit('background')).toBeNull();
  });

  it('settles a pending suspension when a tab is closed', async () => {
    getOrCreateXterm('closing');
    const pending = suspendExitedXterm('closing');
    disposeXterm('closing');
    expect(await pending).toBe(false);
    expect(getOrCreateXterm('closing').terminal.buffer.active.getLine(0)?.translateToString(true)).toBe('');
  });

  it('routes detected URLs through the host external-link bridge', async () => {
    const openExternal = vi.fn().mockResolvedValue({ success: true });
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { openExternal },
    });

    const event = new MouseEvent('click');
    const url = 'https://git.example.com/project/-/merge_requests/42';

    openTerminalExternalLink(event, url);

    expect(openExternal).toHaveBeenCalledOnce();
    expect(openExternal).toHaveBeenCalledWith(url);
    await vi.waitFor(() => expect(warn).not.toHaveBeenCalled());
  });

  it('logs when the host rejects or cannot open the URL', async () => {
    const openExternal = vi.fn().mockResolvedValue({ success: false });
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { openExternal },
    });

    openTerminalExternalLink(new MouseEvent('click'), 'https://example.com/rejected');

    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledWith('terminal link open rejected or failed');
    });
  });

  it('logs when the external-link IPC call fails', async () => {
    const openExternal = vi.fn().mockRejectedValue(new Error('IPC unavailable'));
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { openExternal },
    });

    openTerminalExternalLink(new MouseEvent('click'), 'https://example.com/ipc-error');

    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledWith('terminal link open IPC failed');
    });
  });
});
