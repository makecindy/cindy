// RsbWebviewBackend dispatch matrix:
//  - status / start / stop / profiles / doctor return shape-stable ok results
//  - tabs reads from TabRegistry + safeTabMeta on each WebContents
//  - open / focus / close round-trip through dispatchTabOp (renderer bridge)
//  - navigate / screenshot / pdf go straight to the guest WebContents
//  - snapshot / non-evaluate act actions use the bounded CDP automation helper
//  - advanced unsupported actions yield a structured error (no throw)

import fs from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebContents } from 'electron';

import type { TabRegistry, TabRecord } from '../../../rsb-browser-bridge/registry.js';
import type {
  RsbBrowserBridgeTabOp,
  RsbBrowserBridgeTabOpResult,
} from '../../../../shared/rsbBrowserBridge.js';
import * as rendererBridge from '../../../rsb-browser-bridge/renderer-bridge.js';
import { RsbWebviewBackend } from '../rsb-webview-backend.js';

// Build a minimal fake TabRegistry — we only call a handful of methods.
// pinHistory captures the pin/unpin call order so tests can assert that a
// tab-scoped action wraps its body in pin → … → unpin, regardless of success
// or failure of the body.
interface FakeRegistry extends TabRegistry {
  pinHistory: Array<{ op: 'pin' | 'unpin'; tabId: string }>;
  activePinLeases: Set<symbol>;
}

function fakeRegistry(rows: TabRecord[], wcMap: Map<string, WebContents>): FakeRegistry {
  const pinHistory: Array<{ op: 'pin' | 'unpin'; tabId: string }> = [];
  const activePinLeases = new Set<symbol>();
  const reg = {
    listAll: () => rows.slice(),
    listBySession: (sid: string) => rows.filter((r) => r.sessionId === sid),
    getWebContentsByTabId: (tabId: string) => wcMap.get(tabId) ?? null,
    listPinned: () => (activePinLeases.size > 0 ? ['t1'] : []),
    isPinned: () => activePinLeases.size > 0,
    pin: (tabId: string) => {
      pinHistory.push({ op: 'pin', tabId });
      return true;
    },
    unpin: (tabId: string) => {
      pinHistory.push({ op: 'unpin', tabId });
      return true;
    },
    acquirePinLease: (tabId: string) => {
      const token = Symbol(tabId);
      activePinLeases.add(token);
      pinHistory.push({ op: 'pin', tabId });
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        activePinLeases.delete(token);
        pinHistory.push({ op: 'unpin', tabId });
      };
    },
    pinHistory,
    activePinLeases,
  };
  return reg as unknown as FakeRegistry;
}

function fakeWc(opts?: { url?: string; title?: string }): WebContents & {
  loadURLMock: ReturnType<typeof vi.fn>;
  capturePageMock: ReturnType<typeof vi.fn>;
  printToPDFMock: ReturnType<typeof vi.fn>;
  consoleListeners: Array<(...args: unknown[]) => void>;
} {
  const wc = {
    getURL: () => opts?.url ?? 'https://example.com',
    getTitle: () => opts?.title ?? 'Example',
    isDestroyed: () => false,
    loadURL: vi.fn(async () => undefined),
    capturePage: vi.fn(async () => ({ toPNG: () => Buffer.from('PNGDATA') })),
    printToPDF: vi.fn(async () => Buffer.from('PDFDATA')),
    on: vi.fn(),
    consoleListeners: [] as Array<(...args: unknown[]) => void>,
  };
  wc.on.mockImplementation((event: string, fn: (...args: unknown[]) => void) => {
    if (event === 'console-message') wc.consoleListeners.push(fn);
  });
  // Expose mocks on the cast object so tests can assert on them.
  const result = wc as unknown as WebContents & {
    loadURLMock: typeof wc.loadURL;
    capturePageMock: typeof wc.capturePage;
    printToPDFMock: typeof wc.printToPDF;
    consoleListeners: typeof wc.consoleListeners;
  };
  // The mock vi.fn references go through; alias them for readability.
  Object.assign(result, {
    loadURLMock: wc.loadURL,
    capturePageMock: wc.capturePage,
    printToPDFMock: wc.printToPDF,
  });
  return result;
}

function logger() {
  return { info: vi.fn(), warn: vi.fn() };
}

const dispatchTabOpSpy = vi.spyOn(rendererBridge, 'dispatchTabOp');

beforeEach(() => {
  dispatchTabOpSpy.mockReset();
});

afterEach(() => {
  dispatchTabOpSpy.mockReset();
});

describe('RsbWebviewBackend — diagnostic actions', () => {
  it('health probe performs a no-side-effect renderer bridge round trip', async () => {
    dispatchTabOpSpy.mockResolvedValueOnce({ reqId: 'probe-1', ok: true });
    const backend = new RsbWebviewBackend({
      registry: fakeRegistry([], new Map()),
      getActiveSessionId: () => null,
      bridge: { getHostWebContents: () => null, logger: logger() },
      logger: logger(),
    });

    await expect(backend.probeControl()).resolves.toBeUndefined();
    expect(dispatchTabOpSpy).toHaveBeenCalledWith(
      { op: 'probe' },
      expect.any(Object),
      expect.any(Function),
      { ensureHost: false },
    );
  });

  it('manual recovery probe verifies the configured host startup path', async () => {
    dispatchTabOpSpy.mockResolvedValueOnce({ reqId: 'probe-2', ok: true });
    const backend = new RsbWebviewBackend({
      registry: fakeRegistry([], new Map()),
      getActiveSessionId: () => null,
      bridge: { getHostWebContents: () => null, logger: logger() },
      logger: logger(),
    });

    await expect(backend.probeControl({ ensureHost: true })).resolves.toBeUndefined();
    expect(dispatchTabOpSpy).toHaveBeenCalledWith(
      { op: 'probe' },
      expect.any(Object),
      expect.any(Function),
      { ensureHost: true },
    );
  });

  it('status returns ready + tab count for active session', async () => {
    const wc = fakeWc();
    const registry = fakeRegistry(
      [{ sessionId: 's1', tabId: 't1', webContentsId: 101 }],
      new Map([['t1', wc]]),
    );
    const backend = new RsbWebviewBackend({
      registry,
      getActiveSessionId: () => 's1',
      bridge: {
        getHostWebContents: () => null,
        logger: logger(),
      },
      logger: logger(),
    });

    const res = await backend.call({ action: 'status' });

    expect(res.ok).toBe(true);
    expect(res.data).toMatchObject({ backend: 'rsb-webview', sessionId: 's1', tabCount: 1 });
  });

  it('start / stop are no-op success', async () => {
    const backend = new RsbWebviewBackend({
      registry: fakeRegistry([], new Map()),
      getActiveSessionId: () => 's1',
      bridge: { getHostWebContents: () => null, logger: logger() },
      logger: logger(),
    });
    expect((await backend.call({ action: 'start' })).ok).toBe(true);
    expect((await backend.call({ action: 'stop' })).ok).toBe(true);
  });

  it('profiles returns a single RSB profile', async () => {
    const backend = new RsbWebviewBackend({
      registry: fakeRegistry([], new Map()),
      getActiveSessionId: () => 's1',
      bridge: { getHostWebContents: () => null, logger: logger() },
      logger: logger(),
    });
    const res = await backend.call({ action: 'profiles' });
    const data = res.data as { profiles: Array<{ name: string }> };
    expect(data.profiles).toHaveLength(1);
    expect(data.profiles[0].name).toBe('rsb');
  });

  it('doctor returns registry overview', async () => {
    const wc = fakeWc();
    const registry = fakeRegistry(
      [{ sessionId: 's1', tabId: 't1', webContentsId: 101 }],
      new Map([['t1', wc]]),
    );
    const backend = new RsbWebviewBackend({
      registry,
      getActiveSessionId: () => 's1',
      bridge: { getHostWebContents: () => null, logger: logger() },
      logger: logger(),
    });
    const res = await backend.call({ action: 'doctor' });
    expect(res.data).toMatchObject({
      backend: 'rsb-webview',
      ok: true,
      activeSessionId: 's1',
      totalRegisteredTabs: 1,
    });
  });
});

