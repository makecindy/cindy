/**
 * remoteAgentModelMemory：手机为另一台电脑单独记的 effort / Fast。
 *
 * 测试价值
 * - 生产入口与可观察结果：remoteAgentModelMemoryFor 的读写。选择器关掉、进程内缓存清掉后，
 *   同一台电脑的同一模型仍读回原来的档位和 Fast；别的电脑、本机 draftModelMemory 和其他账号读不到。
 *   恢复推荐后读回 undefined。
 * - Bug／规则依据：model-selector-unified.md 远程行档位按电脑单独记，重新打开已选来源保留
 *   思考档与 Fast；恢复推荐删除 override。移动端此前只放在当次打开的临时 Map 里。
 * - 现有覆盖缺口：draftModelMemory 只覆盖被控电脑自己的草稿，没有远程电脑这层，也不会防止
 *   hydrate 之前的删除把磁盘旧值救回来。
 * - 最小失败输入：给 devA 的一个模型写下 high / ultrafast，清掉内存后 hydrate；或在 hydrate 前 clear。
 * - tier：unit。纯内存和 AsyncStorage mock，不渲染组件。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { accountVaultKey } from '@cindy/auth-client';
import { __testing as authTesting, setMobileAuthOwner } from '@/auth/authOwnerGeneration';
import { __STORAGE_KEY as DRAFT_STORAGE_KEY, draftModelMemoryFor } from '@/session/draftModelMemory';
import {
  __flushForTest,
  __resetForTest,
  __storageKeyFor,
  hydrateRemoteAgentModelMemory,
  remoteAgentModelMemoryFor,
} from '@/session/remoteAgentModelMemory';

const store = vi.hoisted(() => new Map<string, string>());

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async (key: string) => store.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    removeItem: vi.fn(async (key: string) => {
      store.delete(key);
    }),
  },
}));

vi.mock('react', () => ({ useSyncExternalStore: vi.fn() }));

describe('remoteAgentModelMemory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    store.clear();
    authTesting.reset();
    __resetForTest();
  });

  it('记下的档位和 Fast 清掉内存后再 hydrate 仍然在,后写的 effort 不会冲掉 ultrafast', async () => {
    const memory = remoteAgentModelMemoryFor('dev-a');
    memory.setFast('codex', 'openai', 'gpt-6', 'ultrafast');
    memory.setEffort('codex', 'openai', 'gpt-6', 'high');
    await __flushForTest();
    __resetForTest();
    await hydrateRemoteAgentModelMemory();
    const restored = remoteAgentModelMemoryFor('dev-a');
    expect(restored.getEffort('codex', 'openai', 'gpt-6')).toBe('high');
    expect(restored.getFast('codex', 'openai', 'gpt-6')).toBe('ultrafast');
  });

  it('按电脑、agent、供应商、模型分开记,并且不写进本机草稿记忆', async () => {
    const memory = remoteAgentModelMemoryFor('dev-a');
    memory.setEffort('codex', 'xd', 'gpt-6', 'high');
    memory.setFast('codex', 'xd', 'gpt-6', true);
    await __flushForTest();

    expect(remoteAgentModelMemoryFor('dev-b').getEffort('codex', 'xd', 'gpt-6')).toBeUndefined();
    expect(memory.getEffort('claude-code', 'xd', 'gpt-6')).toBeUndefined();
    expect(memory.getEffort('codex', 'openai', 'gpt-6')).toBeUndefined();
    expect(memory.getEffort('codex', 'xd', 'gpt-6-mini')).toBeUndefined();
    expect(draftModelMemoryFor('dev-a').getEffort('codex', 'xd', 'gpt-6')).toBeUndefined();
    expect([...store.keys()]).toEqual([__storageKeyFor('')]);
    expect([...store.keys()].some((key) => key.includes(DRAFT_STORAGE_KEY))).toBe(false);
  });

  it('按账号分开,换账号读不到上一账号为同一台电脑记的档位', async () => {
    setMobileAuthOwner('account-a');
    remoteAgentModelMemoryFor('dev-a').setEffort('codex', 'openai', 'gpt-6', 'xhigh');
    await __flushForTest();

    setMobileAuthOwner('account-b');
    expect(remoteAgentModelMemoryFor('dev-a').getEffort('codex', 'openai', 'gpt-6')).toBeUndefined();
    await hydrateRemoteAgentModelMemory();
    expect(remoteAgentModelMemoryFor('dev-a').getEffort('codex', 'openai', 'gpt-6')).toBeUndefined();

    setMobileAuthOwner('account-a');
    // 同一进程切回来,这份还在内存里。冷启动(清掉缓存)后要等灌入磁盘才读得到。
    expect(remoteAgentModelMemoryFor('dev-a').getEffort('codex', 'openai', 'gpt-6')).toBe('xhigh');
    __resetForTest();
    expect(remoteAgentModelMemoryFor('dev-a').getEffort('codex', 'openai', 'gpt-6')).toBeUndefined();
    await hydrateRemoteAgentModelMemory();
    expect(remoteAgentModelMemoryFor('dev-a').getEffort('codex', 'openai', 'gpt-6')).toBe('xhigh');
    expect([...store.keys()]).toEqual([__storageKeyFor(accountVaultKey('global', 'account-a'))]);
  });

  it('恢复推荐删掉对应键;删空后存储里不再留这台电脑', async () => {
    const memory = remoteAgentModelMemoryFor('dev-a');
    memory.setEffort('codex', 'openai', 'gpt-6', 'high');
    memory.setFast('codex', 'openai', 'gpt-6', true);
    memory.clearEffort!('codex', 'openai', 'gpt-6');
    expect(memory.getEffort('codex', 'openai', 'gpt-6')).toBeUndefined();
    expect(memory.getFast('codex', 'openai', 'gpt-6')).toBe(true);

    memory.clearFast!('codex', 'openai', 'gpt-6');
    await __flushForTest();
    expect(JSON.parse(store.get(__storageKeyFor('')) ?? 'null')).toEqual({});
  });

  it('hydrate 之前删除,不会在灌入磁盘时把旧档位救回来', async () => {
    remoteAgentModelMemoryFor('dev-a').setEffort('codex', 'openai', 'gpt-6', 'high');
    await __flushForTest();
    __resetForTest();
    remoteAgentModelMemoryFor('dev-a').clearEffort!('codex', 'openai', 'gpt-6');
    await __flushForTest();
    __resetForTest();
    await hydrateRemoteAgentModelMemory();
    expect(remoteAgentModelMemoryFor('dev-a').getEffort('codex', 'openai', 'gpt-6')).toBeUndefined();
  });

  it('损坏的存储和空 deviceId 都不抛,空 deviceId 不落盘', async () => {
    store.set(__storageKeyFor(''), '{oops');
    __resetForTest();
    await expect(hydrateRemoteAgentModelMemory()).resolves.toBeUndefined();
    expect(remoteAgentModelMemoryFor('dev-a').getEffort('codex', 'openai', 'gpt-6')).toBeUndefined();
    expect(store.get(__storageKeyFor(''))).toBe('{oops');

    const ignored = remoteAgentModelMemoryFor('');
    ignored.setEffort('codex', 'openai', 'gpt-6', 'high');
    ignored.clearEffort!('codex', 'openai', 'gpt-6');
    await __flushForTest();
    expect(ignored.getEffort('codex', 'openai', 'gpt-6')).toBeUndefined();
    expect(store.get(__storageKeyFor(''))).toBe('{oops');
  });
});
