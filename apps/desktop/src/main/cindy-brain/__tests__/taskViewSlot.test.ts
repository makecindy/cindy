/** taskViewSlot.test — 任务页开页槽(taskView)的假 deps 单测。 */
// - 生产入口与可观察结果:GhostTaskViewSlot.handleRequest 的回执与广播载荷。
// - Bug / 规则依据:插件请求在任务右侧栏打开自己的任务页;落点任务要回给插件绑定;
//   peek 只回答落点、不开页签(整页管理页没有当前任务时不显示「在当前任务中打开」)。
// - 现有覆盖缺口:新槽。最小失败输入:未声明 taskView、sessionId 形状非法、无任务可落。
// - tier:unit。
import { describe, expect, it, vi } from 'vitest';

import type { InstalledGhost } from '../../../shared/ghost';
import { broadcastTaskViewOpen, GhostTaskViewSlot, type TaskViewSlotDeps } from '../taskViewSlot';
import { GhostErrandSlot } from '../errandSlot';

function taskGhost(options: { taskView?: boolean; enabled?: boolean; instanceKey?: string } = {}): InstalledGhost {
  return {
    manifest: {
      schemaVersion: 3,
      id: 'sim',
      name: 'Simulator',
      version: '1.0.0',
      kind: 'chip',
      entry: 'main.js',
      ...(options.taskView !== false ? { taskView: { html: 'task.html' } } : {}),
    },
    dir: '/fake/sim',
    enabled: options.enabled ?? true,
    ...(options.instanceKey ? { instanceKey: options.instanceKey } : {}),
  } as InstalledGhost;
}

function makeSlot(overrides: Partial<TaskViewSlotDeps> = {}) {
  const pushes: unknown[] = [];
  const deps: TaskViewSlotDeps = {
    getGhost: () => taskGhost(),
    broadcast: vi.fn((payload) => {
      pushes.push(payload);
      return true;
    }),
    focusedSessionId: () => 'focused-session',
    consumeUserGesture: () => true,
    ...overrides,
  };
  return { slot: new GhostTaskViewSlot(deps), pushes };
}

