import { describe, expect, it, vi } from 'vitest';

import type { RsbBrowserBridgeTabOpResult } from '../../../shared/rsbBrowserBridge';
import { requestTabOrigin, VIEW_RECT_TIMEOUT_MS, type TabOriginDeps } from '../guestOrigin';
import type { RendererBridgeOptions } from '../renderer-bridge';

function setup(
  answer: RsbBrowserBridgeTabOpResult | Error = {
    reqId: 'r',
    ok: true,
    rect: { left: 770, top: 86, width: 510, height: 800 },
  },
) {
  const host = { isDestroyed: vi.fn(() => false) };
  const guest = { isDestroyed: vi.fn(() => false) };
  const getHostWebContents = vi.fn(() => host as never);
  const options: RendererBridgeOptions = { getHostWebContents, logger: { warn: vi.fn() } };
  const dispatch = vi.fn(async () => {
    if (answer instanceof Error) throw answer;
    return answer;
  });
  const deps: TabOriginDeps = {
    options: () => options,
    guest: () => guest as never,
    dispatch,
  };
  return { deps, host, guest, dispatch, getHostWebContents, options };
}
const tab = { sessionId: 'task1', tabId: 'tab1' };

describe('requestTabOrigin', () => {
  it('asks the tab host for the webview box and returns it as is (host CSS px, no zoom factor)', async () => {
    const h = setup();
    expect(await requestTabOrigin(tab, h.deps)).toEqual({
      x: 770,
      y: 86,
      width: 510,
      height: 800,
    });
    expect(h.dispatch).toHaveBeenCalledWith(
      { op: 'viewRect', sessionId: 'task1', tabId: 'tab1' },
      expect.objectContaining({ timeoutMs: VIEW_RECT_TIMEOUT_MS }),
      undefined,
      { ensureHost: false },
    );
    // The host is chosen per tab (a popped-out tab lives in its own window).
    expect(h.getHostWebContents).toHaveBeenCalledWith({
      op: 'viewRect',
      sessionId: 'task1',
      tabId: 'tab1',
    });
  });

  it('passes on that the renderer cannot hit-test the webview (keep-alive layer)', async () => {
    const h = setup({
      reqId: 'r',
      ok: true,
      rect: { left: 0, top: 0, width: 510, height: 800, pointerBlocked: true },
    });
    expect(await requestTabOrigin(tab, h.deps)).toEqual({
      x: 0,
      y: 0,
      width: 510,
      height: 800,
      hitBlocked: true,
    });
  });

  it.each([
    [
      'the renderer says the tab is not there',
      { reqId: 'r', ok: false, error: 'tab tab1 not found' },
    ],
    ['it answers without a box', { reqId: 'r', ok: true }],
    [
      'the box is not finite',
      { reqId: 'r', ok: true, rect: { left: Number.NaN, top: 0, width: 5, height: 5 } },
    ],
    ['the box is empty', { reqId: 'r', ok: true, rect: { left: 0, top: 0, width: 0, height: 5 } }],
    [
      'the box is absurd',
      { reqId: 'r', ok: true, rect: { left: 1e9, top: 0, width: 5, height: 5 } },
    ],
    ['the round trip fails', new Error('tab-op timed out')],
  ] as Array<[string, RsbBrowserBridgeTabOpResult | Error]>)(
    'gives no origin when %s',
    async (_name, answer) => {
      expect(await requestTabOrigin(tab, setup(answer).deps)).toBeNull();
    },
  );

  it('gives no origin without a registered bridge, a live host or a live guest', async () => {
    const h = setup();
    expect(await requestTabOrigin(tab, { ...h.deps, options: () => null })).toBeNull();
    h.host.isDestroyed.mockReturnValue(true);
    expect(await requestTabOrigin(tab, h.deps)).toBeNull();
    expect(h.dispatch).not.toHaveBeenCalled();
    const gone = setup();
    expect(await requestTabOrigin(tab, { ...gone.deps, guest: () => null })).toBeNull();
    const closing = setup();
    closing.dispatch.mockImplementation(async () => {
      closing.guest.isDestroyed.mockReturnValue(true);
      return { reqId: 'r', ok: true, rect: { left: 1, top: 1, width: 5, height: 5 } };
    });
    expect(await requestTabOrigin(tab, closing.deps)).toBeNull();
  });
});
