import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/i18n', () => ({ i18n: { t: (key: string) => key } }));
import { isAsyncStorageFullError, withAsyncStorageFullRecovery } from '@/session/asyncStorageFull';

const FULL = new Error('database or disk is full (code 13 SQLITE_FULL)');
const data = new Map<string, string>();
const base = {
  getAllKeys: vi.fn(async () => [...data.keys()]),
  getItem: vi.fn(async (key: string) => data.get(key) ?? null),
  setItem: vi.fn(async (key: string, value: string) => { data.set(key, value); }),
  removeItem: vi.fn(async (key: string) => { data.delete(key); }),
};
const reclaim = vi.fn(async () => {});
const storage = withAsyncStorageFullRecovery(base, reclaim);

beforeEach(() => { data.clear(); vi.clearAllMocks(); });
describe('AsyncStorage full recovery', () => {
  it('recognizes Android SQLITE_FULL messages only', () => {
    expect(isAsyncStorageFullError(FULL)).toBe(true);
    expect(isAsyncStorageFullError(new Error('database is locked'))).toBe(false);
    expect(isAsyncStorageFullError(null)).toBe(false);
  });
  it('reclaims rebuildable caches and retries the write once', async () => {
    base.setItem.mockRejectedValueOnce(FULL);
    await storage.setItem('outbox', 'record');
    expect(reclaim).toHaveBeenCalledOnce();
    expect(data.get('outbox')).toBe('record');
  });
  it('reports a readable error when the retry is still full', async () => {
    base.setItem.mockRejectedValueOnce(FULL).mockRejectedValueOnce(FULL);
    await expect(storage.setItem('outbox', 'record')).rejects.toMatchObject({
      message: 'session.screen.localStorageFull', cause: FULL,
    });
    expect(data.has('outbox')).toBe(false);
  });
  it('still retries when reclaiming fails', async () => {
    base.setItem.mockRejectedValueOnce(FULL);
    reclaim.mockRejectedValueOnce(new Error('enumerate failed'));
    await storage.setItem('outbox', 'record');
    expect(data.get('outbox')).toBe('record');
  });
  it('passes other write failures through without reclaiming', async () => {
    const locked = new Error('database is locked');
    base.setItem.mockRejectedValueOnce(locked);
    await expect(storage.setItem('outbox', 'record')).rejects.toBe(locked);
    expect(reclaim).not.toHaveBeenCalled();
    expect(base.setItem).toHaveBeenCalledOnce();
  });
});