describe('RsbWebviewBackend — tabs', () => {
  it('lists tabs for the active session with url / title from WebContents', async () => {
    const wc = fakeWc({ url: 'https://anthropic.com', title: 'Anthropic' });
    const registry = fakeRegistry(
      [{ sessionId: 's1', tabId: 't1', webContentsId: 101 }],
      new Map([['t1', wc]]),
    );
    const backend = new RsbWebviewBackend({
      registry,
      getActiveSessionId: () => 's1',
      bridge: { getHostWebContents: () => null, logger: logger() },
      logger: logger(),
    });
    const res = await backend.call({ action: 'tabs' });
    const data = res.data as { tabs: Array<{ targetId: string; url: string; title: string }> };
    expect(data.tabs).toEqual([
      expect.objectContaining({
        targetId: 't1',
        tabId: 't1',
        url: 'https://anthropic.com',
        title: 'Anthropic',
      }),
    ]);
  });

  it('returns error when no active session', async () => {
    const backend = new RsbWebviewBackend({
      registry: fakeRegistry([], new Map()),
      getActiveSessionId: () => null,
      bridge: { getHostWebContents: () => null, logger: logger() },
      logger: logger(),
    });
    const res = await backend.call({ action: 'tabs' });
    expect(res.ok).toBe(false);
    expect(res.message).toBe('no active RSB session');
  });

  it('falls back to empty url/title when WebContents getURL/getTitle throw', async () => {
    const wc = {
      getURL: () => {
        throw new Error('not attached');
      },
      getTitle: () => {
        throw new Error('not attached');
      },
      isDestroyed: () => false,
    } as unknown as WebContents;
    const registry = fakeRegistry(
      [{ sessionId: 's1', tabId: 't1', webContentsId: 101 }],
      new Map([['t1', wc]]),
    );
    const backend = new RsbWebviewBackend({
      registry,
      getActiveSessionId: () => 's1',
      bridge: { getHostWebContents: () => null, logger: logger() },
      logger: logger(),
    });
    const res = await backend.call({ action: 'tabs' });
    const data = res.data as { tabs: Array<{ url: string; title: string }> };
    expect(data.tabs[0]).toEqual(expect.objectContaining({ url: '', title: '' }));
  });
});

describe('RsbWebviewBackend — open / focus / close (renderer bridge)', () => {
  it('open dispatches an open op and returns the new tabId', async () => {
    dispatchTabOpSpy.mockResolvedValueOnce({
      reqId: 'x',
      ok: true,
      tabId: 't-new',
    } as RsbBrowserBridgeTabOpResult);
    const backend = new RsbWebviewBackend({
      registry: fakeRegistry([], new Map()),
      getActiveSessionId: () => 's1',
      bridge: { getHostWebContents: () => null, logger: logger() },
      logger: logger(),
    });

    const res = await backend.call({
      action: 'open',
      url: 'https://example.com',
    } as never);

    expect(dispatchTabOpSpy).toHaveBeenCalledWith(
      { op: 'open', sessionId: 's1', url: 'https://example.com' } satisfies RsbBrowserBridgeTabOp,
      expect.any(Object),
      expect.any(Function),
    );
    expect(res.ok).toBe(true);
    expect(res.data).toEqual({ targetId: 't-new', tabId: 't-new' });
  });

  it('focus rejects when no targetId is provided', async () => {
    const backend = new RsbWebviewBackend({
      registry: fakeRegistry([], new Map()),
      getActiveSessionId: () => 's1',
      bridge: { getHostWebContents: () => null, logger: logger() },
      logger: logger(),
    });
    const res = await backend.call({ action: 'focus' } as never);
    expect(res.ok).toBe(false);
    expect(res.message).toBe('targetId required');
  });

  it('focus error from renderer propagates as actionFailed', async () => {
    dispatchTabOpSpy.mockResolvedValueOnce({
      reqId: 'x',
      ok: false,
      error: 'tab x not found',
    });
    const backend = new RsbWebviewBackend({
      registry: fakeRegistry([], new Map()),
      getActiveSessionId: () => 's1',
      bridge: { getHostWebContents: () => null, logger: logger() },
      logger: logger(),
    });
    const res = await backend.call({ action: 'focus', targetId: 't-x' } as never);
    expect(res.ok).toBe(false);
    expect(res.message).toBe('tab x not found');
  });

  it('close round-trips through the bridge', async () => {
    dispatchTabOpSpy.mockResolvedValueOnce({ reqId: 'x', ok: true, tabId: 't1' });
    const backend = new RsbWebviewBackend({
      registry: fakeRegistry([], new Map()),
      getActiveSessionId: () => 's1',
      bridge: { getHostWebContents: () => null, logger: logger() },
      logger: logger(),
    });
    const res = await backend.call({ action: 'close', targetId: 't1' } as never);
    expect(dispatchTabOpSpy).toHaveBeenCalledWith(
      { op: 'close', sessionId: 's1', tabId: 't1' } satisfies RsbBrowserBridgeTabOp,
      expect.any(Object),
      expect.any(Function),
    );
    expect(res.ok).toBe(true);
  });
});

describe('RsbWebviewBackend — direct WebContents actions', () => {
  it('navigate calls wc.loadURL', async () => {
    const wc = fakeWc();
    const registry = fakeRegistry(
      [{ sessionId: 's1', tabId: 't1', webContentsId: 101 }],
      new Map([['t1', wc]]),
    );
    const backend = new RsbWebviewBackend({
      registry,
      getActiveSessionId: () => 's1',
      bridge: { getHostWebContents: () => null, logger: logger() },
      logger: logger(),
    });

    const res = await backend.call({
      action: 'navigate',
      targetId: 't1',
      url: 'https://destination.test',
    } as never);

    expect(wc.loadURLMock).toHaveBeenCalledWith('https://destination.test');
    expect(res.ok).toBe(true);
  });

  it('navigate fails clearly when targetId missing', async () => {
    const backend = new RsbWebviewBackend({
      registry: fakeRegistry([], new Map()),
      getActiveSessionId: () => 's1',
      bridge: { getHostWebContents: () => null, logger: logger() },
      logger: logger(),
    });
    const res = await backend.call({ action: 'navigate', url: 'x' } as never);
    expect(res.ok).toBe(false);
    expect(res.message).toBe('targetId required');
  });

  it('navigate fails when tab unknown', async () => {
    const backend = new RsbWebviewBackend({
      registry: fakeRegistry([], new Map()),
      getActiveSessionId: () => 's1',
      bridge: { getHostWebContents: () => null, logger: logger() },
      logger: logger(),
    });
    const res = await backend.call({
      action: 'navigate',
      targetId: 't-ghost',
      url: 'x',
    } as never);
    expect(res.ok).toBe(false);
    // resolveTabInActiveSession returns "not in active session" for a tabId
    // that doesn't appear in the registry for the active session.
    expect(res.message).toMatch(/t-ghost not in active session s1/);
  });

  it('screenshot returns base64-encoded PNG', async () => {
    const wc = fakeWc();
    const registry = fakeRegistry(
      [{ sessionId: 's1', tabId: 't1', webContentsId: 101 }],
      new Map([['t1', wc]]),
    );
    const backend = new RsbWebviewBackend({
      registry,
      getActiveSessionId: () => 's1',
      bridge: { getHostWebContents: () => null, logger: logger() },
      logger: logger(),
    });
    const res = await backend.call({ action: 'screenshot', targetId: 't1' } as never);
    expect(wc.capturePageMock).toHaveBeenCalledTimes(1);
    expect(res.data).toMatchObject({
      mimeType: 'image/png',
      data: Buffer.from('PNGDATA').toString('base64'),
    });
  });

  it('pdf returns base64-encoded PDF', async () => {
    const wc = fakeWc();
    const registry = fakeRegistry(
      [{ sessionId: 's1', tabId: 't1', webContentsId: 101 }],
      new Map([['t1', wc]]),
    );
    const backend = new RsbWebviewBackend({
      registry,
      getActiveSessionId: () => 's1',
      bridge: { getHostWebContents: () => null, logger: logger() },
      logger: logger(),
    });
    const res = await backend.call({ action: 'pdf', targetId: 't1' } as never);
    expect(wc.printToPDFMock).toHaveBeenCalledTimes(1);
    expect(res.data).toMatchObject({
      mimeType: 'application/pdf',
      data: Buffer.from('PDFDATA').toString('base64'),
    });
  });
});

