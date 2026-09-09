import { describe, expect, it } from 'vitest';

import { isSidebarLegacyRendererOwnerClaim, isSidebarSettingsSnapshot } from '../sidebarSettings';

const OWNER_STAMP = { dataOwnerId: 'owner-a', ownerGeneration: 1 };

describe('sidebar settings snapshot validation', () => {
  it.each([true, false])(
    'accepts an empty snapshot when authority is %s',
    (pinnedOrderIsAuthoritative) => {
      expect(
        isSidebarSettingsSnapshot({
          ...OWNER_STAMP,
          pinnedOrderIsAuthoritative,
          pinnedOrder: [],
          hiddenProjectKeys: [],
          hiddenMainViewGhostIds: [],
        }),
      ).toBe(true);
    },
  );

  it('accepts pinned entries only when main reports complete authority', () => {
    expect(
      isSidebarSettingsSnapshot({
        ...OWNER_STAMP,
        pinnedOrderIsAuthoritative: true,
        pinnedOrder: ['session-a'],
        hiddenProjectKeys: [],
        hiddenMainViewGhostIds: [],
      }),
    ).toBe(true);
    expect(
      isSidebarSettingsSnapshot({
        ...OWNER_STAMP,
        pinnedOrderIsAuthoritative: false,
        pinnedOrder: ['session-a'],
        hiddenProjectKeys: [],
        hiddenMainViewGhostIds: [],
      }),
    ).toBe(false);
  });

  it('rejects snapshots without a boolean authority flag', () => {
    expect(
      isSidebarSettingsSnapshot({
        ...OWNER_STAMP,
        pinnedOrder: [],
        hiddenProjectKeys: [],
        hiddenMainViewGhostIds: [],
      }),
    ).toBe(false);
    expect(
      isSidebarSettingsSnapshot({
        ...OWNER_STAMP,
        pinnedOrderIsAuthoritative: 'yes',
        pinnedOrder: [],
        hiddenProjectKeys: [],
        hiddenMainViewGhostIds: [],
      }),
    ).toBe(false);
  });

  it('requires bounded unique Ghost ids for hidden main views', () => {
    expect(
      isSidebarSettingsSnapshot({
        ...OWNER_STAMP,
        pinnedOrderIsAuthoritative: false,
        pinnedOrder: [],
        hiddenProjectKeys: [],
        hiddenMainViewGhostIds: ['xd-sites'],
      }),
    ).toBe(true);
    expect(
      isSidebarSettingsSnapshot({
        ...OWNER_STAMP,
        pinnedOrderIsAuthoritative: false,
        pinnedOrder: [],
        hiddenProjectKeys: [],
        hiddenMainViewGhostIds: ['xd-sites', 'xd-sites'],
      }),
    ).toBe(false);
    expect(
      isSidebarSettingsSnapshot({
        ...OWNER_STAMP,
        pinnedOrderIsAuthoritative: false,
        pinnedOrder: [],
        hiddenProjectKeys: [],
        hiddenMainViewGhostIds: ['XD Sites'],
      }),
    ).toBe(false);
  });
});

describe('legacy Renderer owner claim validation', () => {
  it('requires an owner stamp and an explicit claim result', () => {
    expect(
      isSidebarLegacyRendererOwnerClaim({
        ...OWNER_STAMP,
        claimed: true,
        canInitialize: true,
        pinnedLegacyConsumed: false,
      }),
    ).toBe(true);
    expect(
      isSidebarLegacyRendererOwnerClaim({
        ...OWNER_STAMP,
        claimed: false,
        canInitialize: false,
        pinnedLegacyConsumed: true,
      }),
    ).toBe(true);
    expect(
      isSidebarLegacyRendererOwnerClaim({
        ...OWNER_STAMP,
        claimed: true,
        pinnedLegacyConsumed: false,
      }),
    ).toBe(false);
    expect(
      isSidebarLegacyRendererOwnerClaim({
        dataOwnerId: 'owner-a',
        ownerGeneration: -1,
        claimed: true,
        canInitialize: true,
        pinnedLegacyConsumed: false,
      }),
    ).toBe(false);
  });
});
