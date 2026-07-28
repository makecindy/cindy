// RsbWindowController 状态机单测(纯 DI,不 mock electron):
//  - open / close / setDetached 的落盘 + 广播行为
//  - 用户关窗(closed 事件)在 quitting / 非 quitting 下 lastOpen 的差异
//  - ensureOpenForAutomation:非 detached no-op、开窗等 ready、超时、窗口先关
//  - getHostWebContents 三态(detached+open → 子窗;否则主窗)
//  - setContext 缓存 + 仅窗口开着时转发;routeCommand 原子裁决宿主并处理 deferred intent

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';

import { RsbWindowController, type RsbWindowControllerDeps } from '../controller.js';
import type { RsbWindowSettings } from '../settings-store.js';

interface FakeWindow {
  on: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  show: ReturnType<typeof vi.fn>;
  focus: ReturnType<typeof vi.fn>;
  restore: ReturnType<typeof vi.fn>;
  isMinimized: () => boolean;
  isDestroyed: () => boolean;
  destroyed: boolean;
  webContents: { id: number };
  /** 测试用:触发已注册的 closed listener(模拟用户关窗 / win.close() 完成)。 */
  emitClosed: () => void;
}

function fakeWindow(id = 1, asyncClose = false): FakeWindow {
  const listeners = new Map<string, () => void>();
  const win: FakeWindow = {
    on: vi.fn((event: string, cb: () => void) => {
      listeners.set(event, cb);
    }),
    // 真实 BrowserWindow.close() 异步走到 'closed';fake 里同步触发,足够覆盖状态机
    close: vi.fn(() => {
      if (asyncClose) return;
      win.destroyed = true;
      listeners.get('closed')?.();
    }),
    show: vi.fn(),
    focus: vi.fn(),
    restore: vi.fn(),
    isMinimized: () => false,
    isDestroyed: () => win.destroyed,
    destroyed: false,
    webContents: { id },
    emitClosed: () => {
      win.destroyed = true;
      listeners.get('closed')?.();
    },
  };
  return win;
}

