// @vitest-environment jsdom
/**
 * 测试价值
 * - 生产入口与可观察结果:readBuddySets / readBuddySetsResult / writeBuddySets(本机、按账号的展示偏好)。
 *   owner authority 或存储失败时读结果不是空配置,写入失败返回 false 且不落盘。
 * - Bug／规则依据:docs/dev-rules/engineering-conventions.md §8.2「读取失败时不开放写入／持久化提交后才回复成功」;
 *   docs/dev-rules/configuration-and-overrides.md §2「只存 override」;PR #11701 的两条 P1/P2。
 * - 现有覆盖缺口:teammatesSectionPrefs.test.ts 只覆盖收起/视图/头像条;原 buddySetsPrefs 用例只覆盖正常读写。
 * - 最小失败输入:种子写入一个集后把 owner authority reader 设为 null;写入前把 owner claim 设成损坏 JSON。
 * - tier:unit(jsdom,localStorage),纯同步、无真实等待。
 * - 实测耗时:1.89s(单独运行该文件,含 vitest 启动;用例本身 4ms)。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBuddySet, emptyBuddySets, assignBuddyToSet, serializeBuddySets } from '@cindy/maker-shared/buddy-sets';
import { __testing } from '@/lib/sidebarOwnerStorage';
import { buddySetsStorageKey, readBuddySets, readBuddySetsResult, writeBuddySets } from '../buddySetsPrefs';

beforeEach(() => localStorage.clear());
afterEach(() => __testing.setOwnerAuthorityReader(null));

const KEY = 'sidebar.buddySets.v1';

describe('buddy set display preference', () => {
  it('is empty by default and stays per account', () => {
    expect(readBuddySets('owner-a')).toEqual(emptyBuddySets());
    writeBuddySets('owner-a', createBuddySet(emptyBuddySets(), 'set-1', 'A'));
    expect(readBuddySets('owner-a').sets[0]!.name).toBe('A');
    expect(readBuddySets('owner-b')).toEqual(emptyBuddySets());
  });

  it('never persists for an account-less session', () => {
    writeBuddySets(null, createBuddySet(emptyBuddySets(), 'set-1', 'A'));
    expect(readBuddySets(null)).toEqual(emptyBuddySets());
    expect(localStorage.length).toBe(0);
  });

  it('reads a corrupt record back as the default and only stores overrides', () => {
    localStorage.setItem(`${KEY}.owner.owner-a`, '{broken');
    expect(readBuddySets('owner-a')).toEqual(emptyBuddySets());
    // Empty state is the derived default: writing it must not store a default blob.
    writeBuddySets('owner-a', emptyBuddySets());
    expect(localStorage.getItem(`${KEY}.owner.owner-a`)).toBe('');
  });

  it('leaves BotProfile-shaped storage untouched and keeps one buddy in one set', () => {
    const profile = { id: 'bot-1', name: 'Cindy', pinnedAt: null, hiddenAt: null };
    localStorage.setItem('botProfiles.owner.owner-a', JSON.stringify(profile));
    const withTwo = createBuddySet(createBuddySet(emptyBuddySets(), 'set-1', 'A'), 'set-2', 'B');
    const moved = assignBuddyToSet(assignBuddyToSet(withTwo, 'bot-1', 'set-1'), 'bot-1', 'set-2');
    writeBuddySets('owner-a', moved);
    expect(localStorage.getItem('botProfiles.owner.owner-a')).toBe(JSON.stringify(profile));
    const loaded = readBuddySets('owner-a');
    expect(loaded.sets.find((set) => set.buddySetId === 'set-1')!.buddyIds).toEqual([]);
    expect(loaded.sets.find((set) => set.buddySetId === 'set-2')!.buddyIds).toEqual(['bot-1']);
    expect(Object.keys(localStorage).filter((key) => key.startsWith('botProfiles'))).toEqual(['botProfiles.owner.owner-a']);
  });

  it('distinguishes an unread record from a genuinely empty one', () => {
    const original = createBuddySet(emptyBuddySets(), 'set-existing', 'Existing');
    writeBuddySets('owner-a', original);
    const blob = serializeBuddySets(original);

    __testing.setOwnerAuthorityReader(() => null);
    expect(readBuddySetsResult('owner-a')).toEqual({ status: 'error', state: emptyBuddySets() });
    expect(localStorage.getItem(buddySetsStorageKey('owner-a'))).toBe(blob);

    __testing.setOwnerAuthorityReader(null);
    expect(readBuddySetsResult('owner-a')).toEqual({ status: 'ready', state: original });
    expect(readBuddySetsResult(null).status).toBe('unavailable');
  });

  it('reports a failed write instead of pretending the record was saved', () => {
    const next = createBuddySet(emptyBuddySets(), 'set-new', 'New');
    localStorage.setItem(__testing.OWNER_CLAIM_KEY, '{broken');
    expect(writeBuddySets('owner-a', next)).toBe(false);
    expect(localStorage.getItem(buddySetsStorageKey('owner-a'))).toBeNull();
  });
});