describe('RsbWebviewBackend — act:evaluate', () => {
  function buildEvalEnv(initialReturn: unknown) {
    let attached = false;
    const sendCommand = vi.fn(async (
      method: string,
      params?: Record<string, unknown>,
    ): Promise<unknown> => {
      void params;
      if (method === 'Runtime.evaluate' || method === 'Runtime.callFunctionOn') {
        return { result: { value: initialReturn } };
      }
      return {};
    });
    const wc = {
      getURL: () => '',
      getTitle: () => '',
      isDestroyed: () => false,
      executeJavaScript: vi.fn(async () => initialReturn),
      debugger: {
        isAttached: vi.fn(() => attached),
        attach: vi.fn(() => {
          attached = true;
        }),
        detach: vi.fn(() => {
          attached = false;
        }),
        sendCommand,
      },
    } as unknown as Electron.WebContents & {
      executeJavaScript: ReturnType<typeof vi.fn>;
      debugger: { sendCommand: ReturnType<typeof vi.fn> };
    };
    const registry = fakeRegistry(
      [{ sessionId: 's1', tabId: 't1', webContentsId: 101 }],
      new Map([['t1', wc]]),
    );
    const backend = new RsbWebviewBackend({
      registry,
      getActiveSessionId: () => 's1',
      bridge: { getHostWebContents: () => null, logger: logger() },
      logger: logger(),
    });
    return { backend, wc, sendCommand };
  }

  it('runs the fn in the guest and returns its result + as variable name', async () => {
    const { backend, sendCommand } = buildEvalEnv({ posts: [1, 2, 3] });
    const res = await backend.call({
      action: 'act',
      targetId: 't1',
      request: {
        kind: 'evaluate',
        as: 'posts',
        fn: '() => ({ posts: [1, 2, 3] })',
      },
    } as never);
    // The wrapper mirrors the vendored runtime's evaluator: eval("(" + JSON.stringified-fn + ")")
    // → call it → wrap in Promise.resolve. The injected fn text is a JS string
    // LITERAL, so multi-statement payloads can't escape the IIFE.
    expect(sendCommand).toHaveBeenCalledWith('Runtime.evaluate', expect.anything());
    const callArg = sendCommand.mock.calls.find(([method]) => method === 'Runtime.evaluate')?.[1]
      ?.expression as string;
    expect(callArg).toContain('eval("(" + "() => ({ posts: [1, 2, 3] })" + ")")');
    expect(callArg).toContain('evaluate source did not produce a function');
    expect(res.ok).toBe(true);
    expect(res.data).toMatchObject({
      tabId: 't1',
      kind: 'evaluate',
      as: 'posts',
      result: { posts: [1, 2, 3] },
    });
  });

  it('escapes embedded quotes/backslashes in fn so multi-stmt payload cannot escape IIFE', async () => {
    const { backend, sendCommand } = buildEvalEnv(null);
    // Adversarial payload: try to close the string + run a second statement.
    const adversarial = '() => {}; window.__pwned = 1; (() => null';
    await backend.call({
      action: 'act',
      targetId: 't1',
      request: { kind: 'evaluate', fn: adversarial },
    } as never);
    const callArg = sendCommand.mock.calls.find(([method]) => method === 'Runtime.evaluate')?.[1]
      ?.expression as string;
    // The whole payload is a JSON.stringified literal — `"` inside got escaped,
    // and the literal sits inside `eval("(" + LITERAL + ")")` so any "statement
    // separator" the attacker tries (a quote + `;`) stays inside the literal.
    expect(callArg).toContain(JSON.stringify(adversarial));
    // Sanity: the wrapper itself doesn't accidentally include a raw window
    // reference outside the literal (which would be a successful escape).
    expect(callArg.indexOf('window.__pwned')).toBeGreaterThan(callArg.indexOf(JSON.stringify(adversarial).slice(0, 10)));
  });

  it('non-evaluate act kinds route to the CDP automation helper', async () => {
    const { backend, wc } = buildEvalEnv(null);
    wc.executeJavaScript.mockResolvedValue({ ok: true });
    const sendCommand = vi.fn(async () => {
      return {};
    });
    Object.assign(wc, {
      debugger: {
        isAttached: vi.fn(() => true),
        attach: vi.fn(),
        detach: vi.fn(),
        sendCommand,
        on: vi.fn(),
        removeListener: vi.fn(),
      },
    });
    const res = await backend.call({
      action: 'act',
      targetId: 't1',
      request: { kind: 'clickCoords', x: 10, y: 20 },
    } as never);
    expect(res.ok).toBe(true);
    expect(sendCommand).not.toHaveBeenCalledWith(
      'Input.dispatchMouseEvent',
      expect.anything(),
    );
    expect(wc.executeJavaScript).toHaveBeenCalledTimes(2);
    expect(wc.executeJavaScript.mock.calls[0][0]).toContain(
      '"method":"Input.dispatchMouseEvent","params":{"type":"mousePressed","x":10,"y":20',
    );
  });

  it('executeJavaScript throw propagates as actionFailed', async () => {
    const { backend, sendCommand } = buildEvalEnv(null);
    sendCommand.mockResolvedValueOnce({
      exceptionDetails: { exception: { description: 'SyntaxError' } },
    } as never);
    const res = await backend.call({
      action: 'act',
      targetId: 't1',
      request: { kind: 'evaluate', fn: '() => bad syntax' },
    } as never);
    expect(res.ok).toBe(false);
    expect(res.message).toBe('SyntaxError');
  });
});

describe('RsbWebviewBackend — snapshot automation', () => {
  it('returns refs from the active tab and pins for the complete CDP action', async () => {
    const wc = fakeWc();
    let attached = false;
    Object.assign(wc, {
      debugger: {
        isAttached: vi.fn(() => attached),
        attach: vi.fn(() => {
          attached = true;
        }),
        detach: vi.fn(() => {
          attached = false;
        }),
        sendCommand: vi.fn(async (method: string) => {
          if (method === 'Accessibility.enable') return {};
          if (method === 'Accessibility.getFullAXTree') {
            return {
              nodes: [
                {
                  nodeId: 'button',
                  role: { value: 'button' },
                  name: { value: 'Continue' },
                  backendDOMNodeId: 7,
                  childIds: [],
                },
              ],
            };
          }
          throw new Error(`unexpected command: ${method}`);
        }),
      },
    });
    const registry = fakeRegistry(
      [{ sessionId: 's1', tabId: 't1', webContentsId: 101 }],
      new Map([['t1', wc]]),
    );
    const backend = new RsbWebviewBackend({
      registry,
      getActiveSessionId: () => 's1',
      bridge: { getHostWebContents: () => null, logger: logger() },
      logger: logger(),
    });

    const res = await backend.call({
      action: 'snapshot',
      targetId: 't1',
      interactive: true,
    });

    expect(res.ok).toBe(true);
    expect(res.data).toMatchObject({
      targetId: 't1',
      snapshot: '- button "Continue" [ref=e1]',
      refs: {
        e1: { role: 'button', name: 'Continue', backendDOMNodeId: 7 },
      },
    });
    expect(registry.pinHistory).toEqual([
      { op: 'pin', tabId: 't1' },
      { op: 'unpin', tabId: 't1' },
    ]);
  });
});

describe('RsbWebviewBackend — cross-session isolation (P2-1)', () => {
  // Reproduces the race: agent holds a tabId from session A. User switches to
  // session B. Without `resolveTabInActiveSession` the backend would happily
  // operate session A's tab while UI is on B. Guard refuses the action.

  it('navigate refuses a tabId that does not belong to the active session', async () => {
    const wc = fakeWc();
    // Tab belongs to session A.
    const registry = fakeRegistry(
      [{ sessionId: 'A', tabId: 't1', webContentsId: 101 }],
      new Map([['t1', wc]]),
    );
    const backend = new RsbWebviewBackend({
      registry,
      // But the user has switched focus to B.
      getActiveSessionId: () => 'B',
      bridge: { getHostWebContents: () => null, logger: logger() },
      logger: logger(),
    });

    const res = await backend.call({
      action: 'navigate',
      targetId: 't1',
      url: 'https://x.test',
    } as never);

    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/not in active session B/);
    expect(wc.loadURLMock).not.toHaveBeenCalled();
  });

  it('screenshot refuses cross-session tab', async () => {
    const wc = fakeWc();
    const registry = fakeRegistry(
      [{ sessionId: 'A', tabId: 't1', webContentsId: 101 }],
      new Map([['t1', wc]]),
    );
    const backend = new RsbWebviewBackend({
      registry,
      getActiveSessionId: () => 'B',
      bridge: { getHostWebContents: () => null, logger: logger() },
      logger: logger(),
    });

    const res = await backend.call({ action: 'screenshot', targetId: 't1' } as never);
    expect(res.ok).toBe(false);
    expect(wc.capturePageMock).not.toHaveBeenCalled();
  });

  it('act:evaluate refuses cross-session tab', async () => {
    const wc = {
      getURL: () => '',
      getTitle: () => '',
      isDestroyed: () => false,
      executeJavaScript: vi.fn(),
    } as unknown as Electron.WebContents;
    const registry = fakeRegistry(
      [{ sessionId: 'A', tabId: 't1', webContentsId: 101 }],
      new Map([['t1', wc]]),
    );
    const backend = new RsbWebviewBackend({
      registry,
      getActiveSessionId: () => 'B',
      bridge: { getHostWebContents: () => null, logger: logger() },
      logger: logger(),
    });

    const res = await backend.call({
      action: 'act',
      targetId: 't1',
      request: { kind: 'evaluate', fn: '() => 1' },
    } as never);

    expect(res.ok).toBe(false);
    expect(wc.executeJavaScript).not.toHaveBeenCalled();
  });

  it('navigate refuses when no active session at all', async () => {
    const wc = fakeWc();
    const registry = fakeRegistry(
      [{ sessionId: 'A', tabId: 't1', webContentsId: 101 }],
      new Map([['t1', wc]]),
    );
    const backend = new RsbWebviewBackend({
      registry,
      getActiveSessionId: () => null,
      bridge: { getHostWebContents: () => null, logger: logger() },
      logger: logger(),
    });
    const res = await backend.call({
      action: 'navigate',
      targetId: 't1',
      url: 'x',
    } as never);
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/no active RSB session/);
  });
});

