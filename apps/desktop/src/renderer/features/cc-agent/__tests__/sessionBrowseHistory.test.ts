/**
 * 测试价值
 * - 生产入口与可观察结果:createSessionBrowseHistory(窗口内唯一的浏览栈)与
 *   sessionIdFromPathname(路由 → 任务 id 的判定)。可观察结果是栈内容与后退/
 *   前进落到哪个任务。
 * - 规则依据:新功能「任务浏览栈」—— 后退永远落在任务视图上,同一任务
 *   重复导航不占格,走到中间再打开新任务要截断前进侧,到边界必须返回 null
 *   让按钮置灰;已删除的任务要能从栈里摘掉;换账号必须清空,不能串号。
 * - 现有覆盖缺口:新模块。
 * - 最小失败输入:record('a'); record('b'); step(-1) 之后再 record('c')。
 * - tier:unit(node,纯逻辑)。
 */

import { describe, expect, it, vi } from 'vitest';

import { createSessionBrowseHistory, sessionIdFromPathname } from '../sessionBrowseHistory';

describe('sessionIdFromPathname', () => {
  it.each([
    ['/cc-agent/session-a', 'session-a'],
    ['/cc-agent/remote:host-1', 'remote:host-1'],
  ])('takes %s as a task view', (pathname, expected) => {
    expect(sessionIdFromPathname(pathname)).toBe(expected);
  });

  it.each([
    '/cc-agent/new',
    '/cc-agent/new-dialogue',
    '/cc-agent/scheduled',
    '/cc-agent/boot',
    '/cc-agent/files/session-a',
    '/cc-agent/orca/session-a',
    '/bots/bot-1/session/session-a',
    '/settings',
  ])('keeps %s out of the stack', (pathname) => {
    expect(sessionIdFromPathname(pathname)).toBeNull();
  });
});

describe('createSessionBrowseHistory', () => {
  it('walks back and forward through visited tasks and stops at both ends', () => {
    const history = createSessionBrowseHistory();
    history.record('a');
    history.record('b');
    history.record('c');

    expect(history.step(-1)).toBe('b');
    expect(history.step(-1)).toBe('a');
    expect(history.step(-1)).toBeNull();
    expect(history.step(1)).toBe('b');
    expect(history.step(1)).toBe('c');
    expect(history.step(1)).toBeNull();
    expect(history.snapshot()).toEqual({ ids: ['a', 'b', 'c'], index: 2 });
  });

  it('does not stack the task you are already on', () => {
    const history = createSessionBrowseHistory();
    history.record('a');
    history.record('a');

    expect(history.snapshot()).toEqual({ ids: ['a'], index: 0 });
    expect(history.step(-1)).toBeNull();
  });

  it('drops the forward side once another task is opened from the middle', () => {
    const history = createSessionBrowseHistory();
    history.record('a');
    history.record('b');
    history.step(-1);

    history.record('c');

    expect(history.snapshot()).toEqual({ ids: ['a', 'c'], index: 1 });
    expect(history.step(1)).toBeNull();
    expect(history.step(-1)).toBe('a');
  });

  it('drops the oldest entry past the cap', () => {
    const history = createSessionBrowseHistory(2);
    history.record('a');
    history.record('b');
    history.record('c');

    expect(history.snapshot()).toEqual({ ids: ['b', 'c'], index: 1 });
  });

  it('notifies subscribers only when the stack or position moves', () => {
    const history = createSessionBrowseHistory();
    const listener = vi.fn();
    const unsubscribe = history.subscribe(listener);

    history.record('a');
    history.record('a');
    history.step(1);

    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    history.record('b');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('forgets a task that was deleted and keeps the cursor on a live entry', () => {
    const history = createSessionBrowseHistory();
    history.record('a');
    history.record('b');
    history.record('c');
    history.step(-1);

    history.forget('a');

    expect(history.snapshot()).toEqual({ ids: ['b', 'c'], index: 0 });
    expect(history.step(-1)).toBeNull();
    expect(history.step(1)).toBe('c');
  });

  it('drops every occurrence of a forgotten task and clamps an emptied stack', () => {
    const history = createSessionBrowseHistory();
    history.record('a');
    history.record('b');
    history.record('a');

    history.forget('a');
    expect(history.snapshot()).toEqual({ ids: ['b'], index: 0 });

    history.forget('b');
    expect(history.snapshot()).toEqual({ ids: [], index: -1 });
  });

  it('clears the stack only when the data owner changes', () => {
    const history = createSessionBrowseHistory();
    history.record('a');

    history.bindOwner('owner-1');
    expect(history.snapshot()).toEqual({ ids: [], index: -1 });

    history.record('b');
    history.bindOwner('owner-1');
    expect(history.snapshot()).toEqual({ ids: ['b'], index: 0 });

    history.bindOwner('owner-2');
    expect(history.snapshot()).toEqual({ ids: [], index: -1 });
  });

  it('keeps the snapshot identity stable between changes for useSyncExternalStore', () => {
    const history = createSessionBrowseHistory();
    history.record('a');

    expect(history.snapshot()).toBe(history.snapshot());
  });
});
