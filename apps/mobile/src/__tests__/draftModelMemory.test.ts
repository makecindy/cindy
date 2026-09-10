/**
 * draftModelMemory 单测:AsyncStorage 往返、sanitize 脏数据、per-(device, agent, provider, model)
 * 隔离、同值短路、hydrate 幂等。node env,AsyncStorage 用 mock(对齐 newSessionPreferenceStore 先例)。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

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

// useSyncExternalStore 仅 hook 导出用到;单测只走非 hook API,mock 掉 react 以保持 node 纯净。
vi.mock('react', () => ({ useSyncExternalStore: vi.fn() }));

async function load() {
  const mod = await import('@/session/draftModelMemory');
  mod.__resetForTest();
  return mod;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('draftModelMemory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    store.clear();
  });

  it('写入 → 内存立即可读,并 fire-and-forget 落盘;hydrate 后跨「冷启动」恢复', async () => {
    const mod = await load();
    await mod.hydrateDraftModelMemory();
    const mem = mod.draftModelMemoryFor('devA');
    mem.setEffort('codex', 'openai', 'gpt-5.5', 'xhigh');
    mem.setFast('codex', 'openai', 'gpt-5.5', true);
    expect(mem.getEffort('codex', 'openai', 'gpt-5.5')).toBe('xhigh');
    expect(mem.getFast('codex', 'openai', 'gpt-5.5')).toBe(true);
    await flush(); // 等 fire-and-forget setItem 落盘

    // 模拟冷启动:重置内存态,仅剩 AsyncStorage → hydrate 后恢复。
    mod.__resetForTest();
    const cold = mod.draftModelMemoryFor('devA');
    expect(cold.getEffort('codex', 'openai', 'gpt-5.5')).toBeUndefined();
    await mod.hydrateDraftModelMemory();
    expect(cold.getEffort('codex', 'openai', 'gpt-5.5')).toBe('xhigh');
    expect(cold.getFast('codex', 'openai', 'gpt-5.5')).toBe(true);
  });

  it('per-(device, agent, provider, model) 四维隔离,互不串', async () => {
    const mod = await load();
    await mod.hydrateDraftModelMemory();
    const a = mod.draftModelMemoryFor('devA');
    const b = mod.draftModelMemoryFor('devB');
    a.setEffort('codex', 'xd', 'gpt-5.5', 'high');
    expect(b.getEffort('codex', 'xd', 'gpt-5.5')).toBeUndefined(); // 跨设备
    expect(a.getEffort('claude-code', 'xd', 'gpt-5.5')).toBeUndefined(); // 跨 agent(xd 同服两 agent)
    expect(a.getEffort('codex', 'openai', 'gpt-5.5')).toBeUndefined(); // 跨来源
    expect(a.getEffort('codex', 'xd', 'gpt-5.4')).toBeUndefined(); // 跨模型
  });

  it('同值写入短路(不触发落盘)', async () => {
    const mod = await load();
    await mod.hydrateDraftModelMemory();
    const AsyncStorage = (await import('@react-native-async-storage/async-storage')).default;
    const mem = mod.draftModelMemoryFor('devA');
    mem.setEffort('codex', 'openai', 'gpt-5.5', 'high');
    const writes = vi.mocked(AsyncStorage.setItem).mock.calls.length;
    mem.setEffort('codex', 'openai', 'gpt-5.5', 'high');
    expect(vi.mocked(AsyncStorage.setItem).mock.calls.length).toBe(writes);
  });

  it('sanitize:落盘脏数据(非 string effort / 非 boolean fast / 空槽)静默丢弃', async () => {
    store.set(
      'xdtm:draftModelMemory:v1',
      JSON.stringify({
        devA: {
          'codex:openai': {
            effortByModel: { 'gpt-5.5': 'high', bad: 42 },
            fastByModel: { 'gpt-5.5': true, bad: 'yes' },
          },
          'codex:empty': { effortByModel: {}, fastByModel: {} },
        },
        '': { 'codex:x': { effortByModel: { m: 'low' }, fastByModel: {} } },
      }),
    );
    const mod = await load();
    await mod.hydrateDraftModelMemory();
    const mem = mod.draftModelMemoryFor('devA');
    expect(mem.getEffort('codex', 'openai', 'gpt-5.5')).toBe('high');
    expect(mem.getEffort('codex', 'openai', 'bad')).toBeUndefined();
    expect(mem.getFast('codex', 'openai', 'gpt-5.5')).toBe(true);
    expect(mem.getFast('codex', 'openai', 'bad')).toBeUndefined();
  });

  it('损坏 JSON → 静默回退空表(不抛)', async () => {
    store.set('xdtm:draftModelMemory:v1', '{oops');
    const mod = await load();
    await expect(mod.hydrateDraftModelMemory()).resolves.toBeUndefined();
    expect(mod.draftModelMemoryFor('devA').getEffort('codex', 'openai', 'gpt-5.5')).toBeUndefined();
  });

  it('deviceId 空 → 全 no-op / undefined', async () => {
    const mod = await load();
    await mod.hydrateDraftModelMemory();
    const mem = mod.draftModelMemoryFor('');
    mem.setEffort('codex', 'openai', 'gpt-5.5', 'high');
    expect(mem.getEffort('codex', 'openai', 'gpt-5.5')).toBeUndefined();
  });
});


it('reset deletes persisted overrides, retains other devices, and preserves values on a failed write', async () => {
  store.clear();
  const mod = await load(); await mod.hydrateDraftModelMemory();
  const mem = mod.draftModelMemoryFor('a'); const other = mod.draftModelMemoryFor('b');
  mem.setEffort('codex', 'api', 'm', 'high'); mem.setFast('codex', 'api', 'm', true);
  other.setEffort('codex', 'api', 'm', 'low');
  const storage = (await import('@react-native-async-storage/async-storage')).default;
  vi.mocked(storage.setItem).mockRejectedValueOnce(new Error('disk-full'));
  await expect(mem.reset!('codex', 'api', 'm')).rejects.toThrow('disk-full');
  expect(mem.getEffort('codex', 'api', 'm')).toBe('high');
  await mem.reset!('codex', 'api', 'm');
  mod.__resetForTest(); await mod.hydrateDraftModelMemory();
  expect(mem.getEffort('codex', 'api', 'm')).toBeUndefined();
  expect(mem.getFast('codex', 'api', 'm')).toBeUndefined();
  expect(other.getEffort('codex', 'api', 'm')).toBe('low');
});
