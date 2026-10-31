import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getMobileAuthOwner, setMobileAuthOwner } from '@/auth/authOwnerGeneration';
import { createMobileAccountPreferencesSync, mobileAccountPreferencesTesting } from '@/settings/accountPreferencesStore';

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
  subscribeLanguagePreference,
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

  // Unit: the actual language store must project peer updates and durable reset
  // tombstones to mounted subscribers. Device-wide read/write tests cannot catch
  // a remote reset being lost or an incoming change creating another revision.
  it('applies a peer language once, persists a system reset and isolates another realm', async () => {
    setMobileAuthOwner('language-owner');
    await readLanguagePreference();
    const changed = vi.fn();
    const off = subscribeLanguagePreference(changed);
    const sent = vi.fn();
    const sync = createMobileAccountPreferencesSync({
      isCurrent: () => true, isRevoked: () => false, selfDeviceId: () => 'phone', send: sent,
    });
    try {
      sync.setOnline(true);
      sync.peer('desktop', true);
      await sync.receive('desktop', { version: 1, dataOwnerId: 'language-owner', state: {
        version: 1, fields: { language: { value: 'ja', counter: 8, nodeId: 'desktop' } },
      } });
      expect(await readLanguagePreference()).toBe('ja');
      expect(changed).toHaveBeenLastCalledWith('ja');
      expect(sent.mock.lastCall?.[2].state.fields.language).toEqual({ value: 'ja', counter: 8, nodeId: 'desktop' });
      await saveLanguagePreference('system');
      const record = JSON.parse(store.get(mobileAccountPreferencesTesting.storageKey(getMobileAuthOwner().accountKey))!);
      expect(record.state.fields.language).toMatchObject({ value: null, counter: 9 });
      setMobileAuthOwner('language-owner', 'cn');
      expect(await readLanguagePreference()).toBe('system');
      setMobileAuthOwner('language-owner');
      expect(await readLanguagePreference()).toBe('system');
    } finally {
      sync.dispose(); off(); setMobileAuthOwner(null);
      await mobileAccountPreferencesTesting.reset();
    }
  });
});