describe('taskViewSlot', () => {
  // PR #6939 discussion_r4357789335：focus 不能把插件自报布尔值当作真实点击。
  // unit：复用派活手势账本，最小输入为无手势/过期/其他实例/已消费票据。
  it('requires a fresh, one-shot host gesture for the requesting plugin instance', () => {
    let now = 0;
    const gestures = new GhostErrandSlot({ getGhost: () => taskGhost(), now: () => now });
    const consumeUserGesture = vi.fn((id: string) => gestures.consumeUserGesture(id));
    const { slot, pushes } = makeSlot({ consumeUserGesture });
    const reveal = vi.fn();
    slot.setRevealSession(reveal);
    const denied = { ok: false, errorCode: 'PERMISSION_DENIED' };
    expect(slot.handleRequest('sim', { focus: true })).toMatchObject(denied);
    gestures.noteUserGesture('other');
    expect(slot.handleRequest('sim', { focus: true })).toMatchObject(denied);
    gestures.noteUserGesture('sim');
    now = 3_000;
    expect(slot.handleRequest('sim', { focus: true })).toMatchObject(denied);
    expect(pushes).toEqual([]);
    expect(reveal).not.toHaveBeenCalled();
    gestures.noteUserGesture('sim');
    const consumed = consumeUserGesture.mock.calls.length;
    slot.handleRequest('sim', { peek: true, focus: true });
    slot.handleRequest('sim', { focus: false });
    expect(consumeUserGesture).toHaveBeenCalledTimes(consumed);
    expect(slot.handleRequest('sim', { focus: true })).toMatchObject({ ok: true, focusRequested: true });
    expect(slot.handleRequest('sim', { focus: true })).toMatchObject(denied);
    expect(reveal).toHaveBeenCalledExactlyOnceWith('focused-session');
  });

  // 主视图的显式跳转须同时导航任务与打开页签；原测试只覆盖后台开页。
  // 最小输入：focus:true；unit，缺省/peek 不抢前台，投递失败不导航。
  it('focus explicitly reveals the same task, while old requests and peek remain passive', () => {
    const { slot, pushes } = makeSlot();
    const reveal = vi.fn();
    expect(slot.handleRequest('sim', { sessionId: 'task-1', focus: true })).toMatchObject({
      ok: false,
      errorCode: 'HOST_NOT_READY',
    });
    slot.setRevealSession(reveal);
    for (const request of [{}, { focus: false }, { peek: true, focus: true }])
      slot.handleRequest('sim', request);
    expect(reveal).not.toHaveBeenCalled();
    expect(slot.handleRequest('sim', { sessionId: 'task-1', focus: true })).toEqual({
      ok: true,
      sessionId: 'task-1',
      focusRequested: true,
    });
    expect(reveal).toHaveBeenCalledExactlyOnceWith('task-1');
    expect(pushes.at(-1)).toEqual({ instanceId: 'sim', sessionId: 'task-1', focus: true });
    expect(slot.handleRequest('sim', { focus: 'true' })).toMatchObject({
      ok: false,
      errorCode: 'INVALID_REQUEST',
    });
    const failed = makeSlot({ broadcast: () => false }).slot;
    const failedReveal = vi.fn();
    failed.setRevealSession(failedReveal);
    expect(failed.handleRequest('sim', { focus: true })).toMatchObject({
      ok: false,
      errorCode: 'HOST_NOT_READY',
    });
    expect(failedReveal).not.toHaveBeenCalled();
  });

  // PR #6861 discussion_r4353708280：原有 broadcast=false 用例绕过了真实选窗适配器。
  // 最小失败输入：只有隐藏沙箱，或主窗正在重载；unit，验证回执及实际投递目标。
  it.each(['absent', 'loading', 'destroyed-contents', 'crashed', 'closed', 'send-failed', 'ready'] as const)(
    'only reports delivery when a main renderer can consume it: %s',
    (state) => {
      const window = (url: string, main = false) => ({
        isDestroyed: () => main && state === 'closed',
        webContents: {
          getURL: () => url,
          isDestroyed: () => main && state === 'destroyed-contents',
          isLoadingMainFrame: () => main && state === 'loading',
          isCrashed: () => main && state === 'crashed',
        },
      });
      const auxiliary = [
        window('cindy-ghost://sim/__boot__'),
        window('file:///app/index.html?secondaryWindow=1#/cc-agent'),
        window('file:///app/index.html?sidebarWindow=1#/sidebar-window'),
        window('file:///app/index.html?view=voice-input-overlay'),
        window('about:blank'),
      ];
      const main = window('file:///app/index.html#/cc-agent', true);
      const windows = state === 'absent' ? auxiliary : [...auxiliary, main];
      const sent = vi.fn(() => {
        if (state === 'send-failed') throw new Error('window closed during delivery');
      });
      const { slot } = makeSlot({
        broadcast: (payload) => broadcastTaskViewOpen(
          windows as Parameters<typeof broadcastTaskViewOpen>[0], payload, sent,
        ),
      });
      expect(slot.handleRequest('sim', {})).toMatchObject(
        state === 'ready' ? { ok: true, sessionId: 'focused-session' } : { ok: false, errorCode: 'HOST_NOT_READY' },
      );
      expect(sent.mock.calls).toEqual(state === 'ready' || state === 'send-failed'
        ? [[main, { instanceId: 'sim', sessionId: 'focused-session' }]] : []);
    },
  );

  it('opens in the requested task, or the focused task, and reports where it landed', () => {
    const { slot, pushes } = makeSlot();
    expect(slot.handleRequest('sim', { type: 'task-view-request', sessionId: 'task-1' })).toEqual({ ok: true, sessionId: 'task-1' });
    expect(slot.handleRequest('sim', { type: 'task-view-request' })).toEqual({ ok: true, sessionId: 'focused-session' });
    expect(pushes).toEqual([
      { instanceId: 'sim', sessionId: 'task-1' },
      { instanceId: 'sim', sessionId: 'focused-session' },
    ]);
  });

  it('addresses the exact plugin instance, so a namespaced copy opens its own page', () => {
    const { slot, pushes } = makeSlot({ getGhost: () => taskGhost({ instanceKey: '_ns__acme__sim' }) });
    expect(slot.handleRequest('_ns__acme__sim', {}).ok).toBe(true);
    expect(pushes).toEqual([{ instanceId: '_ns__acme__sim', sessionId: 'focused-session' }]);
  });

  it('peek reports where a task page would open without opening one', () => {
    const { slot, pushes } = makeSlot();
    expect(slot.handleRequest('sim', { peek: true })).toEqual({ ok: true, sessionId: 'focused-session' });
    expect(makeSlot({ focusedSessionId: () => null }).slot.handleRequest('sim', { peek: true })).toMatchObject({ ok: false, errorCode: 'HOST_NOT_READY' });
    expect(slot.handleRequest('sim', { peek: 'yes' })).toMatchObject({ ok: false, errorCode: 'INVALID_REQUEST' });
    expect(makeSlot({ getGhost: () => taskGhost({ taskView: false }) }).slot.handleRequest('sim', { peek: true })).toMatchObject({ ok: false, errorCode: 'PERMISSION_DENIED' });
    expect(pushes).toEqual([]);
  });

  it('refuses plugins without a task page, malformed task ids, and having nowhere to land', () => {
    expect(makeSlot({ getGhost: () => taskGhost({ taskView: false }) }).slot.handleRequest('sim', {})).toMatchObject({ ok: false, errorCode: 'PERMISSION_DENIED' });
    expect(makeSlot({ getGhost: () => taskGhost({ enabled: false }) }).slot.handleRequest('sim', {})).toMatchObject({ ok: false, errorCode: 'PERMISSION_DENIED' });
    expect(makeSlot().slot.handleRequest('sim', { sessionId: '../x' })).toMatchObject({ ok: false, errorCode: 'INVALID_REQUEST' });
    expect(makeSlot({ focusedSessionId: () => null }).slot.handleRequest('sim', {})).toMatchObject({ ok: false, errorCode: 'HOST_NOT_READY' });
    expect(makeSlot({ broadcast: () => false }).slot.handleRequest('sim', {})).toMatchObject({ ok: false, errorCode: 'HOST_NOT_READY' });
  });
});
