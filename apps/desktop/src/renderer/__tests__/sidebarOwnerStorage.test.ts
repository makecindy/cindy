import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __testing,
  clearClaimedLegacySidebarStorage,
  readClaimedLegacySidebarStorage,
  readSidebarOwnerStorage,
  sidebarOwnerStorageKey,
  writeSidebarOwnerStorage,
} from '@/lib/sidebarOwnerStorage';

const PROJECTS_KEY = 'cc-agent.sidebar.filter.projects';
const MANUAL_PROJECT_ORDER_KEY = 'cc-agent.sidebar.filter.manualProjectOrder';
const COLLAPSED_PROJECTS_KEY = 'cc-agent.sidebar.collapsedProjects';
const COLLAPSED_AUTOMATION_GROUPS_KEY = 'cc-agent.sidebar.collapsedAutomationGroups';
const SELECTED_MACHINES_KEY = 'cc-agent.sidebar.selectedMachines';
const PINNED_ORDER_KEY = 'cc-agent.sidebar.pinnedSessionOrder';

const OWNER_A = {
  dataOwnerId: 'owner-a',
  ownerGeneration: 1,
  claimed: true,
  canInitialize: true,
  pinnedLegacyConsumed: false,
};
const OWNER_A_CONSUMED = { ...OWNER_A, pinnedLegacyConsumed: true };
const OWNER_A_READ_ONLY = { ...OWNER_A, canInitialize: false };
const OWNER_B = {
  dataOwnerId: 'owner-b',
  ownerGeneration: 2,
  claimed: false,
  canInitialize: false,
  pinnedLegacyConsumed: false,
};

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

function readEnvelope(): unknown {
  return JSON.parse(localStorage.getItem(__testing.OWNER_CLAIM_KEY) ?? 'null');
}

beforeEach(() => {
  vi.stubGlobal('localStorage', new MemStorage());
  __testing.setOwnerAuthorityReader((ownerId) =>
    ownerId === OWNER_A.dataOwnerId ? OWNER_A : ownerId === OWNER_B.dataOwnerId ? OWNER_B : null,
  );
});

