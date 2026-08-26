// GhostPanelWindowsController lifecycle state-machine tests (DI only, no electron).
// Covers: prewarm, hide-reuse close, setDetached(false)=dispose, two-phase ready,
// multi-instance isolation, reconcile cleanup, crash recovery, sender guard.

import { describe, expect, it, vi } from 'vitest';
import type { BrowserWindow, WebContents } from 'electron';

import type { GhostPanelWindowsState } from '../../../shared/ghostPanelWindow.js';
import {
  GhostPanelWindowsController,
  type GhostPanelWindowsControllerDeps,
} from '../controller.js';
import type { InstalledGhost, GhostManifest } from '../../../shared/ghost.js';

interface FakeWindow {
  on: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  hide: ReturnType<typeof vi.fn>;
  show: ReturnType<typeof vi.fn>;
  focus: ReturnType<typeof vi.fn>;
  restore: ReturnType<typeof vi.fn>;
  isMinimized: () => boolean;
  isVisible: () => boolean;
  isDestroyed: () => boolean;
  destroyed: boolean;
  visible: boolean;
  webContents: {
    id: number;
    on: ReturnType<typeof vi.fn>;
    isDestroyed: () => boolean;
  };
  emitClosed: () => void;
  emitWindowEvent: (event: string, ...args: unknown[]) => void;
  emitWebContentsEvent: (event: string, ...args: unknown[]) => void;
  _id: number;
}

let nextId = 1;
function fakeWindow(): FakeWindow {
  const id = nextId++;
  const winListeners = new Map<string, (...args: unknown[]) => void>();
  const wcListeners = new Map<string, (...args: unknown[]) => void>();
  let destroyed = false;
  let visible = false;
  const wcOn = vi.fn((event: string, cb: (...args: unknown[]) => void) => {
    wcListeners.set(event, cb);
  });
  const win: FakeWindow = {
    on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
      winListeners.set(event, cb);
    }),
    close: vi.fn(() => {
      let prevented = false;
      winListeners.get('close')?.({ preventDefault: () => { prevented = true; } });
      if (prevented) return;
      destroyed = true;
      visible = false;
      winListeners.get('closed')?.();
    }),
    destroy: vi.fn(() => { destroyed = true; visible = false; winListeners.get('closed')?.(); }),
    hide: vi.fn(() => { visible = false; }),
    show: vi.fn(() => { visible = true; }),
    focus: vi.fn(),
    restore: vi.fn(),
    isMinimized: () => false,
    isVisible: () => visible,
    isDestroyed: () => destroyed,
    destroyed: false,
    visible: false,
    webContents: {
      id,
      on: wcOn,
      isDestroyed: () => destroyed,
    },
    emitClosed: () => {
      destroyed = true;
      visible = false;
      winListeners.get('closed')?.();
    },
    emitWindowEvent: (event, ...args) => {
      if (event === 'hide') visible = false;
      if (event === 'show') visible = true;
      winListeners.get(event)?.(...args);
    },
    emitWebContentsEvent: (event, ...args) => wcListeners.get(event)?.(...args),
    _id: id,
  };
  return win;
}

function ghost(id: string, opts: { enabled?: boolean; position?: 'left' | 'tab' } = {}): InstalledGhost {
  const manifest: GhostManifest = {
    schemaVersion: 2,
    id,
    name: id,
    version: '1.0.0',
    kind: 'chip',
    entry: 'main.js',
    panel: {
      html: 'panel.html',
      ...(opts.position !== undefined ? { position: opts.position } : {}),
    },
  };
  return {
    manifest,
    dir: `/fake/${id}`,
    enabled: opts.enabled ?? true,
    approval: { state: 'approved', revision: '00000000-0000-4000-8000-000000000001' },
  };
}

