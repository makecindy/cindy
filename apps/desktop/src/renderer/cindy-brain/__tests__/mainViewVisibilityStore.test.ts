import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __testing as ownerGenerationTesting,
  getDataOwnerGeneration,
  setDataOwnerGeneration,
} from '@/contexts/dataOwnerGeneration';
import {
  __testing as ownerStorageTesting,
  sidebarOwnerStorageKey,
} from '@/lib/sidebarOwnerStorage';
import {
  __testing,
  readMainViewSidebarVisible,
  writeMainViewSidebarVisible,
} from '../mainViewVisibilityStore';

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
  setDataOwnerGeneration('owner-a', 4);
  ownerStorageTesting.setOwnerAuthorityReader((ownerId) =>
    ownerId === 'owner-a'
      ? {
          dataOwnerId: ownerId,
          ownerGeneration: 4,
          claimed: true,
          canInitialize: true,
          pinnedLegacyConsumed: false,
        }
      : null,
  );
});

afterEach(() => {
  __testing.reset();
  ownerStorageTesting.setOwnerAuthorityReader(null);
  ownerGenerationTesting.reset();
  vi.unstubAllGlobals();
});

describe('main-view sidebar visibility', () => {
  it('defaults unknown and malformed values to visible', () => {
    expect(readMainViewSidebarVisible('owner-a', 'workspace')).toBe(true);
    const scopedKey = sidebarOwnerStorageKey(__testing.storageKey('workspace'), 'owner-a');
    localStorage.setItem(scopedKey, 'broken');
    expect(readMainViewSidebarVisible('owner-a', 'workspace')).toBe(true);
  });

  it('persists only explicit hidden and removes it when restoring the default', () => {
    const owner = getDataOwnerGeneration();
    const scopedKey = sidebarOwnerStorageKey(__testing.storageKey('workspace'), 'owner-a');

    expect(writeMainViewSidebarVisible(owner, 'workspace', false)).toBe(true);
    expect(localStorage.getItem(scopedKey)).toBe('false');
    expect(readMainViewSidebarVisible('owner-a', 'workspace')).toBe(false);

    expect(writeMainViewSidebarVisible(owner, 'workspace', true)).toBe(true);
    expect(localStorage.getItem(scopedKey)).toBeNull();
    expect(readMainViewSidebarVisible('owner-a', 'workspace')).toBe(true);
  });

  it('rejects writes captured before an owner-generation boundary', () => {
    const staleOwner = getDataOwnerGeneration();
    setDataOwnerGeneration('owner-a', 5);

    expect(writeMainViewSidebarVisible(staleOwner, 'workspace', false)).toBe(false);
    expect(
      localStorage.getItem(sidebarOwnerStorageKey(__testing.storageKey('workspace'), 'owner-a')),
    ).toBeNull();
  });

  it('keeps the same plugin preference isolated between data owners', () => {
    expect(writeMainViewSidebarVisible(getDataOwnerGeneration(), 'workspace', false)).toBe(true);

    setDataOwnerGeneration('owner-b', 7);
    ownerStorageTesting.setOwnerAuthorityReader((ownerId) =>
      ownerId === 'owner-a'
        ? {
            dataOwnerId: ownerId,
            ownerGeneration: 4,
            claimed: true,
            canInitialize: true,
            pinnedLegacyConsumed: false,
          }
        : ownerId === 'owner-b'
          ? {
              dataOwnerId: ownerId,
              ownerGeneration: 7,
              claimed: false,
              canInitialize: false,
              pinnedLegacyConsumed: false,
            }
          : null,
    );

    expect(readMainViewSidebarVisible('owner-a', 'workspace')).toBe(false);
    expect(readMainViewSidebarVisible('owner-b', 'workspace')).toBe(true);
    expect(writeMainViewSidebarVisible(getDataOwnerGeneration(), 'workspace', false)).toBe(true);
    expect(readMainViewSidebarVisible('owner-a', 'workspace')).toBe(false);
    expect(readMainViewSidebarVisible('owner-b', 'workspace')).toBe(false);
  });
});