afterEach(() => {
  __testing.setOwnerAuthorityReader(null);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('sidebar owner-scoped renderer storage', () => {
  it('captures every legacy key in one compatible envelope on the first access', () => {
    localStorage.setItem(PROJECTS_KEY, '["local:/workspace/a"]');
    localStorage.setItem(MANUAL_PROJECT_ORDER_KEY, '["local:/workspace/b"]');
    localStorage.setItem(SELECTED_MACHINES_KEY, '["machine-a"]');
    localStorage.setItem(PINNED_ORDER_KEY, '["session-a"]');

    expect(readSidebarOwnerStorage(SELECTED_MACHINES_KEY, 'owner-a')).toBe('["machine-a"]');
    expect(readEnvelope()).toEqual({
      version: 1,
      ownerId: 'owner-a',
      legacy: {
        schemaVersion: 1,
        values: {
          [PROJECTS_KEY]: '["local:/workspace/a"]',
          [MANUAL_PROJECT_ORDER_KEY]: '["local:/workspace/b"]',
          [COLLAPSED_PROJECTS_KEY]: null,
          [COLLAPSED_AUTOMATION_GROUPS_KEY]: null,
          [SELECTED_MACHINES_KEY]: '["machine-a"]',
          [PINNED_ORDER_KEY]: '["session-a"]',
        },
      },
    });
    expect(localStorage.getItem(PROJECTS_KEY)).toBe('["local:/workspace/a"]');
    expect(
      localStorage.getItem(sidebarOwnerStorageKey(SELECTED_MACHINES_KEY, 'owner-a')),
    ).toBeNull();
  });

  it('keeps scoped values authoritative without materializing envelope fallbacks on read', () => {
    localStorage.setItem(PROJECTS_KEY, '["legacy"]');
    expect(readSidebarOwnerStorage(PROJECTS_KEY, 'owner-a')).toBe('["legacy"]');

    localStorage.setItem(sidebarOwnerStorageKey(PROJECTS_KEY, 'owner-a'), '');
    localStorage.setItem(PROJECTS_KEY, '["changed-by-parent-release"]');

    expect(readSidebarOwnerStorage(PROJECTS_KEY, 'owner-a')).toBe('');
    expect(readSidebarOwnerStorage(PROJECTS_KEY, 'owner-b')).toBeNull();
  });

  it('reads a published envelope without exclusivity but never initializes one', () => {
    localStorage.setItem(PROJECTS_KEY, '["legacy"]');
    expect(readSidebarOwnerStorage(PROJECTS_KEY, 'owner-a')).toBe('["legacy"]');

    __testing.setOwnerAuthorityReader((ownerId) =>
      ownerId === 'owner-a' ? OWNER_A_READ_ONLY : null,
    );
    expect(readSidebarOwnerStorage(PROJECTS_KEY, 'owner-a')).toBe('["legacy"]');

    localStorage.clear();
    localStorage.setItem(PROJECTS_KEY, '["uncaptured"]');
    expect(readSidebarOwnerStorage(PROJECTS_KEY, 'owner-a')).toBeNull();
    expect(writeSidebarOwnerStorage(PROJECTS_KEY, 'owner-a', '["scoped"]')).toBe(false);
    expect(localStorage.getItem(__testing.OWNER_CLAIM_KEY)).toBeNull();
    expect(localStorage.getItem(sidebarOwnerStorageKey(PROJECTS_KEY, 'owner-a'))).toBeNull();
    expect(localStorage.getItem(PROJECTS_KEY)).toBe('["uncaptured"]');
  });

  it('blocks a first scoped write while shared legacy ownership is unresolved', () => {
    localStorage.setItem(PROJECTS_KEY, '["legacy"]');
    __testing.setOwnerAuthorityReader((ownerId) =>
      ownerId === 'owner-a'
        ? { ...OWNER_A, claimed: false, canInitialize: false }
        : null,
    );

    expect(writeSidebarOwnerStorage(PROJECTS_KEY, 'owner-a', '["default-derived"]')).toBe(false);
    expect(localStorage.getItem(__testing.OWNER_CLAIM_KEY)).toBeNull();
    expect(localStorage.getItem(sidebarOwnerStorageKey(PROJECTS_KEY, 'owner-a'))).toBeNull();
    expect(localStorage.getItem(PROJECTS_KEY)).toBe('["legacy"]');
  });

  it('does not shadow a same-owner envelope while its durable marker is unavailable', () => {
    localStorage.setItem(PROJECTS_KEY, '["legacy"]');
    expect(readSidebarOwnerStorage(PROJECTS_KEY, 'owner-a')).toBe('["legacy"]');

    __testing.setOwnerAuthorityReader((ownerId) =>
      ownerId === 'owner-a'
        ? { ...OWNER_A, claimed: false, canInitialize: false }
        : null,
    );
    expect(readSidebarOwnerStorage(PROJECTS_KEY, 'owner-a')).toBeNull();
    expect(writeSidebarOwnerStorage(PROJECTS_KEY, 'owner-a', '["default-derived"]')).toBe(false);
    expect(localStorage.getItem(sidebarOwnerStorageKey(PROJECTS_KEY, 'owner-a'))).toBeNull();

    __testing.setOwnerAuthorityReader((ownerId) => (ownerId === 'owner-a' ? OWNER_A : null));
    expect(readSidebarOwnerStorage(PROJECTS_KEY, 'owner-a')).toBe('["legacy"]');
  });

  it('does not retain a stale root fallback when scoped state already exists', () => {
    localStorage.setItem(PROJECTS_KEY, '["stale-root"]');
    localStorage.setItem(sidebarOwnerStorageKey(PROJECTS_KEY, 'owner-a'), '["scoped"]');

    expect(readSidebarOwnerStorage(PROJECTS_KEY, 'owner-a')).toBe('["scoped"]');
    expect(readEnvelope()).toMatchObject({
      legacy: { values: { [PROJECTS_KEY]: null } },
    });
  });

  it('records absent legacy keys so downgrade-created values are never imported later', () => {
    expect(readSidebarOwnerStorage(COLLAPSED_PROJECTS_KEY, 'owner-a')).toBeNull();

    localStorage.setItem(COLLAPSED_PROJECTS_KEY, '{"local:/later":true}');

    expect(readSidebarOwnerStorage(COLLAPSED_PROJECTS_KEY, 'owner-a')).toBeNull();
    expect(readSidebarOwnerStorage(COLLAPSED_PROJECTS_KEY, 'owner-b')).toBeNull();
    expect(localStorage.getItem(COLLAPSED_PROJECTS_KEY)).toBe('{"local:/later":true}');
  });

  it('captures the full envelope before the first scoped write', () => {
    localStorage.setItem(PINNED_ORDER_KEY, '["legacy-session"]');

    expect(writeSidebarOwnerStorage(PROJECTS_KEY, 'owner-a', '"all"')).toBe(true);

    expect(readClaimedLegacySidebarStorage(PINNED_ORDER_KEY, 'owner-a')).toBe('["legacy-session"]');
    expect(localStorage.getItem(sidebarOwnerStorageKey(PROJECTS_KEY, 'owner-a'))).toBe('"all"');
  });

  it('allows every owner to persist scoped state after the first owner claims legacy data', () => {
    localStorage.setItem(PROJECTS_KEY, '["legacy-a"]');
    expect(readSidebarOwnerStorage(PROJECTS_KEY, 'owner-a')).toBe('["legacy-a"]');

    expect(writeSidebarOwnerStorage(PROJECTS_KEY, 'owner-b', '["owner-b"]')).toBe(true);
    expect(readSidebarOwnerStorage(PROJECTS_KEY, 'owner-b')).toBe('["owner-b"]');
    expect(readSidebarOwnerStorage(PROJECTS_KEY, 'owner-a')).toBe('["legacy-a"]');
  });

  it('batches routine owner authority checks within one Renderer turn', async () => {
    __testing.setOwnerAuthorityReader(null);
    localStorage.setItem(
      __testing.OWNER_CLAIM_KEY,
      JSON.stringify({
        version: 1,
        ownerId: 'owner-a',
        legacy: {
          schemaVersion: 1,
          values: Object.fromEntries(__testing.LEGACY_SIDEBAR_KEYS.map((key) => [key, null])),
        },
      }),
    );
    const claimLegacyRendererOwner = vi.fn(() => OWNER_A);
    vi.stubGlobal('window', {
      electronAPI: { sidebarSettings: { claimLegacyRendererOwner } },
    });

    expect(readSidebarOwnerStorage(PROJECTS_KEY, 'owner-a')).toBeNull();
    expect(readSidebarOwnerStorage(COLLAPSED_PROJECTS_KEY, 'owner-a')).toBeNull();
    expect(readSidebarOwnerStorage(COLLAPSED_AUTOMATION_GROUPS_KEY, 'owner-a')).toBeNull();
    expect(claimLegacyRendererOwner).toHaveBeenCalledTimes(1);

    await Promise.resolve();
    expect(readSidebarOwnerStorage(PROJECTS_KEY, 'owner-a')).toBeNull();
    expect(claimLegacyRendererOwner).toHaveBeenCalledTimes(2);
  });

  it('refreshes a cached authority when the requested owner changes in the same turn', () => {
    __testing.setOwnerAuthorityReader(null);
    localStorage.setItem(
      __testing.OWNER_CLAIM_KEY,
      JSON.stringify({
        version: 1,
        ownerId: 'owner-a',
        legacy: {
          schemaVersion: 1,
          values: Object.fromEntries(__testing.LEGACY_SIDEBAR_KEYS.map((key) => [key, null])),
        },
      }),
    );
    localStorage.setItem(sidebarOwnerStorageKey(PROJECTS_KEY, 'owner-b'), '["owner-b"]');
    const claimLegacyRendererOwner = vi
      .fn()
      .mockReturnValueOnce(OWNER_A)
      .mockReturnValueOnce(OWNER_B);
    vi.stubGlobal('window', {
      electronAPI: { sidebarSettings: { claimLegacyRendererOwner } },
    });

    expect(readSidebarOwnerStorage(PROJECTS_KEY, 'owner-a')).toBeNull();
    expect(readSidebarOwnerStorage(PROJECTS_KEY, 'owner-b')).toBe('["owner-b"]');
    expect(claimLegacyRendererOwner).toHaveBeenCalledTimes(2);
  });

  it('does not reuse a cached authority after a fresh commit fence fails', () => {
    __testing.setOwnerAuthorityReader(null);
    localStorage.setItem(PROJECTS_KEY, '["legacy"]');
    const noOwner = {
      dataOwnerId: null,
      ownerGeneration: 2,
      claimed: false,
      canInitialize: false,
      pinnedLegacyConsumed: false,
    };
    const claimLegacyRendererOwner = vi
      .fn()
      .mockReturnValueOnce(OWNER_A)
      .mockReturnValueOnce(OWNER_A)
      .mockReturnValue(noOwner);
    vi.stubGlobal('window', {
      electronAPI: { sidebarSettings: { claimLegacyRendererOwner } },
    });

    expect(readSidebarOwnerStorage(PROJECTS_KEY, 'owner-a')).toBeNull();
    expect(readEnvelope()).toMatchObject({ version: 1, ownerId: 'owner-a' });
    expect(readSidebarOwnerStorage(PROJECTS_KEY, 'owner-a')).toBeNull();
    expect(claimLegacyRendererOwner).toHaveBeenCalledTimes(4);
  });

  it('keeps roots and the claim untouched when the atomic envelope write fails', () => {
    localStorage.setItem(PROJECTS_KEY, '["legacy-a"]');
    const originalSetItem = localStorage.setItem.bind(localStorage);
    const setItem = vi.spyOn(localStorage, 'setItem').mockImplementation((key, value) => {
      if (key === __testing.OWNER_CLAIM_KEY) throw new Error('quota exceeded');
      originalSetItem(key, value);
    });

    expect(readSidebarOwnerStorage(PROJECTS_KEY, 'owner-a')).toBeNull();
    expect(localStorage.getItem(__testing.OWNER_CLAIM_KEY)).toBeNull();
    expect(localStorage.getItem(PROJECTS_KEY)).toBe('["legacy-a"]');

    setItem.mockRestore();
    expect(readSidebarOwnerStorage(PROJECTS_KEY, 'owner-a')).toBe('["legacy-a"]');
  });

  it('keeps a published claim closed if Main changes owners during the commit', () => {
    localStorage.setItem(PROJECTS_KEY, '["legacy"]');
    let authorityRead = 0;
    __testing.setOwnerAuthorityReader((ownerId) => {
      authorityRead += 1;
      if (ownerId !== 'owner-a') return ownerId === 'owner-b' ? OWNER_B : null;
      return authorityRead < 3 ? OWNER_A : null;
    });

    expect(readSidebarOwnerStorage(PROJECTS_KEY, 'owner-a')).toBeNull();
    expect(readEnvelope()).toMatchObject({ version: 1, ownerId: 'owner-a' });
    expect(localStorage.getItem(PROJECTS_KEY)).toBe('["legacy"]');

    __testing.setOwnerAuthorityReader((ownerId) =>
      ownerId === 'owner-b' ? OWNER_B : ownerId === 'owner-a' ? OWNER_A : null,
    );
    expect(readSidebarOwnerStorage(PROJECTS_KEY, 'owner-b')).toBeNull();
    expect(readSidebarOwnerStorage(PROJECTS_KEY, 'owner-a')).toBe('["legacy"]');
  });

  it('upgrades an old bare v1 reservation without guessing ownership of remaining roots', () => {
    localStorage.setItem(
      __testing.OWNER_CLAIM_KEY,
      JSON.stringify({ version: 1, ownerId: 'owner-a' }),
    );
    localStorage.setItem(PROJECTS_KEY, '["possibly-from-downgrade"]');

    expect(readSidebarOwnerStorage(PROJECTS_KEY, 'owner-a')).toBeNull();
    expect(readEnvelope()).toMatchObject({
      version: 1,
      ownerId: 'owner-a',
      legacy: { schemaVersion: 1, values: { [PROJECTS_KEY]: null } },
    });
    expect(localStorage.getItem(PROJECTS_KEY)).toBe('["possibly-from-downgrade"]');
  });

  it('fails closed on foreign, malformed, incomplete, and unknown envelopes', () => {
    const malformedClaims: unknown[] = [
      'broken',
      { version: 1, ownerId: 'owner-b' },
      { version: 1, ownerId: 'owner-a', legacy: { schemaVersion: 2, values: {} } },
      {
        version: 1,
        ownerId: 'owner-a',
        legacy: { schemaVersion: 1, values: { [PROJECTS_KEY]: '["legacy"]' } },
      },
    ];

    for (const claim of malformedClaims) {
      localStorage.clear();
      localStorage.setItem(
        __testing.OWNER_CLAIM_KEY,
        typeof claim === 'string' ? claim : JSON.stringify(claim),
      );
      localStorage.setItem(PROJECTS_KEY, '["legacy"]');

      expect(readSidebarOwnerStorage(PROJECTS_KEY, 'owner-a')).toBeNull();
      expect(localStorage.getItem(PROJECTS_KEY)).toBe('["legacy"]');
    }
  });

  it('does not create first scoped state while the shared claim is malformed', () => {
    localStorage.setItem(__testing.OWNER_CLAIM_KEY, 'broken');
    localStorage.setItem(PROJECTS_KEY, '["legacy"]');

    expect(writeSidebarOwnerStorage(PROJECTS_KEY, 'owner-a', '["default-derived"]')).toBe(false);
    expect(localStorage.getItem(sidebarOwnerStorageKey(PROJECTS_KEY, 'owner-a'))).toBeNull();
    expect(localStorage.getItem(PROJECTS_KEY)).toBe('["legacy"]');
  });

  it('still reads and writes explicit scoped state when a claim is malformed', () => {
    localStorage.setItem(__testing.OWNER_CLAIM_KEY, 'broken');
    localStorage.setItem(sidebarOwnerStorageKey(PROJECTS_KEY, 'owner-a'), '{broken-scoped');

    expect(readSidebarOwnerStorage(PROJECTS_KEY, 'owner-a')).toBe('{broken-scoped');
    expect(writeSidebarOwnerStorage(PROJECTS_KEY, 'owner-a', '["new"]')).toBe(true);
    expect(readSidebarOwnerStorage(PROJECTS_KEY, 'owner-a')).toBe('["new"]');
  });

  it('keeps pinned bytes staged until Main durably consumes them', () => {
    localStorage.setItem(PINNED_ORDER_KEY, '["session-a"]');

    expect(readClaimedLegacySidebarStorage(PINNED_ORDER_KEY, 'owner-a')).toBe('["session-a"]');
    expect(readClaimedLegacySidebarStorage(PINNED_ORDER_KEY, 'owner-a')).toBe('["session-a"]');

    __testing.setOwnerAuthorityReader((ownerId) =>
      ownerId === 'owner-a' ? OWNER_A_CONSUMED : null,
    );
    clearClaimedLegacySidebarStorage(PINNED_ORDER_KEY, 'owner-a');
    expect(localStorage.getItem(PINNED_ORDER_KEY)).toBe('["session-a"]');
    expect(readClaimedLegacySidebarStorage(PINNED_ORDER_KEY, 'owner-a')).toBeNull();
  });

  it('captures no pinned fallback when Main was already authoritative', () => {
    localStorage.setItem(PINNED_ORDER_KEY, '["session-a"]');
    __testing.setOwnerAuthorityReader((ownerId) =>
      ownerId === 'owner-a' ? OWNER_A_CONSUMED : null,
    );

    clearClaimedLegacySidebarStorage(PINNED_ORDER_KEY, 'owner-a');

    expect(localStorage.getItem(PINNED_ORDER_KEY)).toBe('["session-a"]');
    expect(readEnvelope()).toMatchObject({
      legacy: { values: { [PINNED_ORDER_KEY]: null } },
    });
    expect(readClaimedLegacySidebarStorage(PINNED_ORDER_KEY, 'owner-a')).toBeNull();
  });

  it('preserves a root value changed by a downgrade after envelope capture', () => {
    localStorage.setItem(PINNED_ORDER_KEY, '["captured"]');
    expect(readClaimedLegacySidebarStorage(PINNED_ORDER_KEY, 'owner-a')).toBe('["captured"]');
    localStorage.setItem(PINNED_ORDER_KEY, '["changed-by-downgrade"]');
    __testing.setOwnerAuthorityReader((ownerId) =>
      ownerId === 'owner-a' ? OWNER_A_CONSUMED : null,
    );

    clearClaimedLegacySidebarStorage(PINNED_ORDER_KEY, 'owner-a');

    expect(localStorage.getItem(PINNED_ORDER_KEY)).toBe('["changed-by-downgrade"]');
    expect(readClaimedLegacySidebarStorage(PINNED_ORDER_KEY, 'owner-a')).toBeNull();
  });

  it('does not touch identity state without an active or authoritative owner', () => {
    localStorage.setItem(PROJECTS_KEY, '["legacy"]');
    __testing.setOwnerAuthorityReader(() => null);

    expect(readSidebarOwnerStorage(PROJECTS_KEY, null)).toBeNull();
    expect(readSidebarOwnerStorage(PROJECTS_KEY, 'owner-a')).toBeNull();
    expect(writeSidebarOwnerStorage(PROJECTS_KEY, 'owner-a', '["new"]')).toBe(false);
    expect(localStorage.getItem(PROJECTS_KEY)).toBe('["legacy"]');
    expect(localStorage.getItem(__testing.OWNER_CLAIM_KEY)).toBeNull();
  });
});
