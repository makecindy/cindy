// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';

import { disposeXterm, getOrCreateXterm, openTerminalExternalLink } from '../xtermPool';
import { finishClosing, markClosing } from '../../../../lib/tabClosingSignal';

const { warn } = vi.hoisted(() => ({
  warn: vi.fn(),
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ warn }),
}));

it('marks a real xterm entry registered after closing begins and clears it after rollback', () => {
  markClosing('late-terminal');
  try {
    const entry = getOrCreateXterm('late-terminal');
    expect(entry.closing).toBe(true);
    // PR8881 / unit: the real pool must notify only after all pending closes
    // roll back. The former boolean-only check missed stranded preparation.
    const resumed = vi.fn(() => { expect(entry.closing).toBe(false); });
    entry.closeCancelledListeners.add(resumed);
    markClosing('late-terminal');
    finishClosing('late-terminal');
    expect(resumed).not.toHaveBeenCalled();
    finishClosing('late-terminal');
    expect(entry.closing).toBe(false);
    expect(resumed).toHaveBeenCalledOnce();
    markClosing('late-terminal');
    disposeXterm('late-terminal');
    finishClosing('late-terminal');
    expect(resumed).toHaveBeenCalledOnce();
    expect(entry.closeCancelledListeners.size).toBe(0);
  } finally {
    finishClosing('late-terminal');
    disposeXterm('late-terminal');
  }
});

describe('openTerminalExternalLink', () => {
  afterEach(() => {
    vi.clearAllMocks();
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
