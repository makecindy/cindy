// GhostPanelWindowsController 状态机单测(纯 DI,不 mock electron):
//  - setDetached(true) 开窗 + 落盘 + 广播;两个 ghost 互不影响
//  - 用户关窗(closed 事件)清标志 = 回停靠;app 退出路径保留标志供重启恢复
//  - open 资格不符(卸载/停用/tab 形态)→ 清条目不开窗
//  - reconcile:卸载删条目并收窗;停用清标志并收窗

import { describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';

import type { GhostPanelWindowsState } from '../../../shared/ghostPanelWindow.js';
import {
  GhostPanelWindowsController,
  type GhostPanelWindowsControllerDeps,
} from '../controller.js';
import type { InstalledGhost, GhostManifest } from '../../../shared/ghost.js';

interface FakeWindow {
  on: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  show: ReturnType<typeof vi.fn>;
  focus: ReturnType<typeof vi.fn>;
  restore: ReturnType<typeof vi.fn>;
  isMinimized: () => boolean;
  isDestroyed: () => boolean;
  destroyed: boolean;
  emitClosed: () => void;
}

function fakeWindow(): FakeWindow {
  const listeners = new Map<string, () => void>();
  const win: FakeWindow = {
    on: vi.fn((event: string, cb: () => void) => {
      listeners.set(event, cb);
    }),
    close: vi.fn(() => {
      win.destroyed = true;
      listeners.get('closed')?.();
    }),
    show: vi.fn(),
    focus: vi.fn(),
    restore: vi.fn(),
    isMinimized: () => false,
    isDestroyed: () => win.destroyed,
    destroyed: false,
    emitClosed: () => {
      win.destroyed = true;
      listeners.get('closed')?.();
    },
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
    slots: ['panel'],
    panel: {
      html: 'panel.html',
      ...(opts.position !== undefined ? { position: opts.position } : {}),
    },
  };
  return { manifest, dir: `/fake/${id}`, enabled: opts.enabled ?? true };
}

function makeHarness(detachableIds: Set<string>) {
  let entries: Record<string, { detached: boolean; lastOpen: boolean }> = {};
  let quitting = false;
  const created: Array<{ ghostId: string; win: FakeWindow }> = [];
  const broadcasts: GhostPanelWindowsState[] = [];

  const deps: GhostPanelWindowsControllerDeps = {
    settings: {
      read: () => ({ windows: structuredClone(entries) }),
      patchEntry: (id, patch) => {
        const base = entries[id] ?? { detached: false, lastOpen: false };
        entries[id] = { ...base, ...patch };
      },
      removeEntry: (id) => {
        delete entries[id];
      },
    },
    createWindow: (ghostId) => {
      const win = fakeWindow();
      created.push({ ghostId, win });
      return win as unknown as BrowserWindow;
    },
    isGhostDetachable: (id) => detachableIds.has(id),
    broadcastState: (s) => {
      broadcasts.push(s);
    },
    isQuitting: () => quitting,
    log: { info: vi.fn(), warn: vi.fn() },
  };
  const controller = new GhostPanelWindowsController(deps);
  return {
    controller,
    created,
    broadcasts,
    entries: () => entries,
    setEntries: (next: Record<string, { detached: boolean; lastOpen: boolean }>) => {
      entries = next;
    },
    setQuitting: (v: boolean) => {
      quitting = v;
    },
  };
}

describe('GhostPanelWindowsController', () => {
  it('setDetached(true) 开窗 + 落盘 detached/lastOpen + 广播 open:true', () => {
    const h = makeHarness(new Set(['a']));
    const state = h.controller.setDetached('a', true);
    expect(h.created.map((c) => c.ghostId)).toEqual(['a']);
    expect(h.entries().a).toEqual({ detached: true, lastOpen: true });
    expect(state.a).toEqual({ detached: true, lastOpen: true, open: true });
    expect(h.broadcasts.length).toBeGreaterThan(0);
  });

  it('重复 setDetached(true) 幂等:不再建窗,已开窗 focus', () => {
    const h = makeHarness(new Set(['a']));
    h.controller.setDetached('a', true);
    h.controller.setDetached('a', true);
    expect(h.created).toHaveLength(1);
    expect(h.created[0].win.focus).toHaveBeenCalled();
  });

  it('两个 ghost 各开各窗、互不影响;setDetached(false) 只收自己的', () => {
    const h = makeHarness(new Set(['a', 'b']));
    h.controller.setDetached('a', true);
    h.controller.setDetached('b', true);
    expect(h.created.map((c) => c.ghostId)).toEqual(['a', 'b']);
    const state = h.controller.setDetached('a', false);
    expect(state.a).toEqual({ detached: false, lastOpen: false, open: false });
    expect(state.b).toEqual({ detached: true, lastOpen: true, open: true });
    expect(h.created[0].win.close).toHaveBeenCalled();
    expect(h.created[1].win.close).not.toHaveBeenCalled();
  });

  it('用户关窗(closed):清两标志 = 回停靠;app 退出路径保留标志', () => {
    const h = makeHarness(new Set(['a', 'b']));
    h.controller.setDetached('a', true);
    h.created[0].win.emitClosed();
    expect(h.entries().a).toEqual({ detached: false, lastOpen: false });

    h.controller.setDetached('b', true);
    h.setQuitting(true);
    h.created[1].win.emitClosed();
    expect(h.entries().b).toEqual({ detached: true, lastOpen: true });
  });

  it('open 资格不符(卸载/停用/tab)→ 清条目不开窗', () => {
    const h = makeHarness(new Set());
    h.setEntries({ a: { detached: true, lastOpen: true } });
    h.controller.open('a');
    expect(h.created).toHaveLength(0);
    expect(h.entries().a).toBeUndefined();
  });

  it('reconcile:卸载收窗删条目;停用收窗清标志;在场且合格的不动', () => {
    const h = makeHarness(new Set(['gone', 'disabled', 'stays']));
    h.controller.setDetached('gone', true);
    h.controller.setDetached('disabled', true);
    h.controller.setDetached('stays', true);

    h.controller.reconcile([ghost('disabled', { enabled: false }), ghost('stays')]);

    expect(h.created[0].win.close).toHaveBeenCalled(); // gone(清单里消失)
    expect(h.created[1].win.close).toHaveBeenCalled(); // disabled
    expect(h.created[2].win.close).not.toHaveBeenCalled();
    expect(h.entries().gone).toBeUndefined();
    expect(h.entries().disabled).toEqual({ detached: false, lastOpen: false });
    expect(h.entries().stays).toEqual({ detached: true, lastOpen: true });
  });

  it('reconcile:换成 tab 形态视同失去资格', () => {
    const h = makeHarness(new Set(['a']));
    h.controller.setDetached('a', true);
    h.controller.reconcile([ghost('a', { position: 'tab' })]);
    expect(h.created[0].win.close).toHaveBeenCalled();
    expect(h.entries().a).toEqual({ detached: false, lastOpen: false });
  });

  it('getState:无条目 ghost 不出现;开窗态 open:true', () => {
    const h = makeHarness(new Set(['a']));
    expect(h.controller.getState()).toEqual({});
    h.controller.setDetached('a', true);
    expect(h.controller.getState()).toEqual({
      a: { detached: true, lastOpen: true, open: true },
    });
  });
});
