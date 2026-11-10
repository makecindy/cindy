// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';

import { openTerminalExternalLink, getXtermExit, detachXterm, getOrCreateXterm, suspendExitedXterm, disposeXterm, __resetPoolForTesting } from '../xtermPool';

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
