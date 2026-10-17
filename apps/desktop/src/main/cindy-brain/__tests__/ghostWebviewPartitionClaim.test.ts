import { describe, expect, it, vi } from 'vitest';

vi.mock('../../appSessionState', () => ({
  dataOwnerStorageKey: (ownerId: string) => `opaque-${ownerId}`,
}));

import {
  installedGhostLogicalIdentity,
  installedGhostStoragePart,
  installedGhostWebviewPartitionClaim,
  pluginStoragePart,
} from '../../../shared/pluginIdentity';
import { resolveGhostWebviewPartitionClaim } from '../ghostWebviewPartition';

const owner = { mode: 'cloud' as const, dataOwnerId: 'owner-a' };

describe('renderer webview claim matches the physical instance', () => {
  const ghosts = [
    {
      label: 'legacy root',
      manifest: { id: 'helper' },
      dir: '/ghosts/helper',
      instanceKey: 'helper',
      namespaceState: 'pending' as const,
    },
    {
      label: 'new root',
      manifest: { id: 'helper' },
      dir: '/ghosts/_ns/_root/helper',
      instanceKey: '_root__helper',
      namespace: null,
      namespaceState: 'confirmed' as const,
    },
    {
      label: 'in-place organization',
      manifest: { id: 'xd-feishu' },
      dir: '/ghosts/xd-feishu',
      instanceKey: 'xd-feishu',
      namespace: 'xd',
      namespaceState: 'confirmed' as const,
    },
    {
      label: 'new organization',
      manifest: { id: 'helper' },
      dir: '/ghosts/_ns/xd/helper',
      instanceKey: '_ns__xd__helper',
      namespace: 'xd',
      namespaceState: 'confirmed' as const,
    },
  ];

  it.each(ghosts)('resolves the $label claim to that instance', (ghost) => {
    const claim = installedGhostWebviewPartitionClaim(ghost);
    const resolved = resolveGhostWebviewPartitionClaim(claim, owner);
    expect(resolved?.ghostId).toBe(installedGhostStoragePart(ghost));
    expect(ghosts.filter((candidate) => installedGhostStoragePart(candidate) === resolved?.ghostId))
      .toEqual([ghost]);
  });

  it('keeps the in-place organization height key on the logical id', () => {
    const inPlace = ghosts[2]!;
    expect(installedGhostStoragePart(inPlace)).toBe('xd-feishu');
    expect(pluginStoragePart(installedGhostLogicalIdentity(inPlace))).toBe('_ns__xd__xd-feishu');
    expect(installedGhostWebviewPartitionClaim(inPlace)).toBe('cindy-ghost-xd-feishu');
  });
});
