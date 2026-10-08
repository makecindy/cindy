/**
 * agentDeviceModelMemory.test.ts
 * ---------------------------------------------------------------------------
 * 回归 state/agentDeviceModelMemory.ts(远程 Agent 的每模型档位记忆)的核心约定:
 *   1. set/get 往返 + localStorage 持久化(模拟 app 重启后恢复)
 *   2. 按电脑 / Agent / 供应商 / 模型隔离,不串到别处
 *   3. 删键 = 跟随默认;空槽不留在存储里
 *   4. 按 dataOwnerId 分区,账号之间不继承
 *   5. 读写器引用稳定;快照深拷贝
 *   6. 损坏的 localStorage 静默回退空表
 *
 * 项目 vitest env=node,无 window。沿用 providerModelMemory.test.ts 的最小 localStorage stub。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

class MemLocalStorage {
  private store = new Map<string, string>();
  getItem(k: string): string | null {
    return this.store.has(k) ? (this.store.get(k) as string) : null;
  }
  setItem(k: string, v: string): void {
    this.store.set(k, v);
  }
  removeItem(k: string): void {
    this.store.delete(k);
  }
  keys(): string[] {
    return [...this.store.keys()];
  }
}

let memStorage: MemLocalStorage;

beforeEach(() => {
  memStorage = new MemLocalStorage();
  vi.stubGlobal('window', { localStorage: memStorage });
  vi.stubGlobal('localStorage', memStorage);
  vi.resetModules();
});

async function loadModule() {
  return await import('@/state/agentDeviceModelMemory');
}

describe('agentDeviceModelMemory', () => {
  it('记下的档位 / Fast 跨重启保留', async () => {
    const before = await loadModule();
    before.setAgentDeviceModelEffort('dev-a', 'claude-code', 'anthropic', 'claude-opus-5', 'xhigh');
    before.setAgentDeviceModelFast('dev-a', 'claude-code', 'anthropic', 'claude-opus-5', true);

    vi.resetModules(); // 模拟重启:进程内缓存清空,只剩 localStorage
    const after = await loadModule();
    expect(after.getAgentDeviceModelEffort('dev-a', 'claude-code', 'anthropic', 'claude-opus-5')).toBe(
      'xhigh',
    );
    expect(after.getAgentDeviceModelFast('dev-a', 'claude-code', 'anthropic', 'claude-opus-5')).toBe(
      true,
    );
  });

  it('按电脑、Agent、供应商、模型分别记,互不影响', async () => {
    const m = await loadModule();
    m.setAgentDeviceModelEffort('dev-a', 'claude-code', 'anthropic', 'claude-opus-5', 'xhigh');
    m.setAgentDeviceModelEffort('dev-a', 'claude-code', 'anthropic', 'claude-sonnet-5', 'low');

    expect(m.getAgentDeviceModelEffort('dev-a', 'claude-code', 'anthropic', 'claude-sonnet-5')).toBe(
      'low',
    );
    expect(m.getAgentDeviceModelEffort('dev-b', 'claude-code', 'anthropic', 'claude-opus-5')).toBeUndefined();
    expect(m.getAgentDeviceModelEffort('dev-a', 'pi', 'anthropic', 'claude-opus-5')).toBeUndefined();
    expect(m.getAgentDeviceModelEffort('dev-a', 'claude-code', 'xd', 'claude-opus-5')).toBeUndefined();
  });

  it('不写进本机模型预设(providerModelMemory)', async () => {
    const m = await loadModule();
    const local = await import('@/state/providerModelMemory');
    m.setAgentDeviceModelEffort('dev-a', 'claude-code', 'anthropic', 'claude-opus-5', 'xhigh');
    expect(local.getProviderModelEffort('claude-code', 'anthropic', 'claude-opus-5')).toBeUndefined();
    expect(local.hasAnyProviderModelOverride()).toBe(false);
  });

  it('恢复推荐 = 删键;删空的槽不留在存储里', async () => {
    const m = await loadModule();
    m.setAgentDeviceModelEffort('dev-a', 'claude-code', 'anthropic', 'claude-opus-5', 'xhigh');
    m.setAgentDeviceModelFast('dev-a', 'claude-code', 'anthropic', 'claude-opus-5', true);
    m.clearAgentDeviceModelEffort('dev-a', 'claude-code', 'anthropic', 'claude-opus-5');
    expect(m.getAgentDeviceModelEffort('dev-a', 'claude-code', 'anthropic', 'claude-opus-5')).toBeUndefined();
    expect(m.getAgentDeviceModelFast('dev-a', 'claude-code', 'anthropic', 'claude-opus-5')).toBe(true);

    m.clearAgentDeviceModelFast('dev-a', 'claude-code', 'anthropic', 'claude-opus-5');
    expect(m.snapshotAgentDeviceModelMemory('dev-a')).toBeUndefined();
    expect(JSON.parse(memStorage.getItem(m.__STORAGE_KEY) ?? '{}')).toEqual({});
  });

  it('按账号分区:另一个账号读不到', async () => {
    const m = await loadModule();
    m.setAgentDeviceModelMemoryOwner('owner-1');
    m.setAgentDeviceModelEffort('dev-a', 'claude-code', 'anthropic', 'claude-opus-5', 'xhigh');
    m.setAgentDeviceModelMemoryOwner('owner-2');
    expect(m.getAgentDeviceModelEffort('dev-a', 'claude-code', 'anthropic', 'claude-opus-5')).toBeUndefined();
    m.setAgentDeviceModelMemoryOwner('owner-1');
    expect(m.getAgentDeviceModelEffort('dev-a', 'claude-code', 'anthropic', 'claude-opus-5')).toBe(
      'xhigh',
    );
    expect(memStorage.keys()).toEqual([`${m.__STORAGE_KEY}:owner-1`]);
  });

  it('读写器按电脑缓存、引用稳定,读写落到对应电脑', async () => {
    const m = await loadModule();
    const accessors = m.agentDeviceModelMemoryAccessors('dev-a');
    expect(m.agentDeviceModelMemoryAccessors('dev-a')).toBe(accessors);
    expect(m.agentDeviceModelMemoryAccessors('dev-b')).not.toBe(accessors);

    accessors.setChoice?.('codex', 'openai', 'gpt-5.6', 'medium');
    accessors.setFast('codex', 'openai', 'gpt-5.6', true);
    expect(accessors.getEffort('codex', 'openai', 'gpt-5.6')).toBe('medium');
    expect(m.getAgentDeviceModelFast('dev-a', 'codex', 'openai', 'gpt-5.6')).toBe(true);
    expect(m.agentDeviceModelMemoryAccessors('dev-b').getEffort('codex', 'openai', 'gpt-5.6')).toBeUndefined();
  });

  it('快照是深拷贝,形状与 providerModelMemory 的来源槽一致', async () => {
    const m = await loadModule();
    m.setAgentDeviceModelEffort('dev-a', 'claude-code', 'anthropic', 'claude-opus-5', 'xhigh');
    const snapshot = m.snapshotAgentDeviceModelMemory('dev-a');
    expect(snapshot).toEqual({
      'claude-code:anthropic': {
        effortByModel: { 'claude-opus-5': 'xhigh' },
        fastByModel: {},
        thinkingByModel: {},
      },
    });
    snapshot!['claude-code:anthropic']!.effortByModel['claude-opus-5'] = 'low';
    expect(m.getAgentDeviceModelEffort('dev-a', 'claude-code', 'anthropic', 'claude-opus-5')).toBe(
      'xhigh',
    );
  });

  it('localStorage 内容损坏时静默回退空表', async () => {
    memStorage.setItem('xdt:agentDeviceModelMemory:v1', '{not json');
    const m = await loadModule();
    expect(m.getAgentDeviceModelEffort('dev-a', 'claude-code', 'anthropic', 'claude-opus-5')).toBeUndefined();
    m.setAgentDeviceModelEffort('dev-a', 'claude-code', 'anthropic', 'claude-opus-5', 'high');
    expect(m.getAgentDeviceModelEffort('dev-a', 'claude-code', 'anthropic', 'claude-opus-5')).toBe('high');
  });
});
