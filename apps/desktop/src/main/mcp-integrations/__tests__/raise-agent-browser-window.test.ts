import { describe, expect, it, vi } from 'vitest';

import { raiseAgentBrowserWindow } from '../raise-agent-browser-window.js';
import type { BrowserControlRequest, BrowserControlResult } from '@cindy/browser-control-runtime';

function tabsResult(
  tabs: Array<{ targetId?: string; suggestedTargetId?: string }> | undefined,
): BrowserControlResult {
  return { ok: true, action: 'tabs', data: tabs === undefined ? {} : { tabs } };
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
        if (tabPolls < 3) return tabsResult([]);
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

  it('does not open about:blank when the tab list stays empty', async () => {
    const call = vi.fn(async (request: BrowserControlRequest): Promise<BrowserControlResult> => {
      if (request.action === 'tabs') return tabsResult([]);
      return { ok: true, action: request.action };
    });
    const sleep = vi.fn(async () => {});

    await raiseAgentBrowserWindow({ call }, { sleep });

    expect(call.mock.calls.every(([request]) => request.action === 'tabs')).toBe(true);
    expect(call).toHaveBeenCalledTimes(10);
    expect(sleep).toHaveBeenCalledTimes(9);
    expect(call.mock.calls.some(([request]) => request.action === 'open')).toBe(false);
    expect(call.mock.calls.some(([request]) => request.action === 'focus')).toBe(false);
  });
});
