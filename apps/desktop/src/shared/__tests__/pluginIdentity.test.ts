import { describe, expect, it } from 'vitest';
import {
  createPluginLogicalIdentity,
  deliveryNamespaceFields,
  downloadIdentityMatchesPlugin,
  findConflictingGhostCommand,
  findInstalledGhostByIdentity,
  findInstalledGhostByInstanceId,
  isGhostInstanceId,
  formatInstalledGhostAmbiguity,
  resolveInstalledGhost,
  knownDeliveryNamespacesDiffer,
  parsePluginInstallRelId,
  parsePluginInstanceId,
  parsePluginLogicalIdentityKey,
  parsePluginStoragePart,
  pluginInstallRelId,
  pluginLedgerRecordKey,
  pluginLogicalIdentityKey,
  pluginStoragePart,
  isValidPluginStoragePart,
  installedGhostLogicalIdentity,
  installedGhostPhysicalKeys,
  installedGhostPhysicalRelId,
  installedGhostRuntimeId,
  installedGhostStoragePart,
  resolvePluginLibraryStorageKey,
  resolvePluginNamespaceState,
  sameDeliveryNamespaceState,
} from '../pluginIdentity.js';

describe('plugin logical identity', () => {
  it('distinguishes root and enterprise instances with the same ghostId', () => {
    const root = createPluginLogicalIdentity(null, 'helper');
    const enterprise = createPluginLogicalIdentity('acme', 'helper');

    expect(pluginLogicalIdentityKey(root)).not.toBe(pluginLogicalIdentityKey(enterprise));
    expect(parsePluginLogicalIdentityKey(pluginLogicalIdentityKey(root))).toEqual(root);
    expect(parsePluginLogicalIdentityKey(pluginLogicalIdentityKey(enterprise))).toEqual(enterprise);
  });

  it('keeps missing namespace as legacy instead of silently mapping it to root', () => {
    expect(resolvePluginNamespaceState({})).toEqual({ kind: 'legacy' });
    expect(resolvePluginNamespaceState({ namespace: null })).toEqual({
      kind: 'known',
      namespace: null,
    });
  });

  it('rejects malformed identity components and ambiguous keys', () => {
    expect(() => createPluginLogicalIdentity('Bad Namespace', 'helper')).toThrow();
    expect(() => createPluginLogicalIdentity(null, 'Bad Ghost Id')).toThrow();
    expect(() => parsePluginLogicalIdentityKey('acme\u0000helper\u0000extra')).toThrow();
    expect(() => parsePluginLogicalIdentityKey('%E0%A4%A\u0000helper')).toThrow();
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
    expect(downloadIdentityMatchesPlugin({}, plugin)).toBe(true);
    expect(
      downloadIdentityMatchesPlugin(
        {
          pluginId: plugin.id,
          releaseId: 'release-1',
          ghostId: 'helper',
          namespace: 'acme',
        },
        plugin,
      ),
    ).toBe(true);
    expect(
      downloadIdentityMatchesPlugin(
        {
          pluginId: plugin.id,
          releaseId: 'release-1',
          ghostId: 'helper',
          namespace: null,
        },
        plugin,
      ),
    ).toBe(false);
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
    expect(installedGhostStoragePart({ manifest: { id: 'helper' }, namespace: 'acme' })).toBe(
      '_ns__acme__helper',
    );
    expect(installedGhostRuntimeId({ manifest: { id: 'helper' }, namespace: 'acme' })).toBe(
      '_ns/acme/helper',
    );
    expect(pluginStoragePart(root)).not.toBe(pluginStoragePart(enterprise));
    expect(
      installedGhostStoragePart({
        manifest: { id: 'helper' },
        namespace: 'acme',
        dir: '/userData/cindy-brain/helper',
      }),
    ).toBe('helper');
    expect(
      installedGhostRuntimeId({
        manifest: { id: 'helper' },
        namespace: 'acme',
        dir: '/userData/cindy-brain/helper',
      }),
    ).toBe('helper');
    expect(
      installedGhostPhysicalRelId({
        manifest: { id: 'helper' },
        namespace: 'acme',
        dir: '/userData/cindy-brain/_ns/acme/helper',
      }),
    ).toBe('_ns/acme/helper');
    expect(
      installedGhostStoragePart({
        manifest: { id: 'helper' },
        namespace: 'acme',
        dir: '/userData/cindy-brain/_ns/acme/helper',
      }),
    ).toBe('_ns__acme__helper');
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