function makeHarness(detachableIds: Set<string>) {
  let entries: Record<string, { detached: boolean; lastOpen: boolean }> = {};
  let quitting = false;
  const created: Array<{ ghostId: string; win: FakeWindow }> = [];
  const broadcasts: GhostPanelWindowsState[] = [];
  const sends: Array<{ channel: string; payload: unknown }> = [];

  const deps: GhostPanelWindowsControllerDeps = {
    settings: {
      read: () => ({ windows: structuredClone(entries) }),
      patchEntry: (id, patch) => {
        const base = entries[id] ?? { detached: false, lastOpen: false };
        entries[id] = { ...base, ...patch };
      },
      removeEntry: (id) => { delete entries[id]; },
    },
    createWindow: (ghostId) => {
      const win = fakeWindow();
      created.push({ ghostId, win });
      return win as unknown as BrowserWindow;
    },
    isGhostDetachable: (id) => detachableIds.has(id),
    broadcastState: (s) => { broadcasts.push(s); },
    sendToWindow: (_win, channel, payload) => { sends.push({ channel, payload }); },
    isQuitting: () => quitting,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
  const controller = new GhostPanelWindowsController(deps);
  return {
    controller,
    created,
    broadcasts,
    sends,
    entries: () => entries,
    setEntries: (next: Record<string, { detached: boolean; lastOpen: boolean }>) => { entries = next; },
    setDetachable: (ghostId: string, detachable: boolean) => {
      if (detachable) detachableIds.add(ghostId);
      else detachableIds.delete(ghostId);
    },
    setQuitting: (v: boolean) => { quitting = v; },
  };
}

function markReady(controller: GhostPanelWindowsController, win: FakeWindow): void {
  controller.markRendererReady(win.webContents as unknown as WebContents);
  controller.markPresentationReady(win.webContents as unknown as WebContents);
}

describe('prewarm / open / close (hide-reuse)', () => {
  it('prewarm creates hidden window without showing or focusing', () => {
    const h = makeHarness(new Set(['a']));
    h.controller.prewarm('a');
    expect(h.created).toHaveLength(1);
    const win = h.created[0].win;
    expect(win.show).not.toHaveBeenCalled();
    expect(win.focus).not.toHaveBeenCalled();
    expect(h.entries().a?.lastOpen).toBeUndefined(); // prewarm doesn't set lastOpen
  });

  it('open creates window + sets lastOpen + broadcasts', () => {
    const h = makeHarness(new Set(['a']));
    h.controller.open('a');
    expect(h.created).toHaveLength(1);
    expect(h.entries().a).toEqual({ detached: true, lastOpen: true });
    expect(h.broadcasts.length).toBeGreaterThan(0);
  });

  it('hot open on prewarmed+ready window shows + focuses immediately', () => {
    const h = makeHarness(new Set(['a']));
    h.controller.prewarm('a');
    const win = h.created[0].win;
    markReady(h.controller, win);

    h.controller.open('a');
    expect(win.show).toHaveBeenCalled();
    expect(win.focus).toHaveBeenCalled();
    expect(h.created).toHaveLength(1); // no second window
  });

  it('open waits for presentation-ready then shows', () => {
    const h = makeHarness(new Set(['a']));
    h.controller.open('a');
    const win = h.created[0].win;
    // Not shown yet — renderer isn't ready
    expect(win.show).not.toHaveBeenCalled();

    // presentation-ready triggers show
    h.controller.markPresentationReady(win.webContents as unknown as WebContents);
    expect(win.show).toHaveBeenCalled();
    expect(win.focus).toHaveBeenCalled();
  });

  it('close hides window without destroying', () => {
    const h = makeHarness(new Set(['a']));
    h.controller.open('a');
    const win = h.created[0].win;
    markReady(h.controller, win);

    h.controller.close('a');
    expect(win.hide).toHaveBeenCalled();
    expect(win.isDestroyed()).toBe(false);
    expect(h.entries().a?.lastOpen).toBe(false);
    // detached preference preserved
    expect(h.entries().a?.detached).toBe(true);
  });

  it('re-open after close reuses same window (hot path, no recreate)', () => {
    const h = makeHarness(new Set(['a']));
    h.controller.open('a');
    const win = h.created[0].win;
    markReady(h.controller, win);
    h.controller.close('a');

    win.show.mockClear();
    h.controller.open('a');
    expect(h.created).toHaveLength(1); // no new window created
    expect(win.show).toHaveBeenCalled(); // reuse
  });

  it('native hide updates state and open shows the cached window again', () => {
    const h = makeHarness(new Set(['a']));
    h.controller.prewarm('a');
    const win = h.created[0].win;
    markReady(h.controller, win);
    h.controller.open('a');

    win.emitWindowEvent('hide');
    expect(h.controller.getState().a?.open).toBe(false);

    win.show.mockClear();
    win.focus.mockClear();
    h.controller.open('a');
    expect(h.created).toHaveLength(1);
    expect(win.show).toHaveBeenCalledOnce();
    expect(win.focus).toHaveBeenCalledOnce();
    expect(h.controller.getState().a?.open).toBe(true);
  });

  it('open repairs stale controller visibility using the native window state', () => {
    const h = makeHarness(new Set(['a']));
    h.controller.prewarm('a');
    const win = h.created[0].win;
    markReady(h.controller, win);
    h.controller.open('a');

    win.hide();
    win.show.mockClear();
    win.focus.mockClear();

    h.controller.open('a');
    expect(win.show).toHaveBeenCalledOnce();
    expect(win.focus).toHaveBeenCalledOnce();
    expect(h.controller.getState().a?.open).toBe(true);
  });
});

describe('renderer navigation lifecycle', () => {
  it('ignores same-document main-frame navigation such as hash routing', () => {
    const h = makeHarness(new Set(['a']));
    h.controller.prewarm('a');
    const win = h.created[0].win;
    markReady(h.controller, win);
    h.controller.open('a');

    win.hide.mockClear();
    win.emitWebContentsEvent(
      'did-start-navigation',
      {},
      'http://localhost:5173/?ghostPanelWindow=a#/ghost-panel-window',
      true,
      true,
    );

    expect(win.hide).not.toHaveBeenCalled();
    expect(h.controller.getState().a?.open).toBe(true);
  });

  it('ignores child-frame navigation from the embedded ghost webview', () => {
    const h = makeHarness(new Set(['a']));
    h.controller.prewarm('a');
    const win = h.created[0].win;
    markReady(h.controller, win);
    h.controller.open('a');

    win.hide.mockClear();
    win.emitWebContentsEvent(
      'did-start-navigation',
      {},
      'cindy-ghost://a/panel.html',
      false,
      false,
    );

    expect(win.hide).not.toHaveBeenCalled();
    expect(h.controller.getState().a?.open).toBe(true);
  });

  it('temporarily hides and restores for main-frame renderer navigation', () => {
    const h = makeHarness(new Set(['a']));
    h.controller.prewarm('a');
    const win = h.created[0].win;
    markReady(h.controller, win);
    h.controller.open('a');

    win.emitWebContentsEvent(
      'did-start-navigation',
      {},
      'http://localhost:5173/?ghostPanelWindow=1#/ghost-panel-window/a',
      false,
      true,
    );
    expect(win.hide).toHaveBeenCalledOnce();
    expect(h.controller.getState().a?.open).toBe(true);

    markReady(h.controller, win);
    expect(win.show).toHaveBeenCalledTimes(2);
    expect(h.controller.getState().a?.open).toBe(true);
  });
});

describe('setDetached', () => {
  it('true: opens window + sets detached preference', () => {
    const h = makeHarness(new Set(['a']));
    const state = h.controller.setDetached('a', true);
    expect(h.created).toHaveLength(1);
    expect(h.entries().a).toEqual({ detached: true, lastOpen: true });
    expect(state.a).toEqual({ detached: true, lastOpen: true, open: true });
  });

  it('false: disposes window + clears flags', () => {
    const h = makeHarness(new Set(['a']));
    h.controller.setDetached('a', true);
    const win = h.created[0].win;
    markReady(h.controller, win);

    const state = h.controller.setDetached('a', false);
    expect(win.isDestroyed()).toBe(true);
    expect(h.entries().a).toEqual({ detached: false, lastOpen: false });
    expect(state.a.open).toBe(false);
  });

  it('false: only affects specified ghost, others untouched', () => {
    const h = makeHarness(new Set(['a', 'b']));
    h.controller.setDetached('a', true);
    h.controller.setDetached('b', true);
    const state = h.controller.setDetached('a', false);
    expect(state.a.open).toBe(false);
    expect(state.b.open).toBe(true);
  });
});

describe('native minimize', () => {
  it('routes native minimize to the renderer panel-minimize action', () => {
    const h = makeHarness(new Set(['a']));
    h.controller.setDetached('a', true);
    const win = h.created[0].win;

    win.emitWindowEvent('minimize');

    expect(h.sends).toContainEqual({
      channel: 'ghost-panel-window:minimize-requested',
      payload: undefined,
    });
  });
});

describe('multi-instance isolation', () => {
  it('two ghosts maintain independent windows', () => {
    const h = makeHarness(new Set(['a', 'b']));
    h.controller.prewarm('a');
    h.controller.prewarm('b');
    expect(h.created).toHaveLength(2);
    const winA = h.created[0].win;
    const winB = h.created[1].win;
    markReady(h.controller, winA);
    markReady(h.controller, winB);

    h.controller.open('a');
    expect(winA.show).toHaveBeenCalled();
    expect(winB.show).not.toHaveBeenCalled();

    h.controller.close('a');
    expect(winA.hide).toHaveBeenCalled();
    expect(winB.hide).not.toHaveBeenCalled();

    h.controller.open('b');
    expect(winB.show).toHaveBeenCalled();
  });

  it('setDetached(false) on one ghost does not affect another', () => {
    const h = makeHarness(new Set(['a', 'b']));
    h.controller.setDetached('a', true);
    h.controller.setDetached('b', true);
    h.controller.setDetached('a', false);
    expect(h.created[0].win.isDestroyed()).toBe(true);
    expect(h.created[1].win.isDestroyed()).toBe(false);
  });
});

describe('closed event', () => {
  it('user closes window via OS: clears flags', () => {
    const h = makeHarness(new Set(['a']));
    h.controller.setDetached('a', true);
    h.created[0].win.emitClosed();
    expect(h.entries().a).toEqual({ detached: false, lastOpen: false });
  });

  it('app quitting: preserves detached/lastOpen', () => {
    const h = makeHarness(new Set(['b']));
    h.controller.setDetached('b', true);
    h.setQuitting(true);
    h.created[0].win.emitClosed();
    expect(h.entries().b).toEqual({ detached: true, lastOpen: true });
  });
});

describe('open guard (non-detachable)', () => {
  it('non-detachable plugin: prunes entry, no window', () => {
    const h = makeHarness(new Set());
    h.setEntries({ a: { detached: true, lastOpen: true } });
    h.controller.open('a');
    expect(h.created).toHaveLength(0);
    expect(h.entries().a).toBeUndefined();
  });

  it('non-detachable plugin: disposes a stale prewarmed window', () => {
    const h = makeHarness(new Set(['a']));
    h.controller.prewarm('a');
    const win = h.created[0].win;
    h.setDetachable('a', false);
    h.controller.open('a');
    expect(win.isDestroyed()).toBe(true);
    expect(h.created).toHaveLength(1);
  });

  it('prewarm for non-detachable is no-op', () => {
    const h = makeHarness(new Set());
    h.controller.prewarm('nonexistent');
    expect(h.created).toHaveLength(0);
  });
});

describe('reconcile', () => {
  it('uninstall: disposes window + removes entry', () => {
    const h = makeHarness(new Set(['gone', 'stays']));
    h.controller.setDetached('gone', true);
    h.controller.setDetached('stays', true);
    h.controller.reconcile([ghost('stays')]);
    expect(h.created[0].win.isDestroyed()).toBe(true); // gone
    expect(h.created[1].win.isDestroyed()).toBe(false); // stays
    expect(h.entries().gone).toBeUndefined();
    expect(h.entries().stays).toEqual({ detached: true, lastOpen: true });
  });

  it('disabled: disposes window + clears flags', () => {
    const h = makeHarness(new Set(['disabled']));
    h.controller.setDetached('disabled', true);
    h.controller.reconcile([ghost('disabled', { enabled: false })]);
    expect(h.created[0].win.isDestroyed()).toBe(true);
    expect(h.entries().disabled).toEqual({ detached: false, lastOpen: false });
  });

  it('tab position: treated as non-detachable', () => {
    const h = makeHarness(new Set(['a']));
    h.controller.setDetached('a', true);
    h.controller.reconcile([ghost('a', { position: 'tab' })]);
    expect(h.created[0].win.isDestroyed()).toBe(true);
    expect(h.entries().a).toEqual({ detached: false, lastOpen: false });
  });
});

describe('two-phase ready + sender guard', () => {
  it('markRendererReady from correct sender succeeds', () => {
    const h = makeHarness(new Set(['a']));
    h.controller.prewarm('a');
    const win = h.created[0].win;
    h.controller.markRendererReady(win.webContents as unknown as WebContents);
    // slotForSender finds the slot
    expect(h.controller.slotForSender(win.webContents as unknown as WebContents)).not.toBeNull();
  });

  it('markPresentationReady from wrong sender is no-op', () => {
    const h = makeHarness(new Set(['a']));
    h.controller.prewarm('a');
    const wrongSender = { id: 99999 } as unknown as WebContents;
    h.controller.markPresentationReady(wrongSender);
    // slotForSender returns null
    expect(h.controller.slotForSender(wrongSender)).toBeNull();
  });

  it('getSidebarWebContents returns null for wrong ghostId', () => {
    const h = makeHarness(new Set(['a']));
    h.controller.prewarm('a');
    expect(h.controller.getSidebarWebContents('nonexistent')).toBeNull();
  });
});

describe('crash recovery', () => {
  it('render-process-gone invalidates window and rebuilds if pendingOpen', () => {
    const h = makeHarness(new Set(['a']));
    h.controller.open('a');
    const win1 = h.created[0].win;
    win1.emitWebContentsEvent('render-process-gone', {}, { reason: 'crashed' });
    expect(win1.isDestroyed()).toBe(true);
    expect(h.created).toHaveLength(2); // auto-recovered
  });

  it('recovery is bounded per ghostId', () => {
    const h = makeHarness(new Set(['a']));
    h.controller.open('a');
    const win1 = h.created[0].win;
    // Don't mark ready — simulate rapid crashes where renderer never stabilizes.
    // Without presentationReady resetting the counter, each crash increments.
    win1.emitWebContentsEvent('render-process-gone', {}, { reason: 'crashed' });
    expect(h.created).toHaveLength(2); // auto-recovered once

    const win2 = h.created[1].win;
    win2.emitWebContentsEvent('render-process-gone', {}, { reason: 'killed' });
    expect(h.created).toHaveLength(2); // no third window (quota exhausted)
  });

  it('presentation-ready does not immediately reset the recovery quota', () => {
    const h = makeHarness(new Set(['a']));
    h.controller.open('a');
    h.created[0].win.emitWebContentsEvent('render-process-gone', {}, { reason: 'crashed' });
    const replacement = h.created[1].win;
    markReady(h.controller, replacement);

    replacement.emitWebContentsEvent('render-process-gone', {}, { reason: 'crashed-again' });
    expect(h.created).toHaveLength(2);
  });
});

describe('dispose', () => {
  it('dispose destroys all windows', () => {
    const h = makeHarness(new Set(['a', 'b']));
    h.controller.setDetached('a', true);
    h.controller.setDetached('b', true);
    h.controller.dispose();
    expect(h.created[0].win.isDestroyed()).toBe(true);
    expect(h.created[1].win.isDestroyed()).toBe(true);
  });

  it('dispose is idempotent', () => {
    const h = makeHarness(new Set(['a']));
    h.controller.setDetached('a', true);
    h.controller.dispose();
    h.controller.dispose(); // no throw
  });

  it('destroyAllWindows preserves detached preferences for a future main window', () => {
    const h = makeHarness(new Set(['a']));
    h.controller.setDetached('a', true);
    h.controller.destroyAllWindows();
    expect(h.entries().a).toEqual({ detached: true, lastOpen: true });
  });
});