describe('RsbWebviewBackend — per-action automation pin', () => {
  // Verifies the lifecycle policy: each tab-scoped action pins the tab on
  // entry, unpins on exit (success OR failure). Between actions the tab is
  // bare — normal LRU / user-close rules apply, surfacing clear errors on the
  // next call if the tab is gone.

  function buildBackend(wc: WebContents, disposeGraceMs?: number) {
    const registry = fakeRegistry(
      [{ sessionId: 's1', tabId: 't1', webContentsId: 101 }],
      new Map([['t1', wc]]),
    );
    return {
      backend: new RsbWebviewBackend({
        registry,
        getActiveSessionId: () => 's1',
        bridge: { getHostWebContents: () => null, logger: logger() },
        logger: logger(),
        ...(disposeGraceMs === undefined ? {} : { disposeGraceMs }),
      }),
      registry,
    };
  }

  it('navigate pins before wc.loadURL and unpins after', async () => {
    const wc = fakeWc();
    const { backend, registry } = buildBackend(wc);
    await backend.call({
      action: 'navigate',
      targetId: 't1',
      url: 'https://x.test',
    } as never);
    expect(registry.pinHistory).toEqual([
      { op: 'pin', tabId: 't1' },
      { op: 'unpin', tabId: 't1' },
    ]);
  });

  it.each([
    { label: 'request timeout', timeoutMs: 25, elapsedMs: 25 },
    { label: 'bounded default', timeoutMs: undefined, elapsedMs: 60_000 },
  ])(
    'navigate uses the $label and stops a stalled load',
    async ({ timeoutMs, elapsedMs }) => {
      vi.useFakeTimers();
      let finishLoad = () => {};
      const wc = fakeWc();
      wc.loadURLMock.mockImplementationOnce(
        () => new Promise<void>((resolve) => {
          finishLoad = resolve;
        }),
      );
      const stop = vi.fn();
      Object.assign(wc, { stop });
      const { backend, registry } = buildBackend(wc);

      try {
        const navigating = backend.call({
          action: 'navigate',
          targetId: 't1',
          url: 'https://stalled.test',
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
        } as never);
        await vi.advanceTimersByTimeAsync(elapsedMs);
        const result = await navigating;
        await backend.dispose();

        expect(result.ok).toBe(false);
        expect(result.message).toBe(`navigation timed out after ${elapsedMs}ms`);
        expect(stop).toHaveBeenCalledTimes(1);
        expect(registry.pinHistory).toEqual([
          { op: 'pin', tabId: 't1' },
          { op: 'unpin', tabId: 't1' },
        ]);
      } finally {
        finishLoad();
        vi.useRealTimers();
      }
    },
  );

  it('bounds disposal of a stalled call and returns an actionable retry error', async () => {
    vi.useFakeTimers();
    let finishLoad = () => {};
    const wc = fakeWc();
    wc.loadURLMock.mockImplementationOnce(
      () => new Promise<void>((resolve) => {
        finishLoad = resolve;
      }),
    );
    const { backend } = buildBackend(wc, 25);

    try {
      const navigating = backend.call({
        action: 'navigate',
        targetId: 't1',
        url: 'https://stalled.test',
      } as never);
      const disposing = backend.dispose();
      const statusWhileDisposing = await backend.call({ action: 'status' });

      await vi.advanceTimersByTimeAsync(25);
      await disposing;

      expect(statusWhileDisposing).toMatchObject({
        ok: false,
        errorCode: 'BROWSER_RUNTIME_UNAVAILABLE',
      });
      expect(statusWhileDisposing.message).toMatch(/retry shortly/i);

      finishLoad();
      await navigating;
    } finally {
      finishLoad();
      vi.useRealTimers();
    }
  });

  it('does not let a late old-generation finally release the replacement pin', async () => {
    let finishOld = () => {};
    let finishReplacement = () => {};
    const wc = fakeWc();
    wc.capturePageMock
      .mockImplementationOnce(
        () => new Promise<{ toPNG(): Buffer }>((resolve) => {
          finishOld = () => resolve({ toPNG: () => Buffer.from('OLD') });
        }),
      )
      .mockImplementationOnce(
        () => new Promise<{ toPNG(): Buffer }>((resolve) => {
          finishReplacement = () => resolve({ toPNG: () => Buffer.from('NEW') });
        }),
      );
    const registry = fakeRegistry(
      [{ sessionId: 's1', tabId: 't1', webContentsId: 101 }],
      new Map([['t1', wc]]),
    );
    const createBackend = () => new RsbWebviewBackend({
      registry,
      getActiveSessionId: () => 's1',
      bridge: { getHostWebContents: () => null, logger: logger() },
      logger: logger(),
      disposeGraceMs: 0,
    });
    const oldGeneration = createBackend();
    const replacement = createBackend();

    const oldCall = oldGeneration.call({
      action: 'screenshot',
      targetId: 't1',
    } as never);
    await vi.waitFor(() => expect(registry.activePinLeases.size).toBe(1));
    await oldGeneration.dispose();
    expect(registry.activePinLeases.size).toBe(0);

    const replacementCall = replacement.call({
      action: 'screenshot',
      targetId: 't1',
    } as never);
    await vi.waitFor(() => expect(registry.activePinLeases.size).toBe(1));

    finishOld();
    await oldCall;
    expect(registry.activePinLeases.size).toBe(1);

    finishReplacement();
    await replacementCall;
    expect(registry.activePinLeases.size).toBe(0);
  });

  it('does not start a WebContents action after a delayed host wait outlives disposal', async () => {
    vi.useFakeTimers();
    let finishEnsureHost: (() => void) | undefined;
    const ensureHost = vi.fn(
      () => new Promise<void>((resolve) => {
        finishEnsureHost = resolve;
      }),
    );
    const wc = fakeWc();
    const registry = fakeRegistry(
      [{ sessionId: 's1', tabId: 't1', webContentsId: 101 }],
      new Map([['t1', wc]]),
    );
    const backend = new RsbWebviewBackend({
      registry,
      getActiveSessionId: () => 's1',
      bridge: { getHostWebContents: () => null, ensureHost, logger: logger() },
      logger: logger(),
      disposeGraceMs: 0,
    });

    try {
      const navigating = backend.call({
        action: 'navigate',
        targetId: 't1',
        url: 'https://late.test',
      } as never);
      await vi.waitFor(() => expect(ensureHost).toHaveBeenCalledOnce());
      const disposing = backend.dispose();
      await vi.advanceTimersByTimeAsync(0);
      await disposing;

      finishEnsureHost?.();
      await expect(navigating).resolves.toMatchObject({
        ok: false,
        errorCode: 'BROWSER_RUNTIME_UNAVAILABLE',
      });
      expect(wc.loadURLMock).not.toHaveBeenCalled();
    } finally {
      finishEnsureHost?.();
      vi.useRealTimers();
    }
  });

  it('unpins even when wc operation throws (action failure path)', async () => {
    const wc = {
      getURL: () => '',
      getTitle: () => '',
      isDestroyed: () => false,
      loadURL: vi.fn().mockRejectedValueOnce(new Error('net::ERR')),
    } as unknown as WebContents;
    const { backend, registry } = buildBackend(wc);
    const res = await backend.call({
      action: 'navigate',
      targetId: 't1',
      url: 'x',
    } as never);
    expect(res.ok).toBe(false);
    expect(registry.pinHistory).toEqual([
      { op: 'pin', tabId: 't1' },
      { op: 'unpin', tabId: 't1' },
    ]);
  });

  it('screenshot / pdf / console / act:evaluate all wrap with pin', async () => {
    const wc = fakeWc();
    // Make executeJavaScript available too — handleAct uses it.
    (wc as unknown as { executeJavaScript: ReturnType<typeof vi.fn> }).executeJavaScript = vi.fn(
      async () => 'result',
    );

    const { backend, registry } = buildBackend(wc);

    await backend.call({ action: 'screenshot', targetId: 't1' } as never);
    await backend.call({ action: 'pdf', targetId: 't1' } as never);
    await backend.call({ action: 'console', targetId: 't1' } as never);
    await backend.call({
      action: 'act',
      targetId: 't1',
      request: { kind: 'evaluate', fn: '() => 1' },
    } as never);

    // 4 actions × (pin, unpin) = 8 entries, all on t1, all paired.
    expect(registry.pinHistory).toHaveLength(8);
    for (let i = 0; i < registry.pinHistory.length; i += 2) {
      expect(registry.pinHistory[i]).toEqual({ op: 'pin', tabId: 't1' });
      expect(registry.pinHistory[i + 1]).toEqual({ op: 'unpin', tabId: 't1' });
    }
  });

  it('rejects conflicting top-level and nested act targets', async () => {
    const wc = fakeWc();
    const { backend, registry } = buildBackend(wc);

    const result = await backend.call({
      action: 'act',
      targetId: 't1',
      request: {
        kind: 'click',
        targetId: 't2',
        selector: '#submit',
      },
    } as never);

    expect(result).toMatchObject({
      ok: false,
      message: expect.stringContaining('targetId mismatch'),
    });
    expect(registry.pinHistory).toEqual([]);
  });

  it('non-tab-scoped actions (tabs / status / profiles / doctor) do not touch pin', async () => {
    const wc = fakeWc();
    const { backend, registry } = buildBackend(wc);

    await backend.call({ action: 'tabs' } as never);
    await backend.call({ action: 'status' } as never);
    await backend.call({ action: 'profiles' } as never);
    await backend.call({ action: 'doctor' } as never);

    expect(registry.pinHistory).toEqual([]);
  });

  it('cross-session-rejected action does NOT pin (gate fires first)', async () => {
    const wc = fakeWc();
    const registry = fakeRegistry(
      // Tab is in session A
      [{ sessionId: 'A', tabId: 't1', webContentsId: 101 }],
      new Map([['t1', wc]]),
    );
    const backend = new RsbWebviewBackend({
      registry,
      // But active session is B — resolveTabInActiveSession refuses.
      getActiveSessionId: () => 'B',
      bridge: { getHostWebContents: () => null, logger: logger() },
      logger: logger(),
    });
    const res = await backend.call({
      action: 'navigate',
      targetId: 't1',
      url: 'x',
    } as never);
    expect(res.ok).toBe(false);
    expect(registry.pinHistory).toEqual([]);
  });
});

