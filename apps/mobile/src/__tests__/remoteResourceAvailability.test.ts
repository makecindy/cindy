import { describe, expect, it } from 'vitest';
import { isRemoteResourceHostOnline, readRemoteCollectionCache, writeRemoteCollectionCache } from '@/device-link/remoteResourceAvailability';

describe('remote resource availability', () => {
  it('one offline host does not disconnect other hosts', () => {
    expect(isRemoteResourceHostOnline('online', false, 4, 4)).toBe(false);
    expect(isRemoteResourceHostOnline('online', true, 4, 4)).toBe(true);
  });
  it('does not reuse a reply from an earlier connection or fabricate first-contact availability', () => {
    expect(isRemoteResourceHostOnline('online', null, 3, 4)).toBe(false);
    expect(isRemoteResourceHostOnline('online', null, undefined, 4)).toBe(false);
    expect(isRemoteResourceHostOnline('online', null, 4, 4)).toBe(true);
  });
  it('relay disconnect takes all hosted resources offline', () => {
    expect(isRemoteResourceHostOnline('reconnecting', true, 4, 4)).toBe(false);
    expect(isRemoteResourceHostOnline('stopped', true, 4, 4)).toBe(false);
  });
});

it('retains a roster across navigation but never across account generations', () => {
  const rows = [{ key: 'a:bot:writer' }] as Parameters<typeof writeRemoteCollectionCache>[2];
  readRemoteCollectionCache('account:1', 'teammates');
  writeRemoteCollectionCache('account:1', 'teammates', rows);
  expect(readRemoteCollectionCache('account:1', 'teammates')).toEqual(rows);
  expect(readRemoteCollectionCache('account:2', 'teammates')).toEqual([]);
  writeRemoteCollectionCache('account:1', 'teammates', rows);
  expect(readRemoteCollectionCache('account:2', 'teammates')).toEqual([]);
});
