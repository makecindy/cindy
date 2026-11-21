/**
 * 测试价值
 * - 生产入口与可观察结果:readBuddySets / saveBuddySets(手机本机、按账号)。
 *   两个账号互不串;空状态删 key(只存 override);损坏 JSON 回落到默认;写入不触碰其它 key。
 * - Bug／规则依据:docs/dev-rules/configuration-and-overrides.md §2;手机端的「伙伴集」边界
 *   「不写 bot_profiles / 不跨电脑同步」。
 * - 现有覆盖缺口:homeViewPreferenceStore.test.ts 不覆盖新前缀;buddySetsStore.ts 是新模块。
 * - 最小失败输入:两个 owner 各存一份;写入后删到空;写入损坏 JSON。
 * - tier:unit,AsyncStorage 内存 fake、无真实等待。
 */
const store = vi.hoisted(() => new Map<string, string>());
const pending = vi.hoisted(() => ({ writeGate: null as Promise<void> | null }));
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async (key: string) => store.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => {
      // Lets a test hold a write in flight and start a second save + a read.
      if (pending.writeGate) await pending.writeGate;
      store.set(key, value);
    }),
    removeItem: vi.fn(async (key: string) => { store.delete(key); }),
  },
}));

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createBuddySet, emptyBuddySets } from '@cindy/maker-shared/buddy-sets';
import { readBuddySets, saveBuddySets, __testing } from '../session/buddySetsStore';

beforeEach(() => { store.clear(); pending.writeGate = null; vi.clearAllMocks(); });

describe('mobile buddy set display preference', () => {
  it('is empty by default and stays per account', async () => {
    expect(await readBuddySets('owner-a')).toEqual(emptyBuddySets());
    await saveBuddySets('owner-a', createBuddySet(emptyBuddySets(), 'set-1', 'A'));
    expect((await readBuddySets('owner-a')).sets[0]!.name).toBe('A');
    expect(await readBuddySets('owner-b')).toEqual(emptyBuddySets());
  });

  it('never persists for an account-less session', async () => {
    await saveBuddySets('', createBuddySet(emptyBuddySets(), 'set-1', 'A'));
    expect(await readBuddySets('')).toEqual(emptyBuddySets());
    expect(store.size).toBe(0);
  });

  it('removes the key when the state returns to the default (override only)', async () => {
    const key = __testing.prefix + 'owner-a';
    await saveBuddySets('owner-a', createBuddySet(emptyBuddySets(), 'set-1', 'A'));
    expect(store.has(key)).toBe(true);
    await saveBuddySets('owner-a', emptyBuddySets());
    expect(store.has(key)).toBe(false);
  });

  it('reads only after queued writes, so a remount cannot resurrect an older record', async () => {
    let release!: () => void;
    pending.writeGate = new Promise<void>((resolve) => { release = resolve; });
    const first = saveBuddySets('owner-a', createBuddySet(emptyBuddySets(), 'set-1', 'First'));
    const second = saveBuddySets('owner-a', createBuddySet(emptyBuddySets(), 'set-1', 'Second'));
    const read = readBuddySets('owner-a');
    release();
    await Promise.all([first, second, read]);
    expect((await read).sets[0]!.name).toBe('Second');
  });

  it('reads corrupt JSON back as the default without touching other records', async () => {
    const key = __testing.prefix + 'owner-a';
    store.set(key, '{broken');
    store.set('unrelated.record', 'keep-me');
    expect(await readBuddySets('owner-a')).toEqual(emptyBuddySets());
    expect(store.get('unrelated.record')).toBe('keep-me');
  });
});
