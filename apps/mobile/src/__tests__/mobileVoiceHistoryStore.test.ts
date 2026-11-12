import { beforeEach, describe, expect, it, vi } from 'vitest';
import { formatVoiceInputHistoryContext } from '@cindy/voice-input-core';
import { setSecureItem } from '@/auth/secureStorage';

const secureItems = vi.hoisted(() => new Map<string, string>());

vi.mock('@/auth/secureStorage', () => ({
  getSecureItem: vi.fn(async (key: string) => secureItems.get(key) ?? null),
  setSecureItem: vi.fn(async (key: string, value: string) => {
    secureItems.set(key, value);
  }),
  deleteSecureItem: vi.fn(async (key: string) => {
    secureItems.delete(key);
  }),
}));

describe('mobileVoiceHistoryStore', () => {
  beforeEach(() => {
    secureItems.clear();
  });

  it('records submitted mobile voice text newest-first per controlled host', async () => {
    const {
      getMobileVoiceInputHistoryForHost,
      recordMobileVoiceInputHistoryForHost,
    } = await import('@/session/mobileVoiceHistoryStore');

    const firstId = await recordMobileVoiceInputHistoryForHost('host-a', ' first phrase ');
    const secondId = await recordMobileVoiceInputHistoryForHost('host-a', 'second\nphrase');
    const otherHostId = await recordMobileVoiceInputHistoryForHost('host-b', 'other host');

    expect(firstId).toMatch(/^voice-/);
    expect(secondId).toMatch(/^voice-/);
    expect(otherHostId).toMatch(/^voice-/);

    await expect(getMobileVoiceInputHistoryForHost('host-a')).resolves.toEqual([
      'second phrase',
      'first phrase',
    ]);
    await expect(getMobileVoiceInputHistoryForHost('host-b')).resolves.toEqual(['other host']);
  });

  it('dedupes repeat text without moving it ahead of newer entries', async () => {
    const {
      getMobileVoiceInputHistoryForHost,
      recordMobileVoiceInputHistoryForHost,
    } = await import('@/session/mobileVoiceHistoryStore');

    const firstId = await recordMobileVoiceInputHistoryForHost('host-a', 'first phrase');
    await recordMobileVoiceInputHistoryForHost('host-a', 'second phrase');
    const duplicateId = await recordMobileVoiceInputHistoryForHost('host-a', 'first phrase');

    await expect(getMobileVoiceInputHistoryForHost('host-a')).resolves.toEqual([
      'second phrase',
      'first phrase',
    ]);
    expect(duplicateId).toBe(firstId);
  });

  it('updates the submitted raw ASR history entry with refined text like desktop voice input', async () => {
    const {
      getMobileVoiceInputHistoryForHost,
      recordMobileVoiceInputHistoryForHost,
      updateMobileVoiceInputHistoryEntryForHost,
    } = await import('@/session/mobileVoiceHistoryStore');

    const firstId = await recordMobileVoiceInputHistoryForHost('host-a', 'older phrase');
    const rawId = await recordMobileVoiceInputHistoryForHost('host-a', 'raw asr words');
    await updateMobileVoiceInputHistoryEntryForHost('host-a', rawId!, ' refined words ');

    await expect(getMobileVoiceInputHistoryForHost('host-a')).resolves.toEqual([
      'refined words',
      'older phrase',
    ]);
    expect(firstId).not.toBe(rawId);
  });

  it('compacts at the shared character budget and persists a stable prefix after compaction', async () => {
    const {
      MAX_MOBILE_VOICE_HISTORY_ITEM_CHARS,
      getMobileVoiceInputHistoryForHost,
      recordMobileVoiceInputHistoryForHost,
    } = await import('@/session/mobileVoiceHistoryStore');

    for (let index = 0; index < 32; index += 1) {
      await recordMobileVoiceInputHistoryForHost('host-a', `entry ${index}`.padEnd(360, 'x'));
    }
    await recordMobileVoiceInputHistoryForHost('host-a', ` ${'x'.repeat(MAX_MOBILE_VOICE_HISTORY_ITEM_CHARS + 20)} `);

    const history = await getMobileVoiceInputHistoryForHost('host-a');
    const before = formatVoiceInputHistoryContext(history.map((text) => ({ text })));
    expect(before.length).toBeLessThanOrEqual(8000);
    expect(history.length).toBeLessThanOrEqual(40);
    expect(history[0]).toHaveLength(MAX_MOBILE_VOICE_HISTORY_ITEM_CHARS);
    expect(history[1]).toBe('entry 31'.padEnd(360, 'x'));
    expect(history).not.toContain('entry 0'.padEnd(360, 'x'));
    await recordMobileVoiceInputHistoryForHost('host-a', '下一句');
    const after = await getMobileVoiceInputHistoryForHost('host-a');
    expect(formatVoiceInputHistoryContext(after.map((text) => ({ text })))).toBe(`${before}\n- 下一句`);
  });

  it('retains more than 100 short phrases without shifting the history prefix', async () => {
    const { recordMobileVoiceInputHistoryForHost, getMobileVoiceInputHistoryForHost } = await import('@/session/mobileVoiceHistoryStore');
    for (let i = 0; i < 105; i += 1) await recordMobileVoiceInputHistoryForHost('host-a', `entry ${i}`);
    const history = await getMobileVoiceInputHistoryForHost('host-a');
    expect(history).toHaveLength(105);
    expect(history.at(-1)).toBe('entry 0');
  });

  it('clears all recorded host histories on logout', async () => {
    const {
      __testing,
      clearAllMobileVoiceInputHistories,
      getMobileVoiceInputHistoryForHost,
      recordMobileVoiceInputHistoryForHost,
    } = await import('@/session/mobileVoiceHistoryStore');

    await recordMobileVoiceInputHistoryForHost('host-a', 'first phrase');
    await recordMobileVoiceInputHistoryForHost('host-b', 'second phrase');
    await clearAllMobileVoiceInputHistories();

    await expect(getMobileVoiceInputHistoryForHost('host-a')).resolves.toEqual([]);
    await expect(getMobileVoiceInputHistoryForHost('host-b')).resolves.toEqual([]);
    expect(secureItems.has(__testing.storageIndexKey)).toBe(false);
  });

  it('preserves legacy entries and imports a desktop snapshot only once across reloads', async () => {
    const { __testing, getMobileVoiceInputHistoryForHost, recordMobileVoiceInputHistoryForHost } = await import('@/session/mobileVoiceHistoryStore');
    const legacy = Array.from({ length: 4 }, (_, i) => ({ id: `local-${i}`, text: `local ${i}`.padEnd(360, 'l'), createdAt: i + 1 }));
    secureItems.set(__testing.storageKeyForHostDevice('host-a'), JSON.stringify(legacy));
    const desktop = Array.from({ length: 30 }, (_, i) => `desktop ${i}`.padEnd(360, 'd'));
    const first = await getMobileVoiceInputHistoryForHost('host-a', desktop);
    const prefix = formatVoiceInputHistoryContext(first.map((text) => ({ text })));
    expect(prefix.length).toBeLessThanOrEqual(8000);
    expect(first.slice(0, 4)).toEqual(legacy.map((entry) => entry.text));
    const persisted = JSON.parse(secureItems.get(__testing.storageKeyForHostDevice('host-a'))!);
    expect(Array.isArray(persisted)).toBe(true);
    expect(persisted[0].id).toBe('local-0');
    await recordMobileVoiceInputHistoryForHost('host-a', '新手机语音');
    vi.resetModules();
    const reloaded = await import('@/session/mobileVoiceHistoryStore');
    const second = await reloaded.getMobileVoiceInputHistoryForHost('host-a', desktop);
    expect(formatVoiceInputHistoryContext(second.map((text) => ({ text })))).toBe(`${prefix}\n- 新手机语音`);
    const changed = await reloaded.getMobileVoiceInputHistoryForHost('host-a', ['新的桌面术语', ...desktop]);
    expect(changed).toContain('新的桌面术语');
    await reloaded.clearAllMobileVoiceInputHistories();
    expect(secureItems.has(__testing.storageKeyForHostDevice('host-a'))).toBe(false);
    expect(secureItems.has(__testing.snapshotKeyForHostDevice('host-a'))).toBe(false);
  });

  it('retains imported history when an older bundle reads and appends to the v1 array', async () => {
    const { __testing, getMobileVoiceInputHistoryForHost } = await import('@/session/mobileVoiceHistoryStore');
    await getMobileVoiceInputHistoryForHost('host-a', ['desktop phrase']);
    const key = __testing.storageKeyForHostDevice('host-a');
    const parsed = JSON.parse(secureItems.get(key)!);
    // Previous bundles reject any non-array value and overwrite it on recording.
    const legacyEntries = Array.isArray(parsed) ? parsed : [];
    expect(legacyEntries.map((entry) => entry.text)).toEqual(['desktop phrase']);
    secureItems.set(key, JSON.stringify([
      { id: 'voice-older-bundle', text: 'recorded after rollback', createdAt: 2 },
      ...legacyEntries,
    ]));
    await expect(getMobileVoiceInputHistoryForHost('host-a', ['desktop phrase'])).resolves.toEqual([
      'recorded after rollback', 'desktop phrase',
    ]);
  });

  it('recovers the development object format into a rollback-readable array on write', async () => {
    const { __testing, getMobileVoiceInputHistoryForHost, recordMobileVoiceInputHistoryForHost } = await import('@/session/mobileVoiceHistoryStore');
    const key = __testing.storageKeyForHostDevice('host-a');
    const desktopSnapshot = JSON.stringify(['desktop phrase']);
    secureItems.set(key, JSON.stringify({
      entries: [{ id: 'desktop-0', text: 'desktop phrase', createdAt: 1 }], desktopSnapshot,
    }));
    await recordMobileVoiceInputHistoryForHost('host-a', 'new phrase');
    expect(Array.isArray(JSON.parse(secureItems.get(key)!))).toBe(true);
    expect(secureItems.get(__testing.snapshotKeyForHostDevice('host-a'))).toBe(desktopSnapshot);
    await expect(getMobileVoiceInputHistoryForHost('host-a', ['desktop phrase'])).resolves.toEqual(['new phrase', 'desktop phrase']);
  });

  it('preserves history when the snapshot marker write fails and retries the import safely', async () => {
    const { __testing, getMobileVoiceInputHistoryForHost } = await import('@/session/mobileVoiceHistoryStore');
    vi.mocked(setSecureItem)
      .mockImplementationOnce(async (key, value) => { secureItems.set(key, value); })
      .mockImplementationOnce(async (key, value) => { secureItems.set(key, value); })
      .mockRejectedValueOnce(new Error('marker write failed'));
    await expect(getMobileVoiceInputHistoryForHost('host-a', ['desktop phrase'])).resolves.toEqual(['desktop phrase']);
    expect(JSON.parse(secureItems.get(__testing.storageKeyForHostDevice('host-a'))!)[0].text).toBe('desktop phrase');
    expect(secureItems.has(__testing.snapshotKeyForHostDevice('host-a'))).toBe(false);
    await expect(getMobileVoiceInputHistoryForHost('host-a', ['desktop phrase'])).resolves.toEqual(['desktop phrase']);
    expect(secureItems.get(__testing.snapshotKeyForHostDevice('host-a'))).toBe(JSON.stringify(['desktop phrase']));
  });

  it('ignores a stale or corrupt snapshot marker when importing history', async () => {
    const { __testing, getMobileVoiceInputHistoryForHost, recordMobileVoiceInputHistoryForHost } = await import('@/session/mobileVoiceHistoryStore');
    await recordMobileVoiceInputHistoryForHost('host-a', 'local phrase');
    secureItems.set(__testing.snapshotKeyForHostDevice('host-a'), 'corrupt');
    await expect(getMobileVoiceInputHistoryForHost('host-a', ['desktop phrase'])).resolves.toEqual(['local phrase', 'desktop phrase']);
  });

  it('keeps newly synced desktop phrases ahead of old ones when the merged history compacts', async () => {
    const { getMobileVoiceInputHistoryForHost, recordMobileVoiceInputHistoryForHost } = await import('@/session/mobileVoiceHistoryStore');
    const desktop = Array.from({ length: 29 }, (_, i) => `desktop ${i}`.padEnd(360, 'd'));
    await getMobileVoiceInputHistoryForHost('host-a', desktop);
    for (let i = 0; i < 3; i += 1) await recordMobileVoiceInputHistoryForHost('host-a', `local ${i}`.padEnd(360, 'l'));
    const newest = 'NEW desktop'.padEnd(360, 'n');
    const history = await getMobileVoiceInputHistoryForHost('host-a', [newest, ...desktop]);
    expect(history[3]).toBe(newest);
    expect(history[4]).toBe(desktop[0]);
    expect(formatVoiceInputHistoryContext(history.map((text) => ({ text }))).length).toBeLessThanOrEqual(8000);
  });

  it('keeps recording available when persisting the imported snapshot fails', async () => {
    const { getMobileVoiceInputHistoryForHost } = await import('@/session/mobileVoiceHistoryStore');
    vi.mocked(setSecureItem).mockRejectedValueOnce(new Error('storage unavailable'));
    await expect(getMobileVoiceInputHistoryForHost('host-a', ['桌面术语'])).resolves.toEqual(['桌面术语']);
  });
});