function makeHarness(
  initial: Partial<RsbWindowSettings> = {},
  opts: { asyncClose?: boolean } = {},
) {
  let settings: RsbWindowSettings = { detached: false, lastOpen: false, ...initial };
  let quitting = false;
  const windows: FakeWindow[] = [];
  const createWindowCalls: Array<{ userInitiated: boolean }> = [];
  const mainWin = fakeWindow(100);
  const broadcasts: Array<{ detached: boolean; open: boolean }> = [];
  const sends: Array<{ channel: string; payload: unknown }> = [];
  const sendTargets: number[] = [];

  const deps: RsbWindowControllerDeps = {
    settings: {
      read: () => ({ ...settings }),
      writePatch: (patch) => {
        settings = { ...settings, ...patch };
      },
    },
    createWindow: (createOpts) => {
      createWindowCalls.push(createOpts);
      const w = fakeWindow(200 + windows.length, opts.asyncClose === true);
      windows.push(w);
      return w as unknown as BrowserWindow;
    },
    getMainWindow: () => mainWin as unknown as BrowserWindow,
    broadcastState: (s) => {
      broadcasts.push(s);
    },
    sendToWindow: (win, channel, payload) => {
      sends.push({ channel, payload });
      sendTargets.push((win.webContents as { id: number }).id);
    },
    contextChannel: 'ctx-channel',
    commandChannel: 'cmd-channel',
    isQuitting: () => quitting,
    log: { info: vi.fn(), warn: vi.fn() },
  };
  const controller = new RsbWindowController(deps);
  return {
    controller,
    windows,
    createWindowCalls,
    mainWin,
    broadcasts,
    sends,
    sendTargets,
    getSettings: () => settings,
    setQuitting: (v: boolean) => {
      quitting = v;
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('open / close', () => {
  it('open 建窗 + lastOpen=true + 广播 open:true;重复 open 只 focus 不重建', () => {
    const h = makeHarness();
    h.controller.open();
    expect(h.windows).toHaveLength(1);
    expect(h.getSettings().lastOpen).toBe(true);
    expect(h.broadcasts.at(-1)).toEqual({ detached: false, open: true });

    h.controller.open();
    expect(h.windows).toHaveLength(1);
    expect(h.windows[0].focus).toHaveBeenCalled();
  });

  it('close 落 lastOpen=false;closed 回调广播 open:false', () => {
    const h = makeHarness();
    h.controller.open();
    h.controller.close();
    expect(h.getSettings().lastOpen).toBe(false);
    expect(h.windows[0].close).toHaveBeenCalled();
    expect(h.broadcasts.at(-1)).toEqual({ detached: false, open: false });
  });

  it('窗口不存在时 close 也落 lastOpen=false 并广播', () => {
    const h = makeHarness({ lastOpen: true });
    h.controller.close();
    expect(h.getSettings().lastOpen).toBe(false);
    expect(h.broadcasts.at(-1)).toEqual({ detached: false, open: false });
  });
});

describe('userInitiated:false 不抢用户前台', () => {
  it('窗口已开:程序自发的 open 完全不动窗口(无 show / focus / restore)', () => {
    const h = makeHarness();
    h.controller.open();
    const win = h.windows[0];
    win.show.mockClear();
    win.focus.mockClear();
    win.restore.mockClear();

    h.controller.open({ userInitiated: false });

    expect(h.windows).toHaveLength(1);
    expect(win.show).not.toHaveBeenCalled();
    expect(win.focus).not.toHaveBeenCalled();
    expect(win.restore).not.toHaveBeenCalled();
  });

  it('窗口未开:照常建窗并落 lastOpen,但把 userInitiated:false 透传给窗口工厂', () => {
    const h = makeHarness();
    h.controller.open({ userInitiated: false });
    expect(h.windows).toHaveLength(1);
    expect(h.createWindowCalls).toEqual([{ userInitiated: false }]);
    expect(h.getSettings().lastOpen).toBe(true);
    expect(h.broadcasts.at(-1)).toEqual({ detached: false, open: true });
  });

  it('ensureOpenForAutomation 缺省按程序自发处理(建窗不抢焦点)', async () => {
    const h = makeHarness({ detached: true });
    const p = h.controller.ensureOpenForAutomation();
    h.controller.markReady();
    await expect(p).resolves.toBeUndefined();
    expect(h.createWindowCalls).toEqual([{ userInitiated: false }]);
  });

  it('routeCommand userInitiated:false:命令照常派发,但开窗不抢焦点', async () => {
    const h = makeHarness({ detached: true });
    h.controller.setContext({
      sessionId: 's1',
      workdir: '/w',
      remoteHostId: null,
      available: true,
    });
    const command = { type: 'open-web-browser' as const, sessionId: 's1', url: 'https://x.test/' };
    const routed = h.controller.routeCommand({
      command,
      allowOpen: true,
      userInitiated: false,
    });
    h.controller.markReady();
    await expect(routed).resolves.toBe('routed');
    expect(h.createWindowCalls).toEqual([{ userInitiated: false }]);
    expect(h.sends.at(-1)).toEqual({ channel: 'cmd-channel', payload: command });
  });

  it('routeCommand 缺省(用户手势)仍走聚焦开窗', async () => {
    const h = makeHarness({ detached: true });
    h.controller.setContext({
      sessionId: 's1',
      workdir: '/w',
      remoteHostId: null,
      available: true,
    });
    const routed = h.controller.routeCommand({
      command: { type: 'open-terminal', sessionId: 's1' },
      allowOpen: true,
    });
    h.controller.markReady();
    await expect(routed).resolves.toBe('routed');
    expect(h.createWindowCalls).toEqual([{ userInitiated: true }]);
  });

  it('setDetached(true)(用户点按钮)开窗并聚焦', () => {
    const h = makeHarness();
    h.controller.setDetached(true);
    expect(h.createWindowCalls).toEqual([{ userInitiated: true }]);
    h.controller.setDetached(true);
    expect(h.windows[0].focus).toHaveBeenCalled();
  });
});

describe('closed 事件(用户关窗 vs app 退出)', () => {
  it('非 quitting:lastOpen=false + 广播 open:false', () => {
    const h = makeHarness();
    h.controller.open();
    h.windows[0].emitClosed();
    expect(h.getSettings().lastOpen).toBe(false);
    expect(h.broadcasts.at(-1)).toEqual({ detached: false, open: false });
    expect(h.controller.getState().open).toBe(false);
  });

  it('quitting:lastOpen 保留 true(供重启恢复),不广播', () => {
    const h = makeHarness();
    h.controller.open();
    const broadcastCount = h.broadcasts.length;
    h.setQuitting(true);
    h.windows[0].emitClosed();
    expect(h.getSettings().lastOpen).toBe(true);
    expect(h.broadcasts).toHaveLength(broadcastCount);
  });
});

describe('setDetached', () => {
  it('true:落偏好 + 开窗;返回新 state', () => {
    const h = makeHarness();
    const state = h.controller.setDetached(true);
    expect(h.getSettings().detached).toBe(true);
    expect(h.windows).toHaveLength(1);
    expect(state).toEqual({ detached: true, lastOpen: true, open: true });
  });

  it('false:落偏好 + 关窗;广播最终态 detached:false open:false', () => {
    const h = makeHarness({ detached: true });
    h.controller.open();
    const state = h.controller.setDetached(false);
    expect(h.getSettings().detached).toBe(false);
    expect(state.open).toBe(false);
    expect(h.broadcasts.at(-1)).toEqual({ detached: false, open: false });
  });
});

describe('ensureOpenForAutomation', () => {
  it('非 detached:no-op resolve,不开窗', async () => {
    const h = makeHarness();
    await expect(h.controller.ensureOpenForAutomation()).resolves.toBeUndefined();
    expect(h.windows).toHaveLength(0);
  });

  it('detached + 窗口关:开窗并等 markReady', async () => {
    const h = makeHarness({ detached: true });
    const pending = h.controller.ensureOpenForAutomation();
    expect(h.windows).toHaveLength(1);
    h.controller.markReady();
    await expect(pending).resolves.toBeUndefined();
  });

  it('detached + 已 ready:直接 resolve', async () => {
    const h = makeHarness({ detached: true });
    h.controller.open();
    h.controller.markReady();
    await expect(h.controller.ensureOpenForAutomation()).resolves.toBeUndefined();
  });

  it('ready 超时 reject', async () => {
    const h = makeHarness({ detached: true });
    const pending = h.controller.ensureOpenForAutomation();
    const assertion = expect(pending).rejects.toThrow(/ready timeout/);
    vi.advanceTimersByTime(8000);
    await assertion;
  });

  it('窗口在 ready 前被关:reject', async () => {
    const h = makeHarness({ detached: true });
    const pending = h.controller.ensureOpenForAutomation();
    const assertion = expect(pending).rejects.toThrow(/closed before ready/);
    h.windows[0].emitClosed();
    await assertion;
  });
});

describe('getHostWebContents', () => {
  it('非 detached → 主窗 webContents', () => {
    const h = makeHarness();
    expect(h.controller.getHostWebContents()).toBe(h.mainWin.webContents);
  });

  it('detached + 窗口关 → 回落主窗', () => {
    const h = makeHarness({ detached: true });
    expect(h.controller.getHostWebContents()).toBe(h.mainWin.webContents);
  });

  it('detached + 窗口开 → 子窗口 webContents;关窗后回落主窗', () => {
    const h = makeHarness({ detached: true });
    h.controller.open();
    expect(h.controller.getHostWebContents()).toBe(h.windows[0].webContents);
    h.windows[0].emitClosed();
    expect(h.controller.getHostWebContents()).toBe(h.mainWin.webContents);
  });

  it('异步 closing 阶段立即排除旧子窗口 host', () => {
    const h = makeHarness({ detached: true }, { asyncClose: true });
    h.controller.open();
    h.controller.markReady();
    h.controller.close();

    expect(h.windows[0].isDestroyed()).toBe(false);
    expect(h.controller.getState().open).toBe(false);
    expect(h.controller.getSidebarWebContents()).toBeNull();
    expect(h.controller.getHostWebContents()).toBe(h.mainWin.webContents);
  });
});

describe('setContext / routeCommand', () => {
  const ctx = { sessionId: 's1', workdir: '/w', remoteHostId: null, available: true };
  const terminalRequest = (sessionId = 's1', allowOpen = true) => ({
    command: { type: 'open-terminal' as const, sessionId },
    allowOpen,
  });

  it('窗口关着:只缓存不转发;开着:转发到 context channel', () => {
    const h = makeHarness();
    h.controller.setContext(ctx);
    expect(h.sends).toHaveLength(0);
    expect(h.controller.getContext()).toEqual(ctx);

    h.controller.open();
    h.controller.setContext({ ...ctx, sessionId: 's2' });
    expect(h.sends.at(-1)).toEqual({
      channel: 'ctx-channel',
      payload: { ...ctx, sessionId: 's2' },
    });
  });

  it('attached:残留异步 closing 子窗仍返回 attached 且绝不发送', async () => {
    const h = makeHarness({ detached: true }, { asyncClose: true });
    h.controller.setContext(ctx);
    h.controller.open();
    h.controller.markReady();
    h.controller.setDetached(false);
    expect(h.windows[0].isDestroyed()).toBe(false);

    await expect(h.controller.routeCommand(terminalRequest())).resolves.toBe('attached');
    expect(h.sends.filter((entry) => entry.channel === 'cmd-channel')).toEqual([]);
  });

  it('detached + allowOpen=true:开窗等 ready 后 routed', async () => {
    const h = makeHarness({ detached: true });
    h.controller.setContext(ctx);
    const pending = h.controller.routeCommand(terminalRequest());
    expect(h.windows).toHaveLength(1);
    expect(h.sends).toHaveLength(0);
    h.controller.markReady();
    await expect(pending).resolves.toBe('routed');
    expect(h.sends.at(-1)).toEqual({
      channel: 'cmd-channel',
      payload: { type: 'open-terminal', sessionId: 's1' },
    });
  });

  it('renderer 旧 attached 镜像不影响 main 的最新 detached 裁决', async () => {
    const h = makeHarness({ detached: false });
    h.controller.setContext(ctx);
    h.controller.setDetached(true);

    const pending = h.controller.routeCommand(terminalRequest());
    h.controller.markReady();
    await expect(pending).resolves.toBe('routed');
    expect(h.sends.at(-1)).toEqual({
      channel: 'cmd-channel',
      payload: { type: 'open-terminal', sessionId: 's1' },
    });
    expect(h.sendTargets.at(-1)).toBe(h.windows[0].webContents.id);
  });

  it('detached:协同 tab 命令复用同一条 command channel', async () => {
    const h = makeHarness({ detached: true });
    h.controller.setContext(ctx);
    h.controller.open();
    h.controller.markReady();

    await h.controller.routeCommand({
      command: {
        type: 'ensure-orca-workers-tab',
        sessionId: 's1',
        focusWorkerSessionId: 'worker-s1',
        focusTab: true,
      },
      allowOpen: true,
    });
    await h.controller.routeCommand({
      command: { type: 'close-orca-workers-tab', sessionId: 's1' },
      allowOpen: false,
    });

    expect(h.sends.at(-2)).toEqual({
      channel: 'cmd-channel',
      payload: {
        type: 'ensure-orca-workers-tab',
        sessionId: 's1',
        focusWorkerSessionId: 'worker-s1',
        focusTab: true,
      },
    });
    expect(h.sends.at(-1)).toEqual({
      channel: 'cmd-channel',
      payload: { type: 'close-orca-workers-tab', sessionId: 's1' },
    });
  });

  it('context mismatch / unavailable 返回 stale-context，不开窗也不派发', async () => {
    const h = makeHarness({ detached: true });
    h.controller.setContext({ ...ctx, sessionId: 's2' });

    await expect(
      h.controller.routeCommand(terminalRequest()),
    ).resolves.toBe('stale-context');
    h.controller.setContext({ ...ctx, available: false });
    await expect(
      h.controller.routeCommand(terminalRequest()),
    ).resolves.toBe('stale-context');

    expect(h.windows).toHaveLength(0);
    expect(h.sends).toHaveLength(0);
  });

  it('等待 detached renderer ready 时 context A->B 返回 stale 且不派旧命令', async () => {
    const h = makeHarness({ detached: true });
    h.controller.setContext(ctx);
    const pending = h.controller.routeCommand(terminalRequest());
    expect(h.windows).toHaveLength(1);

    h.controller.setContext({ ...ctx, sessionId: 's2' });
    h.controller.markReady();
    await expect(pending).resolves.toBe('stale-context');
    expect(h.sends.filter((entry) => entry.channel === 'cmd-channel')).toEqual([]);
  });

  it('ready 等待期间偏好切 attached 返回 attached，不向 closing 旧 host 发送', async () => {
    const h = makeHarness({ detached: true }, { asyncClose: true });
    h.controller.setContext(ctx);
    const pending = h.controller.routeCommand(terminalRequest());
    expect(h.windows).toHaveLength(1);

    h.controller.setDetached(false);
    h.windows[0].emitClosed();
    await expect(pending).resolves.toBe('attached');
    expect(h.sends.filter((entry) => entry.channel === 'cmd-channel')).toEqual([]);
  });

  it('allowOpen=false + detached closed:queued 且不重开；同 session ready 后派发', async () => {
    const h = makeHarness({ detached: true });
    h.controller.setContext(ctx);
    const command = {
      type: 'ensure-orca-workers-tab' as const,
      sessionId: 's1',
      focusWorkerSessionId: 'worker-s1',
      focusTab: false,
    };

    await expect(
      h.controller.routeCommand({ command, allowOpen: false }),
    ).resolves.toBe('queued');
    expect(h.windows).toHaveLength(0);

    h.controller.open();
    expect(h.sends.filter((entry) => entry.channel === 'cmd-channel')).toEqual([]);
    h.controller.markReady();
    expect(h.sends.at(-1)).toEqual({ channel: 'cmd-channel', payload: command });
  });

  it('allowOpen=false + closing:不重开并排队，下一 host ready 后派发', async () => {
    const h = makeHarness({ detached: true }, { asyncClose: true });
    h.controller.setContext(ctx);
    h.controller.open();
    h.controller.markReady();
    h.controller.close();

    const command = { type: 'close-orca-workers-tab' as const, sessionId: 's1' };
    await expect(
      h.controller.routeCommand({ command, allowOpen: false }),
    ).resolves.toBe('queued');
    expect(h.windows).toHaveLength(1);
    h.windows[0].emitClosed();
    h.controller.open();
    h.controller.markReady();
    expect(h.sends.at(-1)).toEqual({ channel: 'cmd-channel', payload: command });
  });

  it('closing + terminal 快速返回 stale，不等待关窗或进入 ready timeout', async () => {
    const h = makeHarness({ detached: true }, { asyncClose: true });
    h.controller.setContext(ctx);
    h.controller.open();
    h.controller.markReady();
    h.controller.close();

    await expect(h.controller.routeCommand(terminalRequest())).resolves.toBe('stale-context');

    expect(h.windows).toHaveLength(1);
    expect(h.sends.filter((entry) => entry.channel === 'cmd-channel')).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('queued A intent 在 context 切到 B 后丢弃，不发子 host 也不转主 host', async () => {
    const h = makeHarness({ detached: true });
    h.controller.setContext(ctx);
    await h.controller.routeCommand({
      command: { type: 'close-orca-workers-tab', sessionId: 's1' },
      allowOpen: false,
    });

    h.controller.setContext({ ...ctx, sessionId: 's2' });
    h.controller.open();
    h.controller.markReady();
    expect(h.sends.filter((entry) => entry.channel === 'cmd-channel')).toEqual([]);
  });

  it('queued current-session intent 在切 attached 时交给主 renderer', async () => {
    const h = makeHarness({ detached: true });
    h.controller.setContext(ctx);
    const command = { type: 'close-orca-workers-tab' as const, sessionId: 's1' };
    await h.controller.routeCommand({ command, allowOpen: false });

    h.controller.setDetached(false);
    expect(h.sends.at(-1)).toEqual({ channel: 'cmd-channel', payload: command });
    expect(h.sendTargets.at(-1)).toBe(h.mainWin.webContents.id);
  });

  it('passive ensure 不覆盖已排队的显式 worker intent', async () => {
    const h = makeHarness({ detached: true });
    h.controller.setContext(ctx);
    const explicit = {
      type: 'ensure-orca-workers-tab' as const,
      sessionId: 's1',
      focusWorkerSessionId: 'worker-s1',
      focusTab: false,
    };
    await h.controller.routeCommand({ command: explicit, allowOpen: false });
    await h.controller.routeCommand({
      command: { type: 'ensure-orca-workers-tab', sessionId: 's1', focusTab: false },
      allowOpen: false,
    });

    h.controller.open();
    h.controller.markReady();
    expect(h.sends.at(-1)).toEqual({ channel: 'cmd-channel', payload: explicit });
  });
});
