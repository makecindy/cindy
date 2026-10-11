import { describe, expect, it, vi } from 'vitest';

vi.mock('../../appSessionState', () => ({
  dataOwnerStorageKey: (ownerId: string) => `opaque-${ownerId}`,
}));

import { ghostPartition } from '../../../shared/ghost';
import {
  ownerScopedGhostPartition,
  ownerScopedGhostPartitionForInstalledGhost,
  resolveGhostWebviewPartitionClaim,
} from '../ghostWebviewPartition';

describe('ghost WebView Main partition', () => {
  const ownerA = { mode: 'cloud' as const, dataOwnerId: 'owner-a' };
  const ownerB = { mode: 'cloud' as const, dataOwnerId: 'owner-b' };

  it('isolates approved receipts even when source version and panel HTML are unchanged', () => {
    const original = { manifest: { id: 'source-change', version: '1.0.0' }, approval: { state: 'approved' as const, revision: 'receipt-a' } };
    const replacement = { ...original, approval: { state: 'approved' as const, revision: 'receipt-b' } };
    const originalPartition = ownerScopedGhostPartitionForInstalledGhost(original, ownerA);
    expect(ownerScopedGhostPartitionForInstalledGhost(original, ownerA)).toBe(originalPartition);
    expect(ownerScopedGhostPartitionForInstalledGhost(replacement, ownerA)).not.toBe(originalPartition);
  });

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

  it('企业实例使用 storage part 作为 session 分区后缀', () => {
    expect(ownerScopedGhostPartition('_ns__acme__helper', ownerA)).toBe(
      'cindy-ghost-owner:cloud:opaque-owner-a:_ns__acme__helper',
    );
    expect(resolveGhostWebviewPartitionClaim(ghostPartition('_ns__acme__helper'), ownerA)).toEqual({
      ghostId: '_ns__acme__helper',
      partition: 'cindy-ghost-owner:cloud:opaque-owner-a:_ns__acme__helper',
    });
    expect(ownerScopedGhostPartition('_ns/acme/helper', ownerA)).toBeNull();
  });

  it('迁移前的旧 root、原位企业实例与新 root 各自使用不同的会话', () => {
    const legacy = { manifest: { id: 'helper' } };
    const organization = { manifest: { id: 'helper' }, namespace: 'acme' };
    const root = { manifest: { id: 'helper' }, namespace: null };
    expect(ownerScopedGhostPartitionForInstalledGhost(legacy, ownerA))
      .toBe('cindy-ghost-owner:cloud:opaque-owner-a:helper');
    expect(ownerScopedGhostPartitionForInstalledGhost(organization, ownerA))
      .toBe('cindy-ghost-owner:cloud:opaque-owner-a:_ns__acme__helper');
    expect(ownerScopedGhostPartitionForInstalledGhost(root, ownerA))
      .toBe('cindy-ghost-owner:cloud:opaque-owner-a:helper:root');
  });
});
