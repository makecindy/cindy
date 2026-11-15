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
  APP_ICON_NATIVE_NAMES,
  APP_ICON_STORAGE_KEY,
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
    expect(normalizeAppIconChoice('unknown')).toBe('default');
    expect(normalizeAppIconChoice('default')).toBe('default');
    expect(normalizeAppIconChoice('cat')).toBe('cat');
    expect(normalizeAppIconChoice('wordmark')).toBe('wordmark');
    expect(normalizeAppIconChoice('mark')).toBe('mark');
  });

  it('四个选项与原生命名一一对应', () => {
    expect(nativeNameForAppIcon('default')).toBeNull();
    expect(nativeNameForAppIcon('cat')).toBe(APP_ICON_NATIVE_NAMES.cat);
    expect(nativeNameForAppIcon('wordmark')).toBe(APP_ICON_NATIVE_NAMES.wordmark);
    expect(nativeNameForAppIcon('mark')).toBe(APP_ICON_NATIVE_NAMES.mark);

    expect(appIconFromNativeName(null)).toBe('default');
    expect(appIconFromNativeName('AppIcon-Other')).toBe('default');
    expect(appIconFromNativeName(APP_ICON_NATIVE_NAMES.cat)).toBe('cat');
    expect(appIconFromNativeName(APP_ICON_NATIVE_NAMES.wordmark)).toBe('wordmark');
    expect(appIconFromNativeName(APP_ICON_NATIVE_NAMES.mark)).toBe('mark');
  });

  it('选择会持久化，恢复默认会清掉覆盖', async () => {
    await writeAppIconPreference('cat');
    expect(store.get(APP_ICON_STORAGE_KEY)).toBe('cat');
    await expect(readAppIconPreference()).resolves.toBe('cat');

    await writeAppIconPreference('mark');
    await expect(readAppIconPreference()).resolves.toBe('mark');

    await writeAppIconPreference('default');
    expect(store.has(APP_ICON_STORAGE_KEY)).toBe(false);
    await expect(readAppIconPreference()).resolves.toBe('default');
  });

  it('存储读失败时按默认处理，写失败向上抛出', async () => {
    vi.mocked(AsyncStorage.getItem).mockRejectedValueOnce(new Error('disk gone'));
    await expect(readAppIconPreference()).resolves.toBe('default');

    vi.mocked(AsyncStorage.setItem).mockRejectedValueOnce(new Error('disk full'));
    await expect(writeAppIconPreference('cat')).rejects.toThrow('disk full');
  });
});
