// @vitest-environment jsdom
/**
 * 测试价值
 * - 生产入口与可观察结果:readBuddySets / writeBuddySets(本机、按账号的展示偏好)。
 *   写入只落自己的 key,不改动任何伙伴资料(BotProfile)数据;切换账号读不到别人的集。
 * - Bug／规则依据:docs/dev-rules/configuration-and-overrides.md §2「只存 override」;
 *   本功能边界「不写 bot_profiles / 不改伙伴运行时」。
 * - 现有覆盖缺口:teammatesSectionPrefs.test.ts 只覆盖收起/视图/头像条;buddySetsPrefs.ts 是新模块。
 * - 最小失败输入:两个账号各写一个集;种子写入一个 BotProfile 形状的 key 后写集;写入损坏 JSON。
 * - tier:unit(jsdom,localStorage),纯同步、无真实等待。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { createBuddySet, emptyBuddySets, assignBuddyToSet } from '@cindy/maker-shared/buddy-sets';
import { readBuddySets, writeBuddySets } from '../buddySetsPrefs';

beforeEach(() => localStorage.clear());

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
});
