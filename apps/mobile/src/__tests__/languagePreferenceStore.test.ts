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
  readLanguagePreference,
  saveLanguagePreference,
} from '@/i18n/languagePreferenceStore';

describe('languagePreferenceStore', () => {
  beforeEach(() => {
    store.clear();
    vi.clearAllMocks();
  });

  it('未存储任何值时读出 system(跟随系统)', async () => {
    await expect(readLanguagePreference()).resolves.toBe('system');
  });

  it.each(['ja', 'es', 'pt-PT', 'pt-BR'] as const)('保存具体语言 %s 后读出该语言', async (locale) => {
    await saveLanguagePreference(locale);
    await expect(readLanguagePreference()).resolves.toBe(locale);
    expect(store.get(__testing.storageKey)).toBe(locale);
  });

  it('保存 system 即删除 override(默认 + override 模型)', async () => {
    await saveLanguagePreference('ko');
    await saveLanguagePreference('system');
    expect(store.has(__testing.storageKey)).toBe(false);
    await expect(readLanguagePreference()).resolves.toBe('system');
  });

  it('存储里出现非法值时回退 system', async () => {
    store.set(__testing.storageKey, 'it');
    await expect(readLanguagePreference()).resolves.toBe('system');
  });
});
