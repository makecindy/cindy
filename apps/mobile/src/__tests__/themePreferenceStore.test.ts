import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { accountVaultKey } from '@cindy/auth-client';
import { providerShareHostPeer, sharedTaskHostPeer, type AccountPreferencesSyncFrame } from '@cindy/device-link';
import { getMobileAuthOwner, setMobileAuthOwner } from '@/auth/authOwnerGeneration';
import {
  createMobileAccountPreferencesSync,
  mobileAccountPreferencesTesting,
} from '@/settings/accountPreferencesStore';

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
  subscribeThemePreference,
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

// Unit: actual theme read/save and peer receive/send entry points must converge
// after offline edits, resets and account switches. The old tests only cover
// device-wide storage and cannot catch account leakage or replica echo loops.
describe('account preference synchronization', () => {
  const exchanges: Array<ReturnType<typeof createMobileAccountPreferencesSync>> = [];
  beforeEach(async () => {
    setMobileAuthOwner(null);
    await mobileAccountPreferencesTesting.reset();
    store.clear();
    vi.mocked(AsyncStorage.getItem).mockImplementation(async key => store.get(key) ?? null);
    vi.mocked(AsyncStorage.setItem).mockImplementation(async (key, value) => { store.set(key, value); });
    vi.clearAllMocks();
  });
  afterEach(async () => {
    for (const exchange of exchanges) exchange.dispose();
    exchanges.length = 0;
    setMobileAuthOwner(null);
    await mobileAccountPreferencesTesting.reset();
  });

  function connect(options: { revoked?: (id: string) => boolean; current?: () => boolean } = {}) {
    const sent: Array<{ deviceId: string; frame: AccountPreferencesSyncFrame }> = [];
    const exchange = createMobileAccountPreferencesSync({
      isCurrent: options.current ?? (() => true),
      isRevoked: options.revoked ?? (() => false),
      selfDeviceId: () => 'phone',
      send: (deviceId, _channel, frame) => { sent.push({ deviceId, frame }); },
    });
    exchanges.push(exchange);
    exchange.setOnline(true);
    exchange.peer('desktop', true);
    return { exchange, sent };
  }

  function frame(fields: AccountPreferencesSyncFrame['state']['fields'] = {}, requestReply = false): AccountPreferencesSyncFrame {
    return { version: 1, dataOwnerId: 'owner', state: { version: 1, fields }, requestReply };
  }

  it('keeps defaults absent and lets the first desktop state precede one-owner legacy values', async () => {
    store.set(__testing.storageKey, 'dark');
    setMobileAuthOwner('owner');
    expect(await readThemePreference()).toBe('dark');
    const { exchange, sent } = connect();
    await exchange.receive('desktop', frame({ theme: { value: 'light', counter: 4, nodeId: 'desktop' } }));
    expect(sent[0].frame.state.fields).toEqual({});
    expect(await readThemePreference()).toBe('light');
    expect(sent.at(-1)?.frame.state.fields.language).toBeUndefined();
    expect(store.get(mobileAccountPreferencesTesting.legacyClaimKey)).toBe(getMobileAuthOwner().accountKey);

    setMobileAuthOwner('other');
    expect(await readThemePreference()).toBe('system');
    setMobileAuthOwner('owner');
    expect(await readThemePreference()).toBe('light');
  });

  it('removes a pending legacy value when the owner makes a new choice before the first peer reply', async () => {
    store.set(__testing.storageKey, 'light');
    setMobileAuthOwner('owner');
    await saveThemePreference('dark');
    const { exchange, sent } = connect();
    await exchange.receive('desktop', frame());
    expect(await readThemePreference()).toBe('dark');
    expect(sent.at(-1)?.frame.state.fields.theme).toMatchObject({ value: 'dark', counter: 1 });
    const saved = JSON.parse(store.get(mobileAccountPreferencesTesting.storageKey(getMobileAuthOwner().accountKey))!);
    expect(saved.pendingLegacy).toEqual({});
  });

  it('preserves desktop-only fields, applies incoming appearance to subscribers and stops echoing an unchanged replica', async () => {
    setMobileAuthOwner('owner');
    await readThemePreference();
    const themeChanged = vi.fn();
    const off = subscribeThemePreference(themeChanged);
    const { exchange, sent } = connect();
    const remote = frame({
      theme: { value: 'dark', counter: 5, nodeId: 'desktop' },
      'sidebar.cardMode': { value: 'card', counter: 3, nodeId: 'desktop' },
    });
    try {
      await exchange.receive('desktop', remote);
      expect(themeChanged).toHaveBeenLastCalledWith('dark');
      expect(await readThemePreference()).toBe('dark');
      expect(sent.at(-1)?.frame.state).toEqual(remote.state);
      sent.length = 0;
      await exchange.receive('desktop', remote);
      expect(sent).toEqual([]);
      await exchange.receive('desktop', { ...remote, requestReply: true });
      expect(sent).toHaveLength(1);
      expect(sent[0].frame.requestReply).toBeUndefined();

      await saveThemePreference('system');
      expect(await readThemePreference()).toBe('system');
      expect(sent.at(-1)?.frame.state.fields.theme).toMatchObject({ value: null, counter: 6 });
      expect(sent.at(-1)?.frame.state.fields['sidebar.cardMode']).toEqual(remote.state.fields['sidebar.cardMode']);
    } finally { off(); }
  });

  it('persists an offline edit and asks peers for reconciliation when the connection returns', async () => {
    setMobileAuthOwner('owner');
    await readThemePreference();
    const { exchange, sent } = connect();
    await exchange.receive('desktop', frame());
    sent.length = 0;
    exchange.setOnline(false);
    await saveThemePreference('dark');
    expect(sent).toEqual([]);
    expect(JSON.parse(store.get(mobileAccountPreferencesTesting.storageKey(getMobileAuthOwner().accountKey))!).state.fields.theme.value)
      .toBe('dark');
    exchange.setOnline(true);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].frame).toMatchObject({ dataOwnerId: 'owner', requestReply: true, state: { fields: { theme: { value: 'dark' } } } });
  });

  it('rejects unknown, offline, revoked, foreign-account and scoped sharing sources', async () => {
    setMobileAuthOwner('owner');
    await readThemePreference();
    const revoked = new Set<string>();
    let current = true;
    const { exchange, sent } = connect({ revoked: id => revoked.has(id), current: () => current });
    await exchange.receive('desktop', frame());
    sent.length = 0;
    const remote = frame({ theme: { value: 'dark', counter: 2, nodeId: 'remote' } }, true);
    for (const source of ['unknown', 'phone', sharedTaskHostPeer('task', 'host'), providerShareHostPeer('share', 'host')]) {
      if (source !== 'unknown') exchange.peer(source, true);
      await exchange.receive(source, remote);
    }
    await exchange.receive('desktop', { ...remote, dataOwnerId: 'another-owner' });
    exchange.peer('desktop', false);
    await exchange.receive('desktop', remote);
    revoked.add('desktop');
    exchange.peer('desktop', true);
    await exchange.receive('desktop', remote);
    revoked.clear();
    current = false;
    await exchange.receive('desktop', remote);
    expect(await readThemePreference()).toBe('system');
    expect(sent).toEqual([]);
  });

  it('does not apply a previous account read that finishes after the account switched', async () => {
    let resolveRead!: (value: string) => void;
    const delayed = new Promise<string>(resolve => { resolveRead = resolve; });
    const originalKey = mobileAccountPreferencesTesting.storageKey(accountVaultKey('global', 'owner'));
    vi.mocked(AsyncStorage.getItem).mockImplementation(async key => key === originalKey ? delayed : store.get(key) ?? null);
    setMobileAuthOwner('owner');
    const oldRead = readThemePreference();
    await vi.waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalledWith(mobileAccountPreferencesTesting.storageKey(getMobileAuthOwner().accountKey)));
    setMobileAuthOwner('other');
    expect(await readThemePreference()).toBe('system');
    resolveRead(JSON.stringify({ version: 1, state: frame({ theme: { value: 'dark', counter: 1, nodeId: 'old' } }).state, pendingLegacy: {} }));
    expect(await oldRead).toBe('system');
    expect(await readThemePreference()).toBe('system');
  });

  it('keeps a delayed save in its original account without repainting the next account', async () => {
    setMobileAuthOwner('owner');
    await readThemePreference();
    const originalKey = mobileAccountPreferencesTesting.storageKey(getMobileAuthOwner().accountKey);
    let finishWrite!: () => void;
    const writeHold = new Promise<void>(resolve => { finishWrite = resolve; });
    let writing = false;
    vi.mocked(AsyncStorage.setItem).mockImplementation(async (key, value) => {
      if (key === originalKey) { writing = true; await writeHold; }
      store.set(key, value);
    });
    const saving = saveThemePreference('dark');
    await vi.waitFor(() => expect(writing).toBe(true));
    setMobileAuthOwner('other');
    await saveThemePreference('light');
    finishWrite();
    await saving;
    expect(await readThemePreference()).toBe('light');
    expect(JSON.parse(store.get(originalKey)!).state.fields.theme.value).toBe('dark');
    setMobileAuthOwner('owner');
    expect(await readThemePreference()).toBe('dark');
  });

  it('preserves an unreadable future record instead of replacing it with a local default', async () => {
    setMobileAuthOwner('owner');
    const storageKey = mobileAccountPreferencesTesting.storageKey(getMobileAuthOwner().accountKey);
    store.set(storageKey, '{"version":2,"future":true}');
    expect(await readThemePreference()).toBe('system');
    await expect(saveThemePreference('dark')).rejects.toThrow('Invalid account preferences');
    expect(store.get(storageKey)).toBe('{"version":2,"future":true}');
  });
});
