// @vitest-environment jsdom
/**
 * 测试价值
 * - 生产入口与可观察结果:useBuddySets + buddySetsPrefs + sidebarOwnerStorage。断言读取失败时
 *   不写盘、恢复后编辑保留原记录,两个窗口挂载时保存不覆盖另一窗口的新集,storage 事件刷新界面,
 *   写入失败保持未保存状态并可重试。
 * - Bug／规则依据:docs/dev-rules/engineering-conventions.md §8.2「读取失败时不开放写入／持久化提交后才回复成功」;
 *   PR #11701 的两条 P1 与写失败回传界面 P2。
 * - 现有覆盖缺口:buddySetsPrefs.test.ts 只测同步 prefs;teammatesSection.test.tsx 不经过真实 hook。
 * - 最小失败输入:owner authority reader 返回 null;两个 hook 共享一个 localStorage;损坏 owner claim 使写入失败。
 * - tier:unit(jsdom,localStorage,React hook),纯同步、无真实等待。
 * - 实测耗时:1.76s(单独运行该文件,含 vitest 启动;用例本身 22ms)。
 */
import { cleanup, renderHook, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBuddySet, emptyBuddySets, serializeBuddySets, type BuddySetsState } from '@cindy/maker-shared/buddy-sets';
import { __testing } from '@/lib/sidebarOwnerStorage';
import { buddySetsStorageKey, readBuddySets } from '../buddySetsPrefs';

const h = vi.hoisted(() => ({ owner: 'owner-a' as string | null }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ dataOwnerId: h.owner }) }));

import { useBuddySets } from '../useBuddySets';

type BuddySetsStatus = 'ready' | 'error' | 'unavailable';
type Change = (current: BuddySetsState) => BuddySetsState;
type HookResult = readonly [BuddySetsState, (change: Change) => void, BuddySetsStatus, () => void, boolean, () => void];

const tuple = (result: { current: unknown }): HookResult => result.current as unknown as HookResult;
const authority = (ownerId: string) => ({
  dataOwnerId: ownerId,
  ownerGeneration: 0,
  claimed: true,
  canInitialize: true,
  pinnedLegacyConsumed: false,
});

beforeEach(() => {
  localStorage.clear();
  __testing.setOwnerAuthorityReader(null);
  h.owner = 'owner-a';
});

afterEach(() => {
  cleanup();
  __testing.setOwnerAuthorityReader(null);
  localStorage.clear();
});

describe('desktop buddy-set hook', () => {
  it('gates writes on a confirmed read and keeps the original record', () => {
    const original = createBuddySet(emptyBuddySets(), 'set-existing', 'Existing');
    const key = buddySetsStorageKey('owner-a');
    __testing.setOwnerAuthorityReader(authority);
    localStorage.setItem(key, serializeBuddySets(original));

    __testing.setOwnerAuthorityReader(() => null);
    const view = renderHook(() => useBuddySets());
    expect(tuple(view.result)[2]).toBe('error');
    expect(tuple(view.result)[0]).toEqual(emptyBuddySets());

    act(() => tuple(view.result)[1]((current) => createBuddySet(current, 'set-lost', 'Lost')));
    expect(localStorage.getItem(key)).toBe(serializeBuddySets(original));

    __testing.setOwnerAuthorityReader(authority);
    act(() => tuple(view.result)[3]());
    expect(tuple(view.result)[2]).toBe('ready');
    expect(tuple(view.result)[0]).toEqual(original);

    act(() => tuple(view.result)[1]((current) => createBuddySet(current, 'set-added', 'Added')));
    expect(readBuddySets('owner-a').sets.map((set) => set.buddySetId)).toEqual(['set-existing', 'set-added']);
  });

  it('applies a stale window change to the latest stored record', () => {
    const first = renderHook(() => useBuddySets());
    const second = renderHook(() => useBuddySets());

    act(() => tuple(first.result)[1]((current) => createBuddySet(current, 'set-a', 'A')));
    expect(tuple(second.result)[0]).toEqual(emptyBuddySets());

    act(() => tuple(second.result)[1]((current) => createBuddySet(current, 'set-b', 'B')));
    expect(readBuddySets('owner-a').sets.map((set) => set.buddySetId)).toEqual(['set-a', 'set-b']);
    expect(tuple(second.result)[0].sets.map((set) => set.buddySetId)).toEqual(['set-a', 'set-b']);
  });

  it('refreshes another mounted window from its storage event', () => {
    const first = renderHook(() => useBuddySets());
    const second = renderHook(() => useBuddySets());
    const key = buddySetsStorageKey('owner-a');

    act(() => tuple(first.result)[1]((current) => createBuddySet(current, 'set-a', 'A')));
    act(() => window.dispatchEvent(new StorageEvent('storage', {
      key,
      newValue: localStorage.getItem(key),
      storageArea: localStorage,
    })));

    expect(tuple(second.result)[0].sets.map((set) => set.buddySetId)).toEqual(['set-a']);
  });

  it('keeps a failed write unsaved until an explicit retry succeeds', () => {
    const view = renderHook(() => useBuddySets());
    const key = buddySetsStorageKey('owner-a');

    localStorage.setItem(__testing.OWNER_CLAIM_KEY, '{broken');
    act(() => tuple(view.result)[1]((current) => createBuddySet(current, 'set-new', 'New')));
    expect(tuple(view.result)[4]).toBe(true);
    expect(tuple(view.result)[0]).toEqual(emptyBuddySets());
    expect(localStorage.getItem(key)).toBeNull();

    localStorage.removeItem(__testing.OWNER_CLAIM_KEY);
    act(() => tuple(view.result)[5]());
    expect(tuple(view.result)[4]).toBe(false);
    expect(readBuddySets('owner-a').sets.map((set) => set.buddySetId)).toEqual(['set-new']);
  });

  it('keeps a pending retry through a transient read failure', () => {
    const view = renderHook(() => useBuddySets());
    localStorage.setItem(__testing.OWNER_CLAIM_KEY, '{broken');
    act(() => tuple(view.result)[1]((current) => createBuddySet(current, 'set-new', 'New')));
    expect(tuple(view.result)[4]).toBe(true);

    __testing.setOwnerAuthorityReader(() => null);
    act(() => tuple(view.result)[1]((current) => createBuddySet(current, 'set-other', 'Other')));
    expect(tuple(view.result)[2]).toBe('error');
    expect(tuple(view.result)[4]).toBe(true);

    __testing.setOwnerAuthorityReader(authority);
    localStorage.removeItem(__testing.OWNER_CLAIM_KEY);
    act(() => tuple(view.result)[3]());
    expect(tuple(view.result)[2]).toBe('ready');
    act(() => tuple(view.result)[5]());
    expect(readBuddySets('owner-a').sets.map((set) => set.buddySetId)).toEqual(['set-new']);
  });

  it('never persists or reports a failure for an account-less session', () => {
    h.owner = null;
    const view = renderHook(() => useBuddySets());
    expect(tuple(view.result)[2]).toBe('unavailable');
    act(() => tuple(view.result)[1]((current) => createBuddySet(current, 'set-new', 'New')));
    expect(localStorage.length).toBe(0);
    expect(tuple(view.result)[0]).toEqual(emptyBuddySets());
    expect(tuple(view.result)[4]).toBe(false);
  });
});
