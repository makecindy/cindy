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

import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  APP_ICON_STORAGE_KEY,
  WORDMARK_ICON_NAME,
  appIconFromNativeName,
  nativeNameForAppIcon,
  normalizeAppIconChoice,
  readAppIconPreference,
  writeAppIconPreference,
} from '@/settings/appIconPreference';

describe('appIconPreference', () => {
  beforeEach(() => {
    store.clear();
    vi.clearAllMocks();
  });

  it('未知值一律回落默认图标', () => {
    expect(normalizeAppIconChoice(undefined)).toBe('default');
    expect(normalizeAppIconChoice(null)).toBe('default');
    expect(normalizeAppIconChoice('cat')).toBe('default');
    expect(normalizeAppIconChoice('wordmark')).toBe('wordmark');
  });

  it('原生名称与偏好值一一对应', () => {
    expect(nativeNameForAppIcon('default')).toBeNull();
    expect(nativeNameForAppIcon('wordmark')).toBe(WORDMARK_ICON_NAME);
    expect(appIconFromNativeName(null)).toBe('default');
    expect(appIconFromNativeName('AppIcon-Other')).toBe('default');
    expect(appIconFromNativeName(WORDMARK_ICON_NAME)).toBe('wordmark');
  });

  it('选择 wordmark 会持久化，恢复默认会清掉覆盖', async () => {
    await writeAppIconPreference('wordmark');
    expect(store.get(APP_ICON_STORAGE_KEY)).toBe('wordmark');
    await expect(readAppIconPreference()).resolves.toBe('wordmark');

    await writeAppIconPreference('default');
    expect(store.has(APP_ICON_STORAGE_KEY)).toBe(false);
    await expect(readAppIconPreference()).resolves.toBe('default');
  });

  it('存储读失败时按默认处理，写失败向上抛出', async () => {
    vi.mocked(AsyncStorage.getItem).mockRejectedValueOnce(new Error('disk gone'));
    await expect(readAppIconPreference()).resolves.toBe('default');

    vi.mocked(AsyncStorage.setItem).mockRejectedValueOnce(new Error('disk full'));
    await expect(writeAppIconPreference('wordmark')).rejects.toThrow('disk full');
  });
});
