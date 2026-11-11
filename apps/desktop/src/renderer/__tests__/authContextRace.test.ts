import { afterEach, describe, expect, it } from 'vitest';
import {
  __testing as dataOwnerTesting,
  isDataOwnerPushCurrent,
  setDataOwnerGeneration,
} from '@/contexts/dataOwnerGeneration';

describe('data-owner live push fencing', () => {
  afterEach(() => {
    dataOwnerTesting.reset();
  });

  it('accepts legacy unstamped pushes and the exact current owner stamp', () => {
    setDataOwnerGeneration('owner-a', 4);

    expect(isDataOwnerPushCurrent(undefined)).toBe(true);
    expect(
      isDataOwnerPushCurrent({ dataOwnerId: 'owner-a', ownerGeneration: 4 }),
    ).toBe(true);
  });

  it('rejects stale, cross-owner, and malformed stamped pushes', () => {
    setDataOwnerGeneration('owner-b', 7);

    expect(
      isDataOwnerPushCurrent({ dataOwnerId: 'owner-b', ownerGeneration: 6 }),
    ).toBe(false);
    expect(
      isDataOwnerPushCurrent({ dataOwnerId: 'owner-a', ownerGeneration: 7 }),
    ).toBe(false);
    expect(isDataOwnerPushCurrent(null)).toBe(false);
  });
});
