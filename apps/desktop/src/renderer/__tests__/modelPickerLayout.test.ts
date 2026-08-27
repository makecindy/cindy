import { beforeEach, describe, expect, it, vi } from 'vitest';

class MemLocalStorage {
  private store = new Map<string, string>();
  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
}

let storage: MemLocalStorage;

beforeEach(() => {
  storage = new MemLocalStorage();
  vi.stubGlobal('window', { localStorage: storage });
  vi.resetModules();
});

describe('modelPickerLayout', () => {
  it('未保存偏好时默认使用样式 A', async () => {
    const { getModelPickerLayout } = await import('@/state/modelPickerLayout');
    expect(getModelPickerLayout()).toBe('classic');
  });

  it.each(['original', 'classic', 'badge'] as const)('保留用户明确选择的 %s', async (layout) => {
    storage.setItem('xdt:modelPickerLayout:v1', layout);
    const { getModelPickerLayout } = await import('@/state/modelPickerLayout');
    expect(getModelPickerLayout()).toBe(layout);
  });
});
