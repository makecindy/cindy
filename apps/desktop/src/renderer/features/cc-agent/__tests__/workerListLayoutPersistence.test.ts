// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';

import { readStoredWorkerListLayout } from '../RolePillDropdown';

const KEY = 'orca-worker-list-layout-v1';

describe('readStoredWorkerListLayout default-layout fallback', () => {
  afterEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it('returns tabs when no key is stored', () => {
    expect(readStoredWorkerListLayout()).toBe('tabs');
  });

  it('keeps tabs when a stored tabs preference exists', () => {
    window.localStorage.setItem(KEY, 'tabs');
    expect(readStoredWorkerListLayout()).toBe('tabs');
  });

  it('keeps dropdown when a stored dropdown preference exists', () => {
    window.localStorage.setItem(KEY, 'dropdown');
    expect(readStoredWorkerListLayout()).toBe('dropdown');
  });

  it('falls back to tabs when reading localStorage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage read failed');
    });
    expect(readStoredWorkerListLayout()).toBe('tabs');
  });

  it('falls back to tabs on an invalid stored value', () => {
    window.localStorage.setItem(KEY, 'bogus');
    expect(readStoredWorkerListLayout()).toBe('tabs');
  });
});
