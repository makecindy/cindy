import { describe, expect, it } from 'vitest';
import {
  createPluginLogicalIdentity,
  deliveryNamespaceFields,
  downloadIdentityMatchesPlugin,
  findConflictingGhostCommand,
  findInstalledGhostByIdentity,
  findInstalledGhostByInstanceId,
  findInstalledGhostForLocalUpdate,
  findInstalledGhostForDeliveryTarget,
  isGhostInstanceId,
  formatInstalledGhostAmbiguity,
  resolveInstalledGhost,
  knownDeliveryNamespacesDiffer,
  parsePluginInstallRelId,
  parsePluginInstanceId,
  parsePluginStoragePart,
  pluginInstallRelId,
  pluginNewInstallRelId,
  pluginInstallStoragePart,
  pluginLedgerRecordKey,
  pluginStoragePart,
  isValidPluginStoragePart,
  installedGhostLogicalIdentity,
  installedGhostPhysicalKeys,
  installedGhostPhysicalRelId,
  installedGhostMutationTargetToken,
  installedGhostStoragePart,
  resolvePluginLibraryStorageKey,
  resolvePluginNamespaceState,
  sameDeliveryNamespaceState,
} from '../pluginIdentity.js';

describe('plugin logical identity', () => {
  it('gives new roots distinct physical directories and keys without changing legacy keys', () => {
    const identity = createPluginLogicalIdentity(null, 'helper');
    const legacy = { manifest: { id: 'helper' }, namespace: null, dir: '/ghosts/helper' };
    const fresh = { ...legacy, dir: '/ghosts/_root/helper' };
    expect(pluginNewInstallRelId(identity)).toBe('_root/helper');
    expect(parsePluginInstallRelId('_root/helper')).toEqual(identity);
    expect(parsePluginStoragePart('_root__helper')).toEqual(identity);
    expect(pluginInstallStoragePart('_root/helper')).toBe('_root__helper');
    expect(installedGhostPhysicalKeys(legacy)).toEqual({ relId: 'helper', storagePart: 'helper' });
    expect(installedGhostPhysicalKeys(fresh)).toEqual({ relId: '_root/helper', storagePart: '_root__helper' });
    expect(resolvePluginLibraryStorageKey('_root/helper')).toBe('_root__helper');
    expect(findInstalledGhostByInstanceId([fresh], '_root/helper')).toBe(fresh);
    expect(findInstalledGhostByInstanceId([fresh], '_root__helper')).toBe(fresh);
    expect(findInstalledGhostByInstanceId([legacy], '_root__helper')).toBeUndefined();
    expect(parsePluginInstallRelId('_root/../helper')).toBeNull();
    expect(parsePluginStoragePart('_root__helper__extra')).toBeNull();
  });
  it('keeps missing namespace as legacy instead of silently mapping it to root', () => {
    expect(resolvePluginNamespaceState({})).toEqual({ kind: 'legacy' });
    expect(resolvePluginNamespaceState({ namespace: null })).toEqual({
      kind: 'known',
      namespace: null,
    });
  });

  it('rejects malformed identity components', () => {
    expect(() => createPluginLogicalIdentity('Bad Namespace', 'helper')).toThrow();
    expect(() => createPluginLogicalIdentity(null, 'Bad Ghost Id')).toThrow();
  });

  it('keeps missing namespace off persisted records and detects known conflicts', () => {
    expect(deliveryNamespaceFields({})).toEqual({});
    expect(deliveryNamespaceFields({ namespace: null })).toEqual({ namespace: null });
    expect(knownDeliveryNamespacesDiffer({ namespace: null }, { namespace: 'acme' })).toBe(true);
    expect(knownDeliveryNamespacesDiffer({ ghostId: 'helper' }, { namespace: 'acme' })).toBe(false);
    expect(sameDeliveryNamespaceState({}, { namespace: null })).toBe(false);
  });

  it('binds additive download identity to the selected plugin', () => {
    const plugin = {
      id: "c" + "p".repeat(24),
      ghostId: 'helper',
      namespace: 'acme' as string | null,
      currentRelease: { id: 'release-1' },
    };
    const cases: [Parameters<typeof downloadIdentityMatchesPlugin>[0], boolean][] = [
      [{}, true],
      [{ pluginId: plugin.id, releaseId: 'release-1', ghostId: 'helper', namespace: 'acme' }, true],
      [{ pluginId: plugin.id, releaseId: 'release-1', ghostId: 'helper', namespace: null }, false],
    ];
    for (const [download, expected] of cases) {
      expect(downloadIdentityMatchesPlugin(download, plugin)).toBe(expected);
    }
  });

  it('encodes filesystem-safe install directories without moving root installs', () => {
    const root = createPluginLogicalIdentity(null, 'helper');
    const enterprise = createPluginLogicalIdentity('acme', 'helper');
    expect(pluginInstallRelId(root)).toBe('helper');
    expect(pluginInstallRelId(enterprise)).toBe('_ns/acme/helper');
    expect(parsePluginInstallRelId('helper')).toEqual(root);
    expect(parsePluginInstallRelId('_ns/acme/helper')).toEqual(enterprise);
    expect(parsePluginInstallRelId('_ns/../helper')).toBeNull();
    expect(
      findInstalledGhostByIdentity(
        [
          { manifest: { id: 'helper' } },
          { manifest: { id: 'helper' }, namespace: 'acme' },
        ],
        enterprise,
      ),
    ).toEqual({ manifest: { id: 'helper' }, namespace: 'acme' });
  });

  it('resolves omitted namespace only when the ghostId is unique', () => {
    const root = { manifest: { id: 'helper' }, namespace: null };
    const enterprise = { manifest: { id: 'helper' }, namespace: 'acme' };
    expect(resolveInstalledGhost([root], 'helper')).toEqual({ status: 'unique', ghost: root });
    expect(resolveInstalledGhost([root, enterprise], 'helper').status).toBe('ambiguous');
    expect(resolveInstalledGhost([root, enterprise], 'helper', null)).toEqual({
      status: 'unique',
      ghost: root,
    });
    expect(resolveInstalledGhost([root, enterprise], 'helper', 'acme')).toEqual({
      status: 'unique',
      ghost: enterprise,
    });
    expect(formatInstalledGhostAmbiguity('helper', [root, enterprise])).toContain('root/helper');
  });

  it('does not claim a pending legacy install as the explicit root identity', () => {
    const pending = { manifest: { id: 'helper' }, namespaceMigration: 'pending' as const };
    expect(resolveInstalledGhost([pending], 'helper')).toEqual({ status: 'unique', ghost: pending });
    expect(resolveInstalledGhost([pending], 'helper', null)).toEqual({ status: 'missing' });
    expect(findInstalledGhostForDeliveryTarget([pending], { ghostId: 'helper', namespace: null }))
      .toBeUndefined();
  });

  it('binds local updates to the selected instance even when approval states are identical', () => {
    const root = { manifest: { id: 'helper' }, dir: '/ghosts/helper', approval: { state: 'invalid' as const } };
    const enterprise = {
      manifest: { id: 'helper' }, dir: '/ghosts/_ns/acme/helper', namespace: 'acme',
      approval: { state: 'invalid' as const },
    };
    expect(findInstalledGhostForLocalUpdate([root, enterprise], 'helper', '_ns__acme__helper', 'invalid'))
      .toBe(enterprise);
    expect(findInstalledGhostForLocalUpdate([root, enterprise], 'helper', 'helper', 'invalid')).toBe(root);
    expect(findInstalledGhostForLocalUpdate([root, enterprise], 'helper', '_ns__acme__helper', 'legacy-unapproved'))
      .toBeUndefined();
    expect(findInstalledGhostForLocalUpdate([root, enterprise], 'other', 'helper', 'invalid'))
      .toBeUndefined();
  });

  it('does not let a delivery target inherit a same-name instance from another namespace', () => {
    const root = { manifest: { id: 'helper' }, namespace: null };
    const enterprise = { manifest: { id: 'helper' }, namespace: 'acme' };
    const cases = [
      [[root], { ghostId: 'helper' }, root],
      [[root, enterprise], { ghostId: 'helper' }, undefined],
      [[root, enterprise], { ghostId: 'helper', namespace: 'acme' }, enterprise],
      [[root, enterprise], { ghostId: 'helper', namespace: null }, root],
    ] as const;
    for (const [ghosts, target, expected] of cases) {
      expect(findInstalledGhostForDeliveryTarget(ghosts, target)).toEqual(expected);
    }
  });

  it('encodes vault-safe storage parts without moving root files', () => {
    const root = createPluginLogicalIdentity(null, 'helper');
    const enterprise = createPluginLogicalIdentity('acme', 'helper');
    expect(pluginStoragePart(root)).toBe('helper');
    expect(pluginStoragePart(enterprise)).toBe('_ns__acme__helper');
    expect(parsePluginStoragePart('helper')).toEqual(root);
    expect(parsePluginStoragePart('_ns__acme__helper')).toEqual(enterprise);
    expect(parsePluginStoragePart('_ns__/helper')).toBeNull();
    expect(parsePluginStoragePart('_ns__acme__helper__extra')).toBeNull();
    expect(isValidPluginStoragePart('_ns__acme__helper')).toBe(true);
    expect(isValidPluginStoragePart('../helper')).toBe(false);
    expect(pluginStoragePart(root)).not.toBe(pluginStoragePart(enterprise));
    const cases = [
      [{}, '_ns/acme/helper', '_ns__acme__helper'],
      [{ dir: '/userData/cindy-brain/helper' }, 'helper', 'helper'],
      [{ dir: '/userData/cindy-brain/_ns/acme/helper' }, '_ns/acme/helper', '_ns__acme__helper'],
    ] as const;
    for (const [physical, relId, storagePart] of cases) {
      const ghost = { manifest: { id: 'helper' }, namespace: 'acme', ...physical };
      expect(installedGhostPhysicalRelId(ghost)).toBe(relId);
      expect(installedGhostStoragePart(ghost)).toBe(storagePart);
    }
  });

  it('binds mutation tickets to the owner, physical installation and approval', () => {
    const ghost = {
      manifest: { id: 'helper' },
      dir: '/userData/cindy-brain/helper',
      namespace: 'acme',
      approval: { state: 'approved' as const, revision: 'receipt-1' },
    };
    const token = installedGhostMutationTargetToken(ghost, 'owner-1');
    expect(token).toBe(JSON.stringify([
      'owner-1', ghost.dir, 'helper', 'approved:receipt-1', { namespace: 'acme' },
    ]));
    expect(installedGhostMutationTargetToken({ ...ghost }, 'owner-1')).toBe(token);
    expect(installedGhostMutationTargetToken(ghost, 'owner-2')).not.toBe(token);
    for (const changed of [
      { ...ghost, dir: '/other/cindy-brain/helper' },
      { ...ghost, dir: '/userData/cindy-brain/_ns/acme/helper' },
      { ...ghost, approval: { state: 'approved' as const, revision: 'receipt-2' } },
      { ...ghost, namespace: null },
    ]) {
      expect(installedGhostMutationTargetToken(changed, 'owner-1')).not.toBe(token);
    }
  });

  it('keeps legacy, root and organization distinct in mutation tickets', () => {
    const ghost = {
      manifest: { id: 'helper' }, dir: '/userData/cindy-brain/helper',
      approval: { state: 'approved' as const, revision: 'receipt-1' },
    };
    const namespaces = [{}, { namespace: null }, { namespace: 'acme' }];
    const tokens = namespaces.map((namespace) =>
      installedGhostMutationTargetToken({ ...ghost, ...namespace }, 'owner-1'));
    expect(new Set(tokens).size).toBe(3);
    for (const state of ['legacy-unapproved', 'invalid'] as const) {
      expect(installedGhostMutationTargetToken({ ...ghost, approval: { state } }, 'owner-1')).toBeNull();
    }
  });

  it('resolves namespace aliases for an in-place stamped installation', () => {
    const stamped = {
      manifest: { id: 'helper' }, namespace: 'acme',
      dir: '/userData/cindy-brain/helper',
    };
    for (const instanceId of ['helper', '_ns/acme/helper', '_ns__acme__helper']) {
      expect(findInstalledGhostByInstanceId([stamped], instanceId)).toBe(stamped);
    }
  });

  it('resolves UI instance ids by physical storage part first', () => {
    const root = {
      manifest: { id: 'helper' },
      namespace: null,
      dir: '/userData/cindy-brain/helper',
    };
    const enterprise = {
      manifest: { id: 'helper' },
      namespace: 'acme',
      dir: '/userData/cindy-brain/_ns/acme/helper',
    };
    const inPlace = {
      manifest: { id: 'xd-feishu' },
      namespace: 'xd',
      dir: '/userData/cindy-brain/xd-feishu',
    };
    const ghosts = [root, enterprise, inPlace];

    expect(isGhostInstanceId('helper')).toBe(true);
    expect(isGhostInstanceId('_ns__acme__helper')).toBe(true);
    expect(isGhostInstanceId('_ns/acme/helper')).toBe(true);
    expect(isGhostInstanceId('../helper')).toBe(false);
    expect(parsePluginInstanceId('helper')).toEqual({ namespace: null, ghostId: 'helper' });
    expect(parsePluginInstanceId('_ns/acme/helper')).toEqual({ namespace: 'acme', ghostId: 'helper' });
    expect(parsePluginInstanceId('_ns__acme__helper')).toEqual({
      namespace: 'acme',
      ghostId: 'helper',
    });
    expect(findInstalledGhostByInstanceId(ghosts, 'helper')).toBe(root);
    expect(findInstalledGhostByInstanceId(ghosts, '_ns__acme__helper')).toBe(enterprise);
    expect(findInstalledGhostByInstanceId(ghosts, 'xd-feishu')).toBe(inPlace);
  });

  it('does not derive physical mutation keys from an in-place logical identity', () => {
    const inPlace = {
      manifest: { id: 'xd-feishu' },
      namespace: 'xd',
      dir: '/userData/cindy-brain/xd-feishu',
    };
    expect(pluginInstallRelId(installedGhostLogicalIdentity(inPlace))).toBe('_ns/xd/xd-feishu');
    expect(pluginStoragePart(installedGhostLogicalIdentity(inPlace))).toBe('_ns__xd__xd-feishu');
    expect(installedGhostPhysicalKeys(inPlace)).toEqual({
      relId: 'xd-feishu',
      storagePart: 'xd-feishu',
    });
    expect(
      installedGhostPhysicalKeys({
        manifest: { id: 'helper' },
        namespace: 'acme',
        dir: '/userData/cindy-brain/_ns/acme/helper',
      }),
    ).toEqual({
      relId: '_ns/acme/helper',
      storagePart: '_ns__acme__helper',
    });
  });


  it('uses JSON-safe ledger keys that distinguish same-name identities', () => {
    expect(pluginLedgerRecordKey({ ghostId: 'helper' })).toBe('helper');
    expect(pluginLedgerRecordKey({ ghostId: 'helper', namespace: null })).toBe('helper');
    expect(pluginLedgerRecordKey({ ghostId: 'helper', namespace: 'acme' })).toBe(
      '_ns__acme__helper',
    );
  });

  it('only treats the same command as a conflict inside one namespace', () => {
    const root = { manifest: { id: 'helper', command: 'Draw' }, namespace: null as string | null };
    const org = {
      manifest: { id: 'helper', command: 'draw' },
      namespace: 'acme',
      dir: '/brain/_ns/acme/helper',
    };
    expect(
      findConflictingGhostCommand([root], 'Draw', { incomingNamespace: 'acme' }),
    ).toBeUndefined();
    expect(findConflictingGhostCommand([root], 'Draw', { incomingNamespace: null })).toBe(root);
    expect(
      findConflictingGhostCommand([root, org], 'Draw', {
        incomingNamespace: 'acme',
        exemptPhysicalRelId: '_ns/acme/helper',
      }),
    ).toBeUndefined();
    const legacy = { manifest: { id: 'old', command: 'Draw' } };
    expect(findConflictingGhostCommand([legacy], 'draw', { incomingNamespace: null })).toBe(
      legacy,
    );
  });

  it('canonicalizes library keys to the physical storage part', () => {
    expect(resolvePluginLibraryStorageKey('helper')).toBe('helper');
    expect(resolvePluginLibraryStorageKey('_ns/acme/helper')).toBe('_ns__acme__helper');
    expect(resolvePluginLibraryStorageKey('_ns__acme__helper')).toBe('_ns__acme__helper');
    expect(
      resolvePluginLibraryStorageKey('_ns/xd/xd-feishu', {
        manifest: { id: 'xd-feishu' },
        dir: '/brain/xd-feishu',
        namespace: 'xd',
      }),
    ).toBe('xd-feishu');
    expect(resolvePluginLibraryStorageKey('not a plugin')).toBeNull();
  });

});
