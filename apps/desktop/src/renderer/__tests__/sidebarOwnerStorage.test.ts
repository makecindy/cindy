import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __testing,
  clearClaimedLegacySidebarStorage,
  readClaimedLegacySidebarStorage,
  readSidebarOwnerStorage,
  sidebarOwnerStorageKey,
  writeSidebarOwnerStorage,
} from '@/lib/sidebarOwnerStorage';

class MemStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return Array.from(this.values.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, String(value));
  }
}

beforeEach(() => {
  vi.stubGlobal('localStorage', new MemStorage());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('sidebar owner-scoped renderer storage', () => {
  it('lets only the first owner claim a legacy identity value', () => {
    localStorage.setItem('sidebar.identity', 'legacy-a');

    expect(readSidebarOwnerStorage('sidebar.identity', 'owner-a')).toBe('legacy-a');
    expect(localStorage.getItem('sidebar.identity')).toBeNull();
    expect(localStorage.getItem(sidebarOwnerStorageKey('sidebar.identity', 'owner-a'))).toBe(
      'legacy-a',
    );
    expect(readSidebarOwnerStorage('sidebar.identity', 'owner-b')).toBeNull();
  });

  it('keeps explicit owner values independent after migration', () => {
    expect(writeSidebarOwnerStorage('sidebar.identity', 'owner-a', 'a')).toBe(true);
    expect(writeSidebarOwnerStorage('sidebar.identity', 'owner-b', 'b')).toBe(true);

    expect(readSidebarOwnerStorage('sidebar.identity', 'owner-a')).toBe('a');
    expect(readSidebarOwnerStorage('sidebar.identity', 'owner-b')).toBe('b');
  });

  it('fails closed on a malformed owner claim marker', () => {
    localStorage.setItem(__testing.OWNER_CLAIM_KEY, 'broken');
    localStorage.setItem('sidebar.identity', 'legacy');

    expect(readSidebarOwnerStorage('sidebar.identity', 'owner-a')).toBeNull();
    expect(localStorage.getItem('sidebar.identity')).toBe('legacy');
  });

  it('retains legacy pinned order until main-process persistence succeeds', () => {
    localStorage.setItem('sidebar.pins', '["session-a"]');

    expect(readClaimedLegacySidebarStorage('sidebar.pins', 'owner-a')).toBe('["session-a"]');
    expect(localStorage.getItem('sidebar.pins')).toBe('["session-a"]');

    clearClaimedLegacySidebarStorage('sidebar.pins', 'owner-a');
    expect(localStorage.getItem('sidebar.pins')).toBeNull();
  });

  it('does not read or write identity state without an active owner', () => {
    localStorage.setItem('sidebar.identity', 'legacy');

    expect(readSidebarOwnerStorage('sidebar.identity', null)).toBeNull();
    expect(writeSidebarOwnerStorage('sidebar.identity', null, 'signed-out')).toBe(false);
    expect(localStorage.getItem('sidebar.identity')).toBe('legacy');
  });
});
