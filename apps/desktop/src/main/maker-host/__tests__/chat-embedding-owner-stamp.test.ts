import { describe, expect, it } from 'vitest';

import {
  isChatEmbeddingOwnerStampCurrent,
  parseChatEmbeddingOwnerStamp,
} from '../chat-embedding-owner-stamp.js';

describe('chat embedding mutation owner stamp', () => {
  it('parses only a complete owner stamp', () => {
    expect(parseChatEmbeddingOwnerStamp({ dataOwnerId: 'owner-a', ownerGeneration: 3 })).toEqual({
      dataOwnerId: 'owner-a',
      ownerGeneration: 3,
    });
    expect(parseChatEmbeddingOwnerStamp({ dataOwnerId: null, ownerGeneration: 0 })).toEqual({
      dataOwnerId: null,
      ownerGeneration: 0,
    });
    expect(parseChatEmbeddingOwnerStamp({ dataOwnerId: 'owner-a' })).toBeNull();
    expect(
      parseChatEmbeddingOwnerStamp({ dataOwnerId: 'owner-a', ownerGeneration: 1.5 }),
    ).toBeNull();
    expect(parseChatEmbeddingOwnerStamp(null)).toBeNull();
  });

  it('accepts only the same owner and generation outside an account boundary', () => {
    const current = { dataOwnerId: 'owner-a', ownerGeneration: 4 };

    expect(
      isChatEmbeddingOwnerStampCurrent(
        { dataOwnerId: 'owner-a', ownerGeneration: 4 },
        current,
        false,
      ),
    ).toBe(true);
    expect(
      isChatEmbeddingOwnerStampCurrent(
        { dataOwnerId: 'owner-b', ownerGeneration: 4 },
        current,
        false,
      ),
    ).toBe(false);
    expect(
      isChatEmbeddingOwnerStampCurrent(
        { dataOwnerId: 'owner-a', ownerGeneration: 3 },
        current,
        false,
      ),
    ).toBe(false);
    expect(
      isChatEmbeddingOwnerStampCurrent(
        { dataOwnerId: 'owner-a', ownerGeneration: 4 },
        current,
        true,
      ),
    ).toBe(false);
    expect(
      isChatEmbeddingOwnerStampCurrent(
        { dataOwnerId: null, ownerGeneration: 4 },
        { dataOwnerId: null, ownerGeneration: 4 },
        false,
      ),
    ).toBe(false);
  });
});
