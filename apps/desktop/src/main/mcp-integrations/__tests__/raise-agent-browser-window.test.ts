import { describe, expect, it, vi } from 'vitest';

import { raiseAgentBrowserWindow } from '../raise-agent-browser-window.js';
import type { BrowserControlRequest, BrowserControlResult } from '@cindy/browser-control-runtime';

function tabsResult(
  tabs: Array<{
    targetId?: string;
    suggestedTargetId?: string;
    type?: string;
    url?: string;
  }> | undefined,
  running = true,
): BrowserControlResult {
  return { ok: true, action: 'tabs', data: tabs === undefined ? { running } : { running, tabs } };
}

describe('raiseAgentBrowserWindow', () => {
  it('focuses the first tab and never opens another', async () => {
    const call = vi.fn(async (request: BrowserControlRequest): Promise<BrowserControlResult> => {
      if (request.action === 'tabs') {
        return tabsResult([{ targetId: 't1' }]);
      }
      return { ok: true, action: request.action };
    });
    const sleep = vi.fn(async () => {});

    await raiseAgentBrowserWindow({ call }, { sleep });

    expect(call.mock.calls.map(([request]) => request)).toEqual([
      { action: 'tabs' },
      { action: 'focus', targetId: 't1' },
    ]);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('prefers suggestedTargetId and waits until CDP reports a tab', async () => {
    const call = vi.fn(async (request: BrowserControlRequest): Promise<BrowserControlResult> => {
      if (request.action === 'tabs') {
        const tabPolls = call.mock.calls.filter(([req]) => req.action === 'tabs').length;
        if (tabPolls < 3) return tabsResult([], false);
        return tabsResult([{ targetId: 'ignored', suggestedTargetId: 'preferred' }]);
      }
      return { ok: true, action: request.action };
    });
    const sleep = vi.fn(async () => {});

    await raiseAgentBrowserWindow({ call }, { sleep });

    expect(call.mock.calls.map(([request]) => request)).toEqual([
      { action: 'tabs' },
      { action: 'tabs' },
      { action: 'tabs' },
      { action: 'focus', targetId: 'preferred' },
    ]);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('opens one foreground blank tab once a windowless browser is ready', async () => {
    const call = vi.fn(async (request: BrowserControlRequest): Promise<BrowserControlResult> => {
      if (request.action === 'tabs') return tabsResult([]);
      if (request.action === 'open') {
        return {
          ok: true,
          action: 'open',
          data: { targetId: 'opened', suggestedTargetId: 'preferred-opened' },
        };
      }
      return { ok: true, action: request.action };
    });
    const sleep = vi.fn(async () => {});

    await raiseAgentBrowserWindow({ call }, { sleep });

    expect(call.mock.calls.map(([request]) => request)).toEqual([
      { action: 'tabs' },
      { action: 'open', url: 'about:blank', background: false },
      { action: 'focus', targetId: 'preferred-opened' },
    ]);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('reports a foreground tab open failure to the login caller', async () => {
    const call = vi.fn(async (request: BrowserControlRequest): Promise<BrowserControlResult> => {
      if (request.action === 'tabs') return tabsResult([]);
      if (request.action === 'open') {
        return {
          ok: false,
          action: 'open',
          errorCode: 'BROWSER_RUNTIME_ACTION_FAILED',
          message: 'CDP create target failed',
        };
      }
      return { ok: true, action: request.action };
    });

    await expect(raiseAgentBrowserWindow({ call })).rejects.toThrow('CDP create target failed');
    expect(call.mock.calls.map(([request]) => request)).toEqual([
      { action: 'tabs' },
      { action: 'open', url: 'about:blank', background: false },
    ]);
  });

  it('reports a malformed foreground tab response without claiming success', async () => {
    const call = vi.fn(async (request: BrowserControlRequest): Promise<BrowserControlResult> => {
      if (request.action === 'tabs') return tabsResult([]);
      return { ok: true, action: request.action, data: {} };
    });

    await expect(raiseAgentBrowserWindow({ call })).rejects.toThrow(
      'Agent browser login tab opened without a target ID',
    );
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('does not open a tab before CDP reports the browser ready', async () => {
    const call = vi.fn(async (request: BrowserControlRequest): Promise<BrowserControlResult> => {
      if (request.action === 'tabs') return tabsResult([], false);
      return { ok: true, action: request.action };
    });
    const sleep = vi.fn(async () => {});

    await raiseAgentBrowserWindow({ call }, { sleep });

    expect(call.mock.calls.every(([request]) => request.action === 'tabs')).toBe(true);
    expect(call).toHaveBeenCalledTimes(10);
    expect(sleep).toHaveBeenCalledTimes(9);
  });

  it('focuses the page tab and skips an extension service worker listed first', async () => {
    // The managed browser starts with --no-startup-window, so a fresh tab list
    // is often led by an extension's service worker. Focusing it succeeds but
    // raises no window, which is what made the login button look dead.
    const call = vi.fn(async (request: BrowserControlRequest): Promise<BrowserControlResult> => {
      if (request.action === 'tabs') {
        return tabsResult([
          { targetId: 'sw', type: 'service_worker', url: 'chrome-extension://abc/x-background.js' },
          { targetId: 'page-1', suggestedTargetId: 't2', type: 'page', url: 'https://example.com' },
        ]);
      }
      return { ok: true, action: request.action };
    });
    const sleep = vi.fn(async () => {});

    await raiseAgentBrowserWindow({ call }, { sleep });

    expect(call.mock.calls.map(([request]) => request)).toEqual([
      { action: 'tabs' },
      { action: 'focus', targetId: 't2' },
    ]);
  });

  it('opens a foreground tab when the list holds only background targets', async () => {
    const call = vi.fn(async (request: BrowserControlRequest): Promise<BrowserControlResult> => {
      if (request.action === 'tabs') {
        return tabsResult([
          { targetId: 'sw', type: 'service_worker', url: 'chrome-extension://abc/x-background.js' },
        ]);
      }
      if (request.action === 'open') {
        return {
          ok: true,
          action: 'open',
          data: { targetId: 'opened', suggestedTargetId: 't3', type: 'page' },
        };
      }
      return { ok: true, action: request.action };
    });
    const sleep = vi.fn(async () => {});

    await raiseAgentBrowserWindow({ call }, { sleep });

    expect(call.mock.calls.map(([request]) => request)).toEqual([
      { action: 'tabs' },
      { action: 'open', url: 'about:blank', background: false },
      { action: 'focus', targetId: 't3' },
    ]);
  });

  it('reports a failed focus instead of claiming the window was raised', async () => {
    const call = vi.fn(async (request: BrowserControlRequest): Promise<BrowserControlResult> => {
      if (request.action === 'tabs') {
        return tabsResult([{ targetId: 'page-1', type: 'page', url: 'https://example.com' }]);
      }
      return {
        ok: false,
        action: request.action,
        errorCode: 'BROWSER_RUNTIME_ACTION_FAILED',
        message: 'focus failed',
      };
    });

    await expect(raiseAgentBrowserWindow({ call })).rejects.toThrow('focus failed');
  });
});
