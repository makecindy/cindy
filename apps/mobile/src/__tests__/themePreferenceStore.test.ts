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

import {
  __testing,
  readThemePreference,
  resolveThemeMode,
  saveThemePreference,
} from '@/theme/themePreferenceStore';

describe('themePreferenceStore', () => {
  beforeEach(() => {
    store.clear();
    vi.clearAllMocks();
  });

  it('未存储任何值时读出 system(跟随系统)', async () => {
    await expect(readThemePreference()).resolves.toBe('system');
  });

  it('保存浅色 / 深色后读出该模式', async () => {
    await saveThemePreference('dark');
    await expect(readThemePreference()).resolves.toBe('dark');
    expect(store.get(__testing.storageKey)).toBe('dark');
  });

  it('保存 system 即删除 override(默认 + override 模型)', async () => {
    await saveThemePreference('light');
    await saveThemePreference('system');
    expect(store.has(__testing.storageKey)).toBe(false);
    await expect(readThemePreference()).resolves.toBe('system');
  });

  it('存储里出现非法值时回退 system', async () => {
    store.set(__testing.storageKey, 'sepia');
    await expect(readThemePreference()).resolves.toBe('system');
  });

  it('读失败按跟随系统处理,不阻塞启动', async () => {
    const storage = (await import('@react-native-async-storage/async-storage')).default;
    vi.mocked(storage.getItem).mockRejectedValueOnce(new Error('disk'));
    await expect(readThemePreference()).resolves.toBe('system');
  });

  it('写失败向上抛出,调用方才能提示「未保存」', async () => {
    const storage = (await import('@react-native-async-storage/async-storage')).default;
    vi.mocked(storage.setItem).mockRejectedValueOnce(new Error('disk full'));
    await expect(saveThemePreference('dark')).rejects.toThrow('disk full');
    vi.mocked(storage.removeItem).mockRejectedValueOnce(new Error('disk full'));
    await expect(saveThemePreference('system')).rejects.toThrow('disk full');
  });

  it('有效模式 = override ?? 系统外观', () => {
    expect(resolveThemeMode('system', 'dark')).toBe('dark');
    expect(resolveThemeMode('system', 'light')).toBe('light');
    expect(resolveThemeMode('system', null)).toBe('light');
    expect(resolveThemeMode('light', 'dark')).toBe('light');
    expect(resolveThemeMode('dark', 'light')).toBe('dark');
  });
});