describe('RsbWebviewBackend — MCP session id injection', () => {
  // The @cindy/mcps `cindy_browser` provider injects `__mcpSessionId` on every
  // request so the backend operates against the AGENT'S session, not the
  // UI's current focus. This is the fix for: user submits a prompt in
  // session A → switches to B → agent (running in A) calls backend → backend
  // would otherwise read "UI focus = B" and corrupt B's bucket.

  it('uses __mcpSessionId from req when present, IGNORES getActiveSessionId', async () => {
    const wc = fakeWc();
    // Tab belongs to session "agent-A"
    const registry = fakeRegistry(
      [{ sessionId: 'agent-A', tabId: 't1', webContentsId: 101 }],
      new Map([['t1', wc]]),
    );
    const backend = new RsbWebviewBackend({
      registry,
      // UI focus claims session B — backend MUST IGNORE this since req carries
      // the authoritative agent session.
      getActiveSessionId: () => 'ui-focus-B',
      bridge: { getHostWebContents: () => null, logger: logger() },
      logger: logger(),
    });

    const res = await backend.call({
      action: 'navigate',
      targetId: 't1',
      url: 'https://x.test',
      __mcpSessionId: 'agent-A',
    } as never);

    // The action MUST succeed — tab is in agent-A and req carries agent-A.
    // If backend had used getActiveSessionId (ui-focus-B), this would fail
    // with "tab not in active session ui-focus-B".
    expect(res.ok).toBe(true);
    expect(wc.loadURLMock).toHaveBeenCalled();
  });

  it('falls back to getActiveSessionId only when __mcpSessionId is absent', async () => {
    const wc = fakeWc();
    const registry = fakeRegistry(
      [{ sessionId: 'ui-focus', tabId: 't1', webContentsId: 101 }],
      new Map([['t1', wc]]),
    );
    const backend = new RsbWebviewBackend({
      registry,
      getActiveSessionId: () => 'ui-focus',
      bridge: { getHostWebContents: () => null, logger: logger() },
      logger: logger(),
    });

    // No __mcpSessionId → fallback to UI focus.
    const res = await backend.call({
      action: 'navigate',
      targetId: 't1',
      url: 'https://x.test',
    } as never);
    expect(res.ok).toBe(true);
  });

  it('status returns the MCP-injected session id (not UI focus) for diagnostics', async () => {
    const registry = fakeRegistry(
      [{ sessionId: 'agent-A', tabId: 't1', webContentsId: 101 }],
      new Map([['t1', fakeWc()]]),
    );
    const backend = new RsbWebviewBackend({
      registry,
      getActiveSessionId: () => 'ui-focus-B',
      bridge: { getHostWebContents: () => null, logger: logger() },
      logger: logger(),
    });

    const res = await backend.call({
      action: 'status',
      __mcpSessionId: 'agent-A',
    } as never);

    expect(res.data).toMatchObject({
      sessionId: 'agent-A',
      // tabCount reflects agent-A's bucket (1 tab), not ui-focus-B's (0)
      tabCount: 1,
    });
  });

  it('targetless direct actions select a tab from the MCP-injected session', async () => {
    const agentWc = fakeWc();
    const uiWc = fakeWc();
    const registry = fakeRegistry(
      [
        { sessionId: 'agent-A', tabId: 'agent-tab', webContentsId: 101 },
        { sessionId: 'ui-focus-B', tabId: 'ui-tab', webContentsId: 102 },
      ],
      new Map([
        ['agent-tab', agentWc],
        ['ui-tab', uiWc],
      ]),
    );
    const backend = new RsbWebviewBackend({
      registry,
      getActiveSessionId: () => 'ui-focus-B',
      bridge: { getHostWebContents: () => null, logger: logger() },
      logger: logger(),
    });

    const res = await backend.call({
      action: 'navigate',
      url: 'https://agent.example',
      __mcpSessionId: 'agent-A',
    } as never);

    expect(res.ok).toBe(true);
    expect(agentWc.loadURLMock).toHaveBeenCalledWith('https://agent.example');
    expect(uiWc.loadURLMock).not.toHaveBeenCalled();
  });

  it('empty / non-string __mcpSessionId falls back to getActiveSessionId', async () => {
    const wc = fakeWc();
    const registry = fakeRegistry(
      [{ sessionId: 'ui-focus', tabId: 't1', webContentsId: 101 }],
      new Map([['t1', wc]]),
    );
    const backend = new RsbWebviewBackend({
      registry,
      getActiveSessionId: () => 'ui-focus',
      bridge: { getHostWebContents: () => null, logger: logger() },
      logger: logger(),
    });

    // Empty string — defense against malformed injection.
    const res1 = await backend.call({
      action: 'navigate',
      targetId: 't1',
      url: 'x',
      __mcpSessionId: '',
    } as never);
    expect(res1.ok).toBe(true);

    // Wrong type — same defense.
    const res2 = await backend.call({
      action: 'navigate',
      targetId: 't1',
      url: 'x',
      __mcpSessionId: 42,
    } as never);
    expect(res2.ok).toBe(true);
  });
});

