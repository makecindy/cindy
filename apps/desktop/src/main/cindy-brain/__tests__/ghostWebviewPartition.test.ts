import { describe, expect, it, vi } from 'vitest';

vi.mock('../../appSessionState', () => ({
  dataOwnerStorageKey: (ownerId: string) => `opaque-${ownerId}`,
}));

import { ghostPartition } from '../../../shared/ghost';
import {
  ownerScopedGhostPartition,
  resolveGhostWebviewPartitionClaim,
} from '../ghostWebviewPartition';

describe('ghost WebView Main partition', () => {
  const ownerA = { mode: 'cloud' as const, dataOwnerId: 'owner-a' };
  const ownerB = { mode: 'cloud' as const, dataOwnerId: 'owner-b' };

  it('同 owner + ghost 稳定，不同 owner + 同 ghost 使用不同 session', () => {
    const partitionA = ownerScopedGhostPartition('same-ghost', ownerA);
    const partitionB = ownerScopedGhostPartition('same-ghost', ownerB);

    expect(partitionA).toBe('cindy-ghost-owner:cloud:opaque-owner-a:same-ghost');
    expect(ownerScopedGhostPartition('same-ghost', ownerA)).toBe(partitionA);
    expect(partitionB).not.toBe(partitionA);
  });

  it('把 Renderer claim 解析为 Main 当前 owner 的权威 partition', () => {
    const claim = ghostPartition('same-ghost');

    expect(resolveGhostWebviewPartitionClaim(claim, ownerA)).toEqual({
      ghostId: 'same-ghost',
      partition: 'cindy-ghost-owner:cloud:opaque-owner-a:same-ghost',
    });
    expect(resolveGhostWebviewPartitionClaim(claim, ownerB)?.partition).toBe(
      'cindy-ghost-owner:cloud:opaque-owner-b:same-ghost',
    );
  });

  it('无 owner、非法 claim 和伪造的真实 partition 都 fail closed', () => {
    expect(
      resolveGhostWebviewPartitionClaim(ghostPartition('same-ghost'), {
        mode: 'signed-out',
        dataOwnerId: null,
      }),
    ).toBeNull();
    expect(resolveGhostWebviewPartitionClaim('cindy-ghost-BAD_ID', ownerA)).toBeNull();
    expect(
      resolveGhostWebviewPartitionClaim(
        'cindy-ghost-owner:cloud:opaque-owner-b:same-ghost',
        ownerA,
      ),
    ).toBeNull();
    expect(resolveGhostWebviewPartitionClaim(undefined, ownerA)).toBeNull();
  });
});
