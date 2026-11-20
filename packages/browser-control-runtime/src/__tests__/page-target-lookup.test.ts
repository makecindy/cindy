import { afterEach, describe, expect, it, vi } from 'vitest';

// Regression (2026-11-14): reading two Tailscale docs pages at once, one a 308 to the other, hung the
// browser tool for good. Chrome left `Target.attachToTarget` unanswered for the redirecting tab, and
// every page lookup probes every tab, so the lookup for either tab never returned. Only the
// Playwright connection is faked: the lookup, its per-tab probe and its fallbacks are production code.
const fake = vi.hoisted(() => ({ connectOverCDP: vi.fn() }));
vi.mock('../_generated/extension/src/browser/playwright-core.runtime.js', () => ({
  playwrightCore: { chromium: { connectOverCDP: fake.connectOverCDP } },
}));
vi.mock('../_generated/extension/src/browser/chrome.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getChromeWebSocketUrl: async () => null,
}));

import { getPageForTargetId } from '../_generated/extension/src/browser/pw-session.js';

type Session = { send: (method: string) => Promise<unknown>; detach: () => Promise<void> };

function browserWith(tabs: Array<{ url: string; attach: () => Promise<Session> }>) {
  const noop = () => {};
  const context = { pages: () => pages, on: noop, newCDPSession: (page: { attach: () => Promise<Session> }) => page.attach() };
  const pages = tabs.map((tab) => ({ ...tab, url: () => tab.url, on: noop, once: noop, off: noop, isClosed: () => false, context: () => context }));
  return { browser: { contexts: () => [context], on: noop, isConnected: () => true }, pages };
}

const answering = (targetId: string) => async (): Promise<Session> => ({
  send: async () => ({ targetInfo: { targetId } }),
  detach: async () => {},
});

afterEach(() => {
  vi.useRealTimers();
});

describe('page lookup by target id', () => {
  it('finds a tab while another tab never answers the attach, and detaches that session when it arrives late', async () => {
    vi.useFakeTimers();
    const late: Array<(session: Session) => void> = [];
    const lateDetach = vi.fn(async () => {});
    const { browser, pages } = browserWith([
      { url: 'https://example.test/old', attach: () => new Promise<Session>((resolve) => { late.push(resolve); }) },
      { url: 'https://example.test/new', attach: answering('TARGET-B') },
    ]);
    fake.connectOverCDP.mockResolvedValue(browser);

    const lookup = getPageForTargetId({ cdpUrl: 'http://127.0.0.1:18800', targetId: 'TARGET-B' });
    await vi.advanceTimersByTimeAsync(20_000);
    await expect(lookup).resolves.toBe(pages[1]);

    expect(late.length).toBeGreaterThan(0);
    for (const resolve of late) resolve({ send: async () => ({ targetInfo: { targetId: 'TARGET-A' } }), detach: lateDetach });
    await vi.advanceTimersByTimeAsync(0);
    expect(lateDetach).toHaveBeenCalledTimes(late.length);
  });
});
