/**
 * useAutomationGroupCollapsed 的持久化 store(轴 1:自动化分组文件夹开/关)。
 *
 * 默认收起(storage 无条目)、仅持久化已展开的组、收起即删除该 key、
 * 跨"重启"记忆上次展开。项目 vitest env=node 无 window,沿用 modelVisibilityPrefs 同款
 * 最小 localStorage stub。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { sidebarOwnerStorageKey } from '@/lib/sidebarOwnerStorage';

const OWNER_ID = 'owner-a';

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
  clear(): void {
    this.store.clear();
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
  return await import('@/features/cc-agent/hooks/useAutomationGroupCollapsed');
}

describe('automation group collapse store', () => {
  it('默认收起:没有条目时 isCollapsed = true', async () => {
    const { isAutomationGroupCollapsed } = await loadModule();
    expect(isAutomationGroupCollapsed('schedule:a', OWNER_ID)).toBe(true);
  });

  it('展开只影响目标组,其它组仍默认收起', async () => {
    const { isAutomationGroupCollapsed, setAutomationGroupCollapsed } = await loadModule();
    setAutomationGroupCollapsed('schedule:a', false, OWNER_ID);
    expect(isAutomationGroupCollapsed('schedule:a', OWNER_ID)).toBe(false);
    expect(isAutomationGroupCollapsed('schedule:b', OWNER_ID)).toBe(true);
    expect(isAutomationGroupCollapsed('schedule:a', 'owner-b')).toBe(true);
  });

  it('收起 = 从存储删除该 key(恢复跟随版本默认值,而非写一份静态快照)', async () => {
    const { isAutomationGroupCollapsed, setAutomationGroupCollapsed } = await loadModule();
    setAutomationGroupCollapsed('schedule:a', false, OWNER_ID);
    setAutomationGroupCollapsed('schedule:a', true, OWNER_ID);
    expect(isAutomationGroupCollapsed('schedule:a', OWNER_ID)).toBe(true);
    const raw = memStorage.getItem(
      sidebarOwnerStorageKey('cc-agent.sidebar.collapsedAutomationGroups', OWNER_ID),
    );
    expect(raw ? JSON.parse(raw) : {}).not.toHaveProperty('schedule:a');
  });

  it('记忆上次状态:模拟应用重启后仍是展开', async () => {
    const first = await loadModule();
    first.setAutomationGroupCollapsed('schedule:a', false, OWNER_ID);

    // 模拟重启:重置模块注册表,localStorage(memStorage)保留。
    vi.resetModules();
    const second = await loadModule();
    expect(second.isAutomationGroupCollapsed('schedule:a', OWNER_ID)).toBe(false);
  });

  it('旧版 collapsed:true 仍按已收起读,且不按时间过期', async () => {
    const STORAGE_KEY = 'cc-agent.sidebar.collapsedAutomationGroups';
    const ancient = new Date(Date.now() - 999 * 24 * 60 * 60 * 1000).toISOString();
    memStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ 'schedule:ancient': { collapsed: true, lastSeenAt: ancient } }),
    );

    const { isAutomationGroupCollapsed } = await loadModule();
    // 不存在年龄清理:再老的收起记录也保留,绝不"用了一阵自己弹开"。
    expect(isAutomationGroupCollapsed('schedule:ancient', OWNER_ID)).toBe(true);
  });
});
