// @vitest-environment jsdom
/**
 * 测试价值
 * - 生产入口与可观察结果:tabGroups 的 setTabGroup / clearTabGroup / 组内激活记忆与
 *   localStorage 持久化;可观察的是页签缺省在右侧组、改组后按数据所有者分键保存、
 *   放回右侧组即删条目、另一窗口的写入经 storage 事件同步、坏数据整条丢弃。
 * - Bug / 规则依据:页签组模型(页签可移到聊天区左 / 上 / 下边)——老数据零迁移要求
 *   "没有记录 = 右侧组"。
 * - 现有覆盖缺口:新模块。
 * - 最小失败输入:setTabGroup('t1','left') 后 getTabGroup('t1')。
 * - tier:unit(jsdom localStorage + storage 事件)。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import {
  __resetTabGroupsForTest,
  clearTabGroup,
  getGroupActiveTabId,
  getTabGroup,
  getTabGroupAssignments,
  sanitizeTabGroupAssignments,
  setGroupActiveTabId,
  setTabGroup,
  subscribeTabGroups,
} from '../tabGroups';

const KEY = 'xdt:sidebarTabGroups:v1:owner-a';

beforeEach(() => {
  window.localStorage.clear();
  __resetTabGroupsForTest();
  setDataOwnerGeneration('owner-a', 1);
});

afterEach(() => {
  __resetTabGroupsForTest();
  window.localStorage.clear();
});

describe('tabGroups', () => {
  it('defaults to the right group, persists per data owner and drops entries moved back', () => {
    expect(getTabGroup('t1')).toBe('right');
    let notified = 0;
    const off = subscribeTabGroups(() => notified++);
    setTabGroup('t1', 'left');
    expect(getTabGroup('t1')).toBe('left');
    expect(JSON.parse(window.localStorage.getItem(KEY)!)).toEqual({ t1: 'left' });
    expect(notified).toBe(1);

    // 同组重复写不通知;放回右侧组 = 删条目,存储清空。
    setTabGroup('t1', 'left');
    expect(notified).toBe(1);
    setTabGroup('t1', 'right');
    expect(getTabGroup('t1')).toBe('right');
    expect(window.localStorage.getItem(KEY)).toBeNull();

    setTabGroup('t2', 'bottom');
    setDataOwnerGeneration('owner-b', 1);
    expect(getTabGroup('t2')).toBe('right');
    setDataOwnerGeneration('owner-a', 1);
    expect(getTabGroup('t2')).toBe('bottom');
    clearTabGroup('t2');
    expect(getTabGroupAssignments()).toEqual({});
    off();
  });

  it('syncs writes from another window through the storage event', () => {
    expect(getTabGroup('t9')).toBe('right');
    window.localStorage.setItem(KEY, JSON.stringify({ t9: 'top' }));
    window.dispatchEvent(new StorageEvent('storage', { key: KEY }));
    expect(getTabGroup('t9')).toBe('top');
  });

  it('keeps a per-group, per-task active memory and sanitizes persisted data', () => {
    expect(getGroupActiveTabId('left', 's1')).toBeNull();
    setGroupActiveTabId('left', 's1', 'tab-a');
    expect(getGroupActiveTabId('left', 's1')).toBe('tab-a');
    expect(getGroupActiveTabId('left', 's2')).toBeNull();
    expect(getGroupActiveTabId('bottom', 's1')).toBeNull();
    setGroupActiveTabId('left', 's1', null);
    expect(getGroupActiveTabId('left', 's1')).toBeNull();

    expect(
      sanitizeTabGroupAssignments({ a: 'left', b: 'right', c: 'nowhere', '': 'top', d: 3 }),
    ).toEqual({ a: 'left' });
    expect(sanitizeTabGroupAssignments(['left'])).toEqual({});
  });
});
