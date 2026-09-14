// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { __testing, getSsoOrgHistory, rememberSsoOrgIdentifier } from '../ssoOrgHistory';

beforeEach(() => {
  window.localStorage.clear();
  __testing.reset();
  vi.restoreAllMocks();
});

describe('desktop SSO organization history', () => {
  it('reads the versioned record and persists MRU updates', () => {
    window.localStorage.setItem(
      __testing.storageKey,
      JSON.stringify({ version: 1, entries: ['older.example'] }),
    );
    expect(getSsoOrgHistory()).toEqual(['older.example']);
    expect(rememberSsoOrgIdentifier('new-corp')).toEqual(['new-corp', 'older.example']);
    expect(JSON.parse(window.localStorage.getItem(__testing.storageKey) ?? '{}')).toEqual({
      version: 1,
      entries: ['new-corp', 'older.example'],
    });
  });

  it('falls back to the in-memory history when localStorage throws', () => {
    rememberSsoOrgIdentifier('memory-corp');
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage unavailable');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage unavailable');
    });
    expect(getSsoOrgHistory()).toEqual(['memory-corp']);
    expect(rememberSsoOrgIdentifier('next-corp')).toEqual(['next-corp', 'memory-corp']);
  });
});