describe('RsbWebviewBackend — uploads and page dialogs', () => {
  function buildPageEnv(options?: {
    uploadRoot?: string;
    resourceUrl?: string;
    humanVerification?: boolean;
    onDialogHandled?: () => void;
    pageEnableError?: Error;
  }) {
    let attached = false;
    const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
    const sessionListeners = new Map<string, Set<(...args: unknown[]) => void>>();
    const sendCommand = vi.fn(async (method: string) => {
      if (method === 'Network.enable') return {};
      if (method === 'Page.enable') {
        if (options?.pageEnableError) throw options.pageEnableError;
        return {};
      }
      if (method === 'Accessibility.enable') return {};
      if (method === 'Accessibility.getFullAXTree') return { nodes: [] };
      if (method === 'Runtime.evaluate') {
        if (options?.humanVerification) {
          return {
            result: {
              value: {
                resources: [],
                barrier: {
                  kind: 'human-verification',
                  evidence: ['page contains a verification control'],
                },
              },
            },
          };
        }
        return options?.resourceUrl
          ? {
              result: {
                value: {
                  resources: [{ kind: 'download', url: options.resourceUrl }],
                },
              },
            }
          : { result: { objectId: 'file-input' } };
      }
      if (method === 'DOM.describeNode') return { node: { backendNodeId: 11 } };
      if (method === 'Runtime.callFunctionOn') {
        return { result: { value: { ok: true, multiple: true } } };
      }
      if (method === 'DOM.setFileInputFiles') return {};
      if (method === 'Page.handleJavaScriptDialog') {
        options?.onDialogHandled?.();
        return {};
      }
      throw new Error(`unexpected command: ${method}`);
    });
    const wc = fakeWc();
    const session = {
      on: (event: string, listener: (...args: unknown[]) => void) => {
        const group = sessionListeners.get(event) ?? new Set();
        group.add(listener);
        sessionListeners.set(event, group);
      },
      removeListener: (event: string, listener: (...args: unknown[]) => void) => {
        sessionListeners.get(event)?.delete(listener);
      },
    };
    const downloadURL = vi.fn((url: string) => {
      let doneListener: ((...args: unknown[]) => void) | undefined;
      const item = {
        getFilename: () => 'page-resource.bin',
        getURL: () => url,
        getMimeType: () => 'application/octet-stream',
        getTotalBytes: () => 4,
        getReceivedBytes: () => 4,
        setSavePath: (filePath: string) => writeFileSync(filePath, 'data'),
        cancel: vi.fn(),
        on: vi.fn(),
        once: (event: string, listener: (...args: unknown[]) => void) => {
          if (event === 'done') doneListener = listener;
        },
      };
      for (const listener of sessionListeners.get('will-download') ?? []) {
        listener({}, item, wc);
      }
      setTimeout(() => doneListener?.({}, 'completed'), 0);
    });
    Object.assign(wc, {
      once: vi.fn(),
      session,
      downloadURL,
      debugger: {
        isAttached: () => attached,
        attach: vi.fn(() => {
          attached = true;
        }),
        detach: vi.fn(() => {
          attached = false;
        }),
        sendCommand,
        on: (event: string, listener: (...args: unknown[]) => void) => {
          const group = listeners.get(event) ?? new Set();
          group.add(listener);
          listeners.set(event, group);
        },
        removeListener: (event: string, listener: (...args: unknown[]) => void) => {
          listeners.get(event)?.delete(listener);
        },
      },
    });
    const registry = fakeRegistry(
      [{ sessionId: 's1', tabId: 't1', webContentsId: 101 }],
      new Map([['t1', wc]]),
    );
    const backendLogger = logger();
    const backend = new RsbWebviewBackend({
      registry,
      getActiveSessionId: () => 's1',
      artifactRoot: options?.uploadRoot ? () => options.uploadRoot! : undefined,
      artifactDownloadGraceMs: 0,
      resolveUploadRoots: options?.uploadRoot
        ? async () => [options.uploadRoot!]
        : undefined,
      bridge: { getHostWebContents: () => null, logger: logger() },
      logger: backendLogger,
    });
    const emit = (method: string, params: Record<string, unknown>) => {
      for (const listener of listeners.get('message') ?? []) {
        listener({}, method, params);
      }
    };
    return { backend, emit, sendCommand, downloadURL, wc, backendLogger, registry };
  }

  it('validates upload paths before assigning files to the page input', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-browser-backend-upload-'));
    try {
      const file = path.join(root, 'notes.txt');
      await fs.writeFile(file, 'notes');
      const env = buildPageEnv({ uploadRoot: root });

      const res = await env.backend.call({
        action: 'upload',
        targetId: 't1',
        paths: [file],
        query: { label: 'Attachments' },
      });

      expect(res.ok).toBe(true);
      expect(res.data).toMatchObject({ tabId: 't1', uploadedFiles: 1 });
      expect(env.sendCommand).toHaveBeenCalledWith('DOM.setFileInputFiles', {
        files: [await fs.realpath(file)],
        objectId: 'file-input',
      });
      await env.backend.dispose();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('returns a dialog barrier from snapshot and handles the exact pending dialog', async () => {
    const env = buildPageEnv();
    await env.backend.call({ action: 'snapshot', targetId: 't1' });
    env.emit('Page.javascriptDialogOpening', {
      type: 'confirm',
      message: 'Delete this item?',
    });

    const snapshot = await env.backend.call({ action: 'snapshot', targetId: 't1' });
    expect(snapshot.ok).toBe(true);
    expect(snapshot.data).toMatchObject({
      targetId: 't1',
      barrier: {
        kind: 'page-dialog',
        dialog: { type: 'confirm', message: 'Delete this item?' },
      },
    });
    const dialogId = (snapshot.data as {
      barrier: { dialog: { id: string } };
    }).barrier.dialog.id;

    const handled = await env.backend.call({
      action: 'dialog',
      targetId: 't1',
      dialogId,
      accept: false,
    });
    expect(handled.ok).toBe(true);
    expect(env.sendCommand).toHaveBeenCalledWith(
      'Page.handleJavaScriptDialog',
      { accept: false },
    );
    await env.backend.dispose();
  });

  it('returns a dialog barrier when a page action is blocked by the dialog', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-browser-dialog-action-'));
    let finishAction = () => {};
    const env = buildPageEnv({
      uploadRoot: root,
      onDialogHandled: () => finishAction(),
    });
    const automation = (env.backend as unknown as {
      automation: {
        act: (
          tabId: string,
          wc: WebContents,
          request: Record<string, unknown>,
        ) => Promise<Record<string, unknown>>;
      };
    }).automation;
    const actionFinished = vi.fn();
    const actSpy = vi.spyOn(automation, 'act').mockImplementation(
      () => new Promise((resolve) => {
        finishAction = () => {
          actionFinished();
          resolve({ tabId: 't1', kind: 'click' });
        };
      }),
    );

    try {
      const action = env.backend.call({
        action: 'act',
        targetId: 't1',
        request: { kind: 'click', targetId: 't1', ref: 'button-1' },
      });
      await vi.waitFor(() => expect(actSpy).toHaveBeenCalledTimes(1));
      env.emit('Page.javascriptDialogOpening', {
        type: 'confirm',
        message: 'Continue?',
      });

      const blocked = await action;
      expect(blocked.ok).toBe(true);
      expect(blocked.data).toMatchObject({
        tabId: 't1',
        kind: 'click',
        barrier: {
          kind: 'page-dialog',
          dialog: { type: 'confirm', message: 'Continue?' },
        },
      });
      const dialogId = (blocked.data as {
        barrier: { dialog: { id: string } };
      }).barrier.dialog.id;

      const handled = await env.backend.call({
        action: 'dialog',
        targetId: 't1',
        dialogId,
        accept: true,
      });
      expect(handled.ok).toBe(true);
      await vi.waitFor(() => expect(actionFinished).toHaveBeenCalledTimes(1));
    } finally {
      await env.backend.dispose();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('blocks direct actions after a human-verification snapshot barrier', async () => {
    const env = buildPageEnv({ humanVerification: true });
    const snapshot = await env.backend.call({ action: 'snapshot', targetId: 't1' });
    expect(snapshot.data).toMatchObject({
      barrier: { kind: 'human-verification' },
    });

    const action = await env.backend.call({
      action: 'act',
      targetId: 't1',
      request: { kind: 'clickCoords', x: 10, y: 10 },
    });
    expect(action.data).toMatchObject({
      barrier: { kind: 'human-verification' },
    });
    expect(env.sendCommand).not.toHaveBeenCalledWith(
      'Input.dispatchMouseEvent',
      expect.anything(),
    );
    await env.backend.dispose();
  });

  it('continues a page action when dialog observation is unavailable', async () => {
    const env = buildPageEnv({
      pageEnableError: new Error('another debugger client owns the page'),
    });
    const automation = (env.backend as unknown as {
      automation: {
        act: (
          tabId: string,
          wc: WebContents,
          request: Record<string, unknown>,
        ) => Promise<Record<string, unknown>>;
      };
    }).automation;
    vi.spyOn(automation, 'act').mockResolvedValue({
      tabId: 't1',
      kind: 'click',
    });

    try {
      const result = await env.backend.call({
        action: 'act',
        targetId: 't1',
        request: { kind: 'click', targetId: 't1', ref: 'button-1' },
      });

      expect(result.ok).toBe(true);
      expect(result.data).toMatchObject({ tabId: 't1', kind: 'click' });
      expect(env.backendLogger.warn).toHaveBeenCalledWith(
        'RSB page dialog observation unavailable',
        expect.objectContaining({ tabId: 't1' }),
      );
    } finally {
      await env.backend.dispose();
    }
  });

  it('keeps the host interactive after an auto-closed dialog and arms a retry', async () => {
    const env = buildPageEnv();
    const automation = (env.backend as unknown as {
      automation: {
        act: (
          tabId: string,
          wc: WebContents,
          request: Record<string, unknown>,
        ) => Promise<Record<string, unknown>>;
      };
    }).automation;
    let releaseAction = () => {};
    const actSpy = vi.spyOn(automation, 'act').mockImplementation(
      () => {
        env.emit('Page.javascriptDialogOpening', {
          type: 'confirm',
          message: 'Continue?',
        });
        env.emit('Page.javascriptDialogClosed', {
          result: false,
          userInput: '',
        });
        return new Promise((resolve) => {
          releaseAction = () => resolve({ tabId: 't1', kind: 'click' });
        });
      },
    );

    try {
      const action = env.backend.call({
        action: 'act',
        targetId: 't1',
        request: { kind: 'click', targetId: 't1', ref: 'button-1' },
      });
      await vi.waitFor(() => expect(actSpy).toHaveBeenCalledTimes(1));
      const blocked = await action;
      expect(blocked.data).toMatchObject({
        barrier: {
          kind: 'page-dialog',
          dialog: { type: 'confirm', message: 'Continue?' },
        },
      });
      expect(env.registry.pinHistory).toEqual([{ op: 'pin', tabId: 't1' }]);
      const dialogId = (blocked.data as {
        barrier: { dialog: { id: string } };
      }).barrier.dialog.id;

      const armed = await env.backend.call({
        action: 'dialog',
        targetId: 't1',
        dialogId,
        accept: true,
      });
      expect(armed.data).toMatchObject({
        tabId: 't1',
        armed: true,
        retryRequired: true,
      });
      releaseAction();
      await vi.waitFor(() => {
        expect(env.registry.pinHistory).toEqual([
          { op: 'pin', tabId: 't1' },
          { op: 'pin', tabId: 't1' },
          { op: 'unpin', tabId: 't1' },
          { op: 'unpin', tabId: 't1' },
        ]);
      });
    } finally {
      releaseAction();
      await env.backend.dispose();
    }
  });

  it('prepares the next confirmation when no previous dialog record remains', async () => {
    const env = buildPageEnv();
    await env.backend.call({ action: 'snapshot', targetId: 't1' });

    const dialogs = (env.backend as unknown as {
      dialogs: {
        respond: (...args: unknown[]) => Promise<never>;
      };
    }).dialogs;
    vi.spyOn(dialogs, 'respond').mockRejectedValueOnce(
      new Error('no page dialog is pending'),
    );

    try {
      const armed = await env.backend.call({
        action: 'dialog',
        targetId: 't1',
        accept: true,
      });
      expect(armed.ok).toBe(true);
      expect(armed.data).toMatchObject({
        tabId: 't1',
        armed: true,
        retryRequired: true,
      });

      env.emit('Page.javascriptDialogOpening', {
        type: 'confirm',
        message: 'Continue?',
      });
      await vi.waitFor(() => {
        expect(env.sendCommand).toHaveBeenCalledWith(
          'Page.handleJavaScriptDialog',
          { accept: true },
        );
      });
    } finally {
      await env.backend.dispose();
    }
  });

  it.each([
    {
      dialogType: 'alert',
      expected: {
        dialogs: [{
          type: 'alert',
          message: 'Notice',
          closedBy: 'auto',
          handled: true,
        }],
      },
    },
    {
      dialogType: 'confirm',
      expected: {
        barrier: {
          kind: 'page-dialog',
          dialog: {
            type: 'confirm',
            message: 'Notice',
            closedBy: 'auto',
          },
        },
      },
    },
  ])(
    'classifies an auto-closed $dialogType even when the action finishes immediately',
    async ({ dialogType, expected }) => {
      const env = buildPageEnv();
      const automation = (env.backend as unknown as {
        automation: {
          act: (
            tabId: string,
            wc: WebContents,
            request: Record<string, unknown>,
          ) => Promise<Record<string, unknown>>;
        };
      }).automation;
      vi.spyOn(automation, 'act').mockImplementation(async () => {
        env.emit('Page.javascriptDialogOpening', {
          type: dialogType,
          message: 'Notice',
        });
        env.emit('Page.javascriptDialogClosed', {
          result: false,
          userInput: '',
        });
        return { tabId: 't1', kind: 'click' };
      });

      try {
        const result = await env.backend.call({
          action: 'act',
          targetId: 't1',
          request: { kind: 'click', targetId: 't1', ref: 'button-1' },
        });
        expect(result.ok).toBe(true);
        expect(result.data).toMatchObject(expected);
      } finally {
        await env.backend.dispose();
      }
    },
  );

  it('saves only a resource listed by the latest page snapshot', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-browser-resource-'));
    try {
      const resourceUrl = 'https://cdn.example.test/archive.bin';
      const env = buildPageEnv({ uploadRoot: root, resourceUrl });
      const snapshot = await env.backend.call({
        action: 'snapshot',
        targetId: 't1',
        urls: true,
      });
      expect(snapshot.data).toMatchObject({
        resources: [{ kind: 'download', url: resourceUrl }],
      });

      const saved = await env.backend.call({
        action: 'act',
        targetId: 't1',
        request: { kind: 'saveResource', url: resourceUrl, timeoutMs: 1000 },
      });

      expect(saved.ok).toBe(true);
      expect(saved.data).toMatchObject({
        kind: 'saveResource',
        downloads: [
          {
            fileName: 'page-resource.bin',
            state: 'completed',
          },
        ],
      });
      expect(env.downloadURL).toHaveBeenCalledWith(resourceUrl);
      const artifactPath = (saved.data as {
        downloads: Array<{ path: string }>;
      }).downloads[0].path;
      await expect(fs.readFile(artifactPath, 'utf8')).resolves.toBe('data');
      await env.backend.dispose();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('captures downloads triggered by submit-enabled typing', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-browser-submit-download-'));
    try {
      const env = buildPageEnv({ uploadRoot: root });
      const automation = (env.backend as unknown as {
        automation: {
          act: (
            tabId: string,
            wc: WebContents,
            request: Record<string, unknown>,
          ) => Promise<Record<string, unknown>>;
        };
      }).automation;
      vi.spyOn(automation, 'act').mockImplementation(async () => {
        env.downloadURL('https://example.test/submit-download');
        return { tabId: 't1', kind: 'type', textLength: 1 };
      });

      const result = await env.backend.call({
        action: 'act',
        targetId: 't1',
        request: {
          kind: 'type',
          targetId: 't1',
          ref: 'input-1',
          text: 'x',
          submit: true,
        },
      } as never);

      expect(result.ok).toBe(true);
      expect(result.data).toMatchObject({
        kind: 'type',
        downloads: [{ state: 'completed' }],
      });
      await env.backend.dispose();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe('RsbWebviewBackend — network actions', () => {
  function buildNetworkEnv() {
    let attached = false;
    const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
    const sendCommand = vi.fn(async (method: string) => {
      if (method === 'Network.enable') return {};
      if (method === 'Network.getResponseBody') {
        return { body: '{"items":[1,2,3]}', base64Encoded: false };
      }
      throw new Error(`unexpected command: ${method}`);
    });
    const wc = fakeWc();
    Object.assign(wc, {
      once: vi.fn(),
      debugger: {
        isAttached: () => attached,
        attach: vi.fn(() => {
          attached = true;
        }),
        detach: vi.fn(() => {
          attached = false;
        }),
        sendCommand,
        on: (event: string, listener: (...args: unknown[]) => void) => {
          const group = listeners.get(event) ?? new Set();
          group.add(listener);
          listeners.set(event, group);
        },
        removeListener: (event: string, listener: (...args: unknown[]) => void) => {
          listeners.get(event)?.delete(listener);
        },
      },
    });
    const registry = fakeRegistry(
      [{ sessionId: 's1', tabId: 't1', webContentsId: 101 }],
      new Map([['t1', wc]]),
    );
    const backend = new RsbWebviewBackend({
      registry,
      getActiveSessionId: () => 's1',
      bridge: { getHostWebContents: () => null, logger: logger() },
      logger: logger(),
    });
    const emitNetwork = (method: string, params: Record<string, unknown>) => {
      for (const listener of listeners.get('message') ?? []) {
        listener({}, method, params);
      }
    };
    return { backend, emitNetwork, sendCommand };
  }

  it('dispatches request history through the selected tab', async () => {
    const env = buildNetworkEnv();
    await env.backend.call({ action: 'requests', targetId: 't1' } as never);
    env.emitNetwork('Network.requestWillBeSent', {
      requestId: 'r1',
      type: 'Fetch',
      request: { method: 'GET', url: 'https://example.test/api/items' },
    });
    env.emitNetwork('Network.responseReceived', {
      requestId: 'r1',
      response: { url: 'https://example.test/api/items', status: 200 },
    });
    env.emitNetwork('Network.loadingFinished', { requestId: 'r1' });

    const res = await env.backend.call({
      action: 'requests',
      targetId: 't1',
      filter: '/api/',
    } as never);

    expect(res.ok).toBe(true);
    expect(res.data).toMatchObject({
      tabId: 't1',
      requests: [
        {
          id: 'r1',
          method: 'GET',
          url: 'https://example.test/api/items',
          status: 200,
          ok: true,
        },
      ],
    });
  });

  it('returns the body of the next completed matching response', async () => {
    const env = buildNetworkEnv();
    await env.backend.call({ action: 'requests', targetId: 't1' } as never);
    const pending = env.backend.call({
      action: 'responseBody',
      targetId: 't1',
      url: '/api/items',
      maxChars: 8,
    } as never);
    await new Promise((resolve) => setTimeout(resolve, 10));
    env.emitNetwork('Network.requestWillBeSent', {
      requestId: 'r2',
      type: 'XHR',
      request: { method: 'GET', url: 'https://example.test/api/items' },
    });
    env.emitNetwork('Network.responseReceived', {
      requestId: 'r2',
      response: {
        url: 'https://example.test/api/items',
        status: 200,
        headers: { 'content-type': 'application/json' },
      },
    });
    env.emitNetwork('Network.loadingFinished', { requestId: 'r2' });

    const res = await pending;

    expect(res.ok).toBe(true);
    expect(res.data).toMatchObject({
      tabId: 't1',
      response: {
        url: 'https://example.test/api/items',
        body: '{"items"',
        truncated: true,
      },
    });
    expect(env.sendCommand).toHaveBeenCalledWith('Network.getResponseBody', {
      requestId: 'r2',
    });
  });
});

describe('RsbWebviewBackend — unsupported actions', () => {
  it('unknown actions return BROWSER_RUNTIME_ACTION_FAILED with explanation', async () => {
    const backend = new RsbWebviewBackend({
      registry: fakeRegistry([], new Map()),
      getActiveSessionId: () => 's1',
      bridge: { getHostWebContents: () => null, logger: logger() },
      logger: logger(),
    });
    const res = await backend.call({ action: 'trace' } as never);
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe('BROWSER_RUNTIME_ACTION_FAILED');
    expect(res.message).toMatch(/not yet supported/);
  });

  it('thrown exceptions inside a handler are caught into actionFailed', async () => {
    const wc = {
      getURL: () => '',
      getTitle: () => '',
      isDestroyed: () => false,
      loadURL: vi.fn().mockRejectedValueOnce(new Error('net::ERR_FAIL')),
    } as unknown as WebContents;
    const registry = fakeRegistry(
      [{ sessionId: 's1', tabId: 't1', webContentsId: 101 }],
      new Map([['t1', wc]]),
    );
    const backend = new RsbWebviewBackend({
      registry,
      getActiveSessionId: () => 's1',
      bridge: { getHostWebContents: () => null, logger: logger() },
      logger: logger(),
    });
    const res = await backend.call({
      action: 'navigate',
      targetId: 't1',
      url: 'https://broken.test',
    } as never);
    expect(res.ok).toBe(false);
    expect(res.message).toBe('net::ERR_FAIL');
  });
});

describe('RsbWebviewBackend — detached-window ensure/wait for direct actions', () => {
  // 场景:detached 偏好开 + 侧边栏子窗口关着 → webview guests 已销毁、registry
  // 记录被 prune。直连动作(navigate / screenshot / ...)必须跟 open/focus/close
  // 一样先 ensureHost 拉起子窗口,再有界等待 renderer 重新注册 tab。

  it('direct action runs ensureHost before resolving (no-op host already up)', async () => {
    const ensureHost = vi.fn(async () => undefined);
    const wc = fakeWc();
    const registry = fakeRegistry(
      [{ sessionId: 's1', tabId: 't1', webContentsId: 101 }],
      new Map([['t1', wc]]),
    );
    const backend = new RsbWebviewBackend({
      registry,
      getActiveSessionId: () => 's1',
      bridge: { getHostWebContents: () => null, ensureHost, logger: logger() },
      logger: logger(),
    });
    const res = await backend.call({
      action: 'navigate',
      targetId: 't1',
      url: 'https://example.com',
    } as never);
    expect(ensureHost).toHaveBeenCalledTimes(1);
    expect(res.ok).toBe(true);
  });

  it('recovers when the tab re-registers during the bounded wait', async () => {
    const rows: TabRecord[] = [];
    const wcMap = new Map<string, WebContents>();
    const registry = fakeRegistry(rows, wcMap);
    const ensureHost = vi.fn(async () => undefined);
    dispatchTabOpSpy.mockResolvedValue({ reqId: 'x', ok: true, tabId: 't1' });
    const backend = new RsbWebviewBackend({
      registry,
      getActiveSessionId: () => 's1',
      bridge: {
        getHostWebContents: () => null,
        ensureHost,
        isDetached: () => true,
        logger: logger(),
      },
      logger: logger(),
      reattachWait: { totalMs: 1000, pollMs: 10 },
    });
    // 模拟重开的子窗口 renderer 在 ~30ms 后 hydrate + report 完成
    const wc = fakeWc();
    setTimeout(() => {
      rows.push({ sessionId: 's1', tabId: 't1', webContentsId: 101 });
      wcMap.set('t1', wc);
    }, 30);
    const res = await backend.call({
      action: 'navigate',
      targetId: 't1',
      url: 'https://example.com',
    } as never);
    expect(res.ok).toBe(true);
    expect(wc.loadURLMock).toHaveBeenCalledWith('https://example.com');
    // 恢复路径必须先请求 renderer 主动物化(ensure),不能只被动轮询 ——
    // 跨会话 tab 在重开的窗口里不会自然重注册。
    expect(dispatchTabOpSpy).toHaveBeenCalledWith(
      { op: 'ensure', sessionId: 's1', tabId: 't1' },
      expect.any(Object),
      expect.any(Function),
    );
  });

  it('targetless direct action recovers via targetless ensure (registry pruned)', async () => {
    // detached 收起后 registry 空,targetless navigate 不能死在 'targetId required':
    // 先发无 tabId 的 ensure,由 renderer 从 bucket 选默认浏览器 tab 物化并回传 tabId。
    const rows: TabRecord[] = [];
    const wcMap = new Map<string, WebContents>();
    const registry = fakeRegistry(rows, wcMap);
    const ensureHost = vi.fn(async () => undefined);
    const wc = fakeWc();
    dispatchTabOpSpy.mockImplementation(async () => {
      // renderer 物化后 report 先于 ack 落地 —— 模拟为:ack 前 registry 已有记录
      if (!rows.some((r) => r.tabId === 't-active')) {
        rows.push({ sessionId: 's1', tabId: 't-active', webContentsId: 202 });
        wcMap.set('t-active', wc);
      }
      return { reqId: 'x', ok: true, tabId: 't-active' };
    });
    const backend = new RsbWebviewBackend({
      registry,
      getActiveSessionId: () => 's1',
      bridge: {
        getHostWebContents: () => null,
        ensureHost,
        isDetached: () => true,
        logger: logger(),
      },
      logger: logger(),
      reattachWait: { totalMs: 500, pollMs: 10 },
    });
    const res = await backend.call({
      action: 'navigate',
      url: 'https://example.com',
    } as never);
    expect(res.ok).toBe(true);
    expect(dispatchTabOpSpy).toHaveBeenCalledWith(
      { op: 'ensure', sessionId: 's1' },
      expect.any(Object),
      expect.any(Function),
    );
    expect(wc.loadURLMock).toHaveBeenCalledWith('https://example.com');
  });

  it('renderer confirms the tab is gone (ensure ok:false) → fail fast, skip the poll', async () => {
    dispatchTabOpSpy.mockResolvedValue({ reqId: 'x', ok: false, error: 'tab t-ghost not found' });
    const ensureHost = vi.fn(async () => undefined);
    const backend = new RsbWebviewBackend({
      registry: fakeRegistry([], new Map()),
      getActiveSessionId: () => 's1',
      bridge: {
        getHostWebContents: () => null,
        ensureHost,
        isDetached: () => true,
        logger: logger(),
      },
      logger: logger(),
      reattachWait: { totalMs: 5000, pollMs: 250 },
    });
    const started = Date.now();
    const res = await backend.call({
      action: 'navigate',
      targetId: 't-ghost',
      url: 'x',
    } as never);
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/t-ghost not in active session s1/);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('fails with the original clear error after the bounded wait expires', async () => {
    // ensure 声称成功但 registry 始终没等到 report(如 dom-ready 超时后 report 失败)
    dispatchTabOpSpy.mockResolvedValue({ reqId: 'x', ok: true, tabId: 't-ghost' });
    const ensureHost = vi.fn(async () => undefined);
    const backend = new RsbWebviewBackend({
      registry: fakeRegistry([], new Map()),
      getActiveSessionId: () => 's1',
      bridge: {
        getHostWebContents: () => null,
        ensureHost,
        isDetached: () => true,
        logger: logger(),
      },
      logger: logger(),
      reattachWait: { totalMs: 60, pollMs: 15 },
    });
    const res = await backend.call({
      action: 'navigate',
      targetId: 't-ghost',
      url: 'x',
    } as never);
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/t-ghost not in active session s1/);
  });

  it('ensureHost rejection does not mask a resolvable tab', async () => {
    const ensureHost = vi.fn(async () => {
      throw new Error('ready timeout');
    });
    const wc = fakeWc();
    const registry = fakeRegistry(
      [{ sessionId: 's1', tabId: 't1', webContentsId: 101 }],
      new Map([['t1', wc]]),
    );
    const backend = new RsbWebviewBackend({
      registry,
      getActiveSessionId: () => 's1',
      bridge: { getHostWebContents: () => null, ensureHost, logger: logger() },
      logger: logger(),
    });
    const res = await backend.call({
      action: 'screenshot',
      targetId: 't1',
    } as never);
    expect(res.ok).toBe(true);
  });

  it('embedded mode (isDetached false) → resolve miss fails fast, no polling', async () => {
    // 生产环境 ensureHost 恒有值(内嵌时是即时 no-op),不能只靠它的存在与否
    // 判断要不要等 —— gate 在 isDetached 上,内嵌 miss 即真失效。
    const ensureHost = vi.fn(async () => undefined);
    const backend = new RsbWebviewBackend({
      registry: fakeRegistry([], new Map()),
      getActiveSessionId: () => 's1',
      bridge: {
        getHostWebContents: () => null,
        ensureHost,
        isDetached: () => false,
        logger: logger(),
      },
      logger: logger(),
      reattachWait: { totalMs: 5000, pollMs: 250 },
    });
    const started = Date.now();
    const res = await backend.call({
      action: 'navigate',
      targetId: 't-ghost',
      url: 'x',
    } as never);
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/t-ghost not in active session s1/);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(dispatchTabOpSpy).not.toHaveBeenCalled();
  });

  it('no ensureHost in bridge → immediate failure, no polling delay', async () => {
    const backend = new RsbWebviewBackend({
      registry: fakeRegistry([], new Map()),
      getActiveSessionId: () => 's1',
      bridge: { getHostWebContents: () => null, logger: logger() },
      logger: logger(),
      reattachWait: { totalMs: 5000, pollMs: 250 },
    });
    const started = Date.now();
    const res = await backend.call({
      action: 'navigate',
      targetId: 't-ghost',
      url: 'x',
    } as never);
    expect(res.ok).toBe(false);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
