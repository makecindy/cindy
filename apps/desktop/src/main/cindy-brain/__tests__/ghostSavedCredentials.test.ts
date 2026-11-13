import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { GhostManifest } from '../../../shared/ghost.js';
import { GhostConnectionManager } from '../ghostConnections.js';
import { GhostSavedCredentialManager } from '../ghostSavedCredentials.js';
import { handleGhostSecretsRequest } from '../runtime/ghostSecretsEndpoint.js';
import { GHOST_SAVED_CREDENTIAL_MARKER } from '../../../shared/pluginAccountReuse.js';
import { createGhostProductionCallbacks } from './ghostProductionCallbacksFixture.js';
import { withGhostOauthMutationLock } from '../ghostOauthMutationLock.js';

const createReuseLifecycle = createGhostProductionCallbacks<{
  relocateGhostUserData(from: string, to: string): Promise<void>;
  uninstallGhostAndCleanup(id: string): Promise<void>;
  relocateGhostAccountReuseReferences(from: string, to: string | null): Promise<void>;
}>({ functions: ['relocateGhostUserData', 'uninstallGhostAndCleanup', 'relocateGhostAccountReuseReferences'] });

const createReuseIpc = createGhostProductionCallbacks<{
  list(event: { trusted: boolean }, id: string): unknown;
  change(event: { trusted: boolean }, id: string, request: unknown): Promise<{ ok: boolean }>;
}>({ callbacks: { list: ['ipcMain.handle', 'ghosts:reusable-accounts'], change: ['ipcMain.handle', 'ghosts:reuse-account'] } });

// §4 credential handoff: OAuth reuse tests cannot exercise saved PATs or
// connection tokens. Unit tier; the public manager must persist references,
// observe source rotation/removal and reject unconfirmed or changed installs.
function setup(withMutationLock: <T>(id: string, task: () => T | Promise<T>) => Promise<T> = async (_id, task) => task()) {
  const data = new Map<string, string>();
  const vault = {
    read: (id: string, key: string) => data.get(`${id}\0${key}`) ?? null,
    store: (id: string, key: string, value: string) => { data.set(`${id}\0${key}`, value); return true; },
    remove: (id: string, key: string) => { data.delete(`${id}\0${key}`); },
    readTail: () => null,
  };
  const manifest = (id: string): GhostManifest => ({ schemaVersion: 3, id, name: id, version: '1.0.0', kind: 'chip',
    entry: 'main.js', slots: ['network'], network: { hosts: ['api.example.com'],
      secrets: [{ key: 'token', label: 'PAT', inject: { header: 'Authorization', format: 'Bearer {value}' } }] },
  } as GhostManifest);
  const source = { instanceKey: 'source', name: 'Source', manifest: manifest('source') };
  const target = { instanceKey: 'target', name: 'Target', manifest: manifest('target') };
  const sources = [source, target];
  let generation = 1;
  const confirm = vi.fn(async () => true);
  const connectionSources = vi.fn(() => sources);
  const connections = new GhostConnectionManager({ vault });
  const manager = new GhostSavedCredentialManager({ vault, connections,
    connectionSources,
    connectionSource: id => sources.find(source => source.instanceKey === id) ?? null,
    captureTarget: id => `${generation}:${id}`,
    confirm,
    withMutationLock,
  });
  vault.store('source', 'token', 'private-source-token');
  return { manager, vault, data, source, target, sources, connections, confirm, connectionSources, withMutationLock,
    boundary: () => { generation++; },
    ref: { kind: 'secret' as const, instanceKey: 'source', secretKey: 'token', accountId: 'saved' } };
}

function lifecycle(h: ReturnType<typeof setup>) {
  const noop = () => {};
  const entry = createReuseLifecycle({
    getGhostHandoffStore: () => ({ blockForRelocation: () => noop }),
    relocateIdleGhostUserData: async (from: string, to: string) => {
      for (const [key, value] of [...h.data]) {
        if (key.startsWith(from + '\0')) { h.data.set(to + key.slice(from.length), value); h.data.delete(key); }
      }
      const index = h.sources.findIndex(source => source.instanceKey === from);
      if (index !== -1) h.sources.splice(index, 1);
      if (to === h.source.instanceKey && !h.sources.some(source => source.instanceKey === to)) h.sources.unshift(h.source);
    },
    parsePluginInstanceId: () => ({ ghostId: 'source' }),
    withGhostInstallLock: async (_id: string, task: () => unknown) => task(),
    withActiveOwnerGhostOauthMutationLock: h.withMutationLock,
    findGhostForInstanceId: () => h.source, installedGhostStoragePart: (ghost: typeof h.source) => ghost.instanceKey,
    uninstallGhostAndCleanupLocked: async () => {
      // The real Manager now invokes this port before removing source content.
      await entry.relocateGhostAccountReuseReferences('source', null);
      h.sources.splice(0, 1); h.vault.remove('source', 'token');
    },
    getGhostManager: () => ({ list: () => h.sources }), getGhostSavedCredentialManager: () => h.manager,
    listGhostAccountReferenceKeys: (ids: string[]) => ids.map(instanceKey => ({ instanceKey,
      keys: [...h.data.keys()].filter(key => key.startsWith(instanceKey + '\0')).map(key => key.slice(instanceKey.length + 1)) })),
    getGhostOauthAccountManager: () => ({ relocateSourceReferences: async () => {} }), beginGhostMutation: () => noop,
  });
  return entry;
}

describe('saved credential references', () => {
  // #10130 / 4560156890: resolve-only removal coverage missed reinstalling
  // the same physical source. Unit: production lifecycle entry + real manager;
  // a replacement PAT must not inherit the old native reuse confirmation.
  it.each(['uninstall', 'archive'] as const)('does not reuse a replacement PAT after source %s', async kind => {
    const h = setup();
    await h.manager.reuse('target', 'token', h.ref);
    const entry = lifecycle(h);
    if (kind === 'uninstall') await entry.uninstallGhostAndCleanup('source');
    else await entry.relocateGhostUserData('source', 'archive');
    h.sources.unshift({ ...h.source });
    h.vault.store('source', 'token', 'replacement-pat');
    expect(h.manager.resolve('target', 'token')).toBeNull();
    expect(h.manager.list('target', 'token').accounts).toEqual(kind === 'uninstall' ? [] : [
      { id: 'saved', label: 'token', status: 'expired' },
    ]);
    expect(h.manager.list('target', 'token').options).toHaveLength(1);
    expect(await h.manager.reuse('target', 'token', h.ref)).toEqual({ ok: true });
    expect(h.manager.resolve('target', 'token')?.value).toBe('replacement-pat');
  });

  it('preserves a confirmed reference across ordinary source updates and credential rotation', async () => {
    const h = setup();
    await h.manager.reuse('target', 'token', h.ref);
    const before = [...h.data].filter(([key]) => key.startsWith('target\0'));
    h.source.manifest.version = '2.0.0'; h.boundary();
    expect(h.manager.resolve('target', 'token')?.value).toBe('private-source-token');
    h.vault.store('source', 'token', 'rotated-source-token');
    expect(h.manager.resolve('target', 'token')?.value).toBe('rotated-source-token');
    expect([...h.data].filter(([key]) => key.startsWith('target\0'))).toEqual(before);
    expect(h.confirm).toHaveBeenCalledOnce();
  });

  it.each(['uninstall', 'archive'] as const)('revokes orphaned references before a removed declaration is restored after source %s', async kind => {
    const h = setup();
    await h.manager.reuse('target', 'token', h.ref);
    const declarations = h.target.manifest.network!.secrets;
    h.target.manifest.network!.secrets = [];
    const entry = lifecycle(h);
    if (kind === 'uninstall') await entry.uninstallGhostAndCleanup('source');
    else await entry.relocateGhostUserData('source', 'archive');
    h.target.manifest.network!.secrets = declarations;
    h.sources.unshift({ ...h.source });
    h.vault.store('source', 'token', 'replacement-pat');
    expect(h.manager.resolve('target', 'token')).toBeNull();
  });

  it('archives mutually referring plugins without holding either source lock while acquiring consumer locks', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-reuse-locks-'));
    try {
      const h = setup((id, task) => withGhostOauthMutationLock('owner', id, path.join(dir, `${id}.lock`), task));
      for (const plugin of h.sources) plugin.manifest.network!.secrets!.push({
        key: 'borrowed', label: 'Borrowed', inject: { header: 'Authorization', format: 'Bearer {value}' },
      });
      h.vault.store('target', 'token', 'target-owned-token');
      expect(await h.manager.reuse('target', 'borrowed', h.ref)).toEqual({ ok: true });
      expect(await h.manager.reuse('source', 'borrowed', { ...h.ref, instanceKey: 'target' })).toEqual({ ok: true });
      const entry = lifecycle(h);
      await Promise.all([entry.relocateGhostUserData('source', 'archive-source'), entry.relocateGhostUserData('target', 'archive-target')]);
      expect(h.vault.read('archive-source', 'token')).toBe('private-source-token');
      expect(h.vault.read('archive-target', 'token')).toBe('target-owned-token');
      expect(h.manager.resolve('source', 'borrowed')).toBeNull();
      expect(h.manager.resolve('target', 'borrowed')).toBeNull();
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  // #10130 / 4547237926 + 4547298763, unit: manager-only disconnect
  // coverage missed ordinary /secrets replacement/deletion followed by marker replay.
  it.each(['PUT', 'POST', 'DELETE'])('clears delegated access on ordinary %s and rejects marker replay', async method => {
    const h = setup();
    expect(await h.manager.reuse('target', 'token', h.ref)).toEqual({ ok: true });
    const delegated = h.manager.resolve('target', 'token');
    const request = (method: string, value?: string) => handleGhostSecretsRequest({
      method, pathname: '/secrets/token', ghostId: 'target', userSecretKeys: ['token'],
      readBodyText: async () => JSON.stringify({ value }),
      vault: { ...h.vault, saved: (id, key) => h.vault.read(id, key) !== null, tail: () => null },
    });
    expect(await request(method, 'replacement-key')).toEqual({ status: 204 });
    expect([...h.data].filter(([key]) => key.startsWith('target\0')).map(([, value]) => value))
      .toEqual(method === 'DELETE' ? [] : ['replacement-key']);
    expect(() => delegated?.assertCurrent()).toThrow('CREDENTIAL_REFERENCE_CHANGED');
    for (const write of ['PUT', 'POST']) {
      expect(await request(write, `  ${GHOST_SAVED_CREDENTIAL_MARKER}  `)).toEqual({ status: 400 });
    }
    expect(h.manager.resolve('target', 'token')).toBeNull();
    expect(h.manager.list('target', 'token').accounts).toEqual([]);
    expect(h.vault.read('target', 'token')).toBe(method === 'DELETE' ? null : 'replacement-key');
    expect(h.vault.read('source', 'token')).toBe('private-source-token');
  });

  it('preserves delegated access if ordinary storage fails and leaves existing secret reads unchanged', async () => {
    const h = setup();
    expect(await h.manager.reuse('target', 'token', h.ref)).toEqual({ ok: true });
    const vault = { ...h.vault, saved: (id: string, key: string) => h.vault.read(id, key) !== null,
      tail: () => null, store: vi.fn(() => false) };
    expect(await handleGhostSecretsRequest({ method: 'PUT', pathname: '/secrets/token',
      ghostId: 'target', userSecretKeys: ['token'], readBodyText: async () => '{"value":"replacement"}', vault,
    })).toEqual({ status: 500 });
    expect(h.manager.resolve('target', 'token')?.value).toBe('private-source-token');
    for (const value of ['legacy-ordinary-key', GHOST_SAVED_CREDENTIAL_MARKER]) {
      h.vault.store('legacy', 'token', value);
      const result = await handleGhostSecretsRequest({ method: 'GET', pathname: '/secrets',
        ghostId: 'legacy', userSecretKeys: ['token'], readBodyText: vi.fn(), vault,
      });
      expect(result).toEqual({ status: 200, body: '[{"key":"token","saved":true}]' });
      expect(await handleGhostSecretsRequest({ method: 'PUT', pathname: '/secrets/token',
        ghostId: 'legacy', userSecretKeys: ['token'],
        readBodyText: async () => JSON.stringify({ value: GHOST_SAVED_CREDENTIAL_MARKER }), vault,
      })).toEqual({ status: 400 });
      expect(h.vault.read('legacy', 'token')).toBe(value);
    }
  });

  it('allows only the trusted UI to bind an exact saved reference through production IPC', async () => {
    const h = setup();
    const ghost = { enabled: true, approval: { state: 'approved' }, manifest: h.target.manifest };
    const handlers = createReuseIpc({
      assertTrustedAppRendererEvent: (event: { trusted: boolean }) => { if (!event.trusted) throw new Error('UNTRUSTED'); },
      isGhostInstanceId: () => true, requireGhostAvailableForActiveSession: () => {}, findGhostForInstanceId: () => ghost,
      getGhostSavedCredentialManager: () => h.manager, getGhostSetupChangeBus: () => ({ emit() {} }),
      withActiveOwnerGhostOauthMutationLock: (_id: string, task: () => unknown) => Promise.resolve(task()),
      throwIpcError: (code: string) => { throw new Error(code); },
    });
    const request = { kind: 'connect', secretKey: 'token', source: { ...h.ref, untrusted: 'do-not-persist' } };
    await expect(handlers.change({ trusted: false }, 'target', request)).rejects.toThrow('UNTRUSTED');
    await expect(handlers.change({ trusted: true }, 'target', { ...request, source: { ...h.ref, kind: 'oidc-token' } })).rejects.toThrow('INVALID_PARAMS');
    expect(await handlers.change({ trusted: true }, 'target', request)).toEqual({ ok: true });
    const list = handlers.list({ trusted: true }, 'target');
    expect(list).toMatchObject([{ options: [{ kind: 'secret' }], accounts: [{ status: 'connected' }] }]);
    expect(JSON.stringify(list)).not.toContain('private-source-token');
    expect(JSON.stringify([...h.data])).not.toContain('do-not-persist');
    ghost.enabled = false;
    expect(await handlers.change({ trusted: true }, 'target', { kind: 'disconnect', secretKey: 'token', accountId: 'saved' })).toEqual({ ok: true });
    expect(h.vault.read('source', 'token')).toBe('private-source-token');
  });

  it('stores only a reference, resolves the original value freshly, and stops on source removal', async () => {
    const h = setup();
    expect(h.manager.list('target', 'token').options).toMatchObject([{ ...h.ref, label: 'PAT' }]);
    expect(await h.manager.reuse('target', 'token', h.ref)).toEqual({ ok: true });
    expect(JSON.stringify([...h.data].filter(([key]) => key.startsWith('target\0')))).not.toContain('private-source-token');
    const catalogueReads = h.connectionSources.mock.calls.length;
    const first = h.manager.resolve('target', 'token');
    expect(first?.value).toBe('private-source-token');
    h.vault.store('source', 'token', 'rotated-token');
    expect(h.manager.resolve('target', 'token')?.value).toBe('rotated-token');
    h.sources.splice(0, 1);
    expect(() => first?.assertCurrent()).toThrow('CREDENTIAL_REFERENCE_CHANGED');
    expect(h.manager.resolve('target', 'token')).toBeNull();
    expect(h.connectionSources).toHaveBeenCalledTimes(catalogueReads);
    expect(h.manager.list('target', 'token').accounts).toMatchObject([{ status: 'expired' }]);
  });

  it('requires confirmation and binds it to the original installations and declaration', async () => {
    const h = setup();
    h.confirm.mockResolvedValueOnce(false);
    expect(await h.manager.reuse('target', 'token', h.ref)).toEqual({ ok: false, error: 'CANCELLED' });
    expect(h.vault.read('target', 'token')).toBeNull();
    h.confirm.mockImplementationOnce(async () => { h.boundary(); return true; });
    expect(await h.manager.reuse('target', 'token', h.ref)).toEqual({ ok: false, error: 'INVALID_CONFIG' });
    h.confirm.mockImplementationOnce(async () => {
      h.target.manifest.network!.secrets![0]!.inject.format = '{value}'; return true;
    });
    expect(await h.manager.reuse('target', 'token', h.ref)).toEqual({ ok: false, error: 'INVALID_CONFIG' });
    expect(h.vault.read('target', 'token')).toBeNull();
  });

  it('accepts a saved connection PAT only for its exact service and releases the reference', async () => {
    const h = setup();
    h.source.manifest.network!.connections = [{ key: 'instances', label: 'Git service',
      inject: { header: 'Authorization', format: 'Bearer {value}' }, maxConnections: 5 }];
    const added = h.connections.upsert('source', 'instances', { host: 'api.example.com', token: 'connection-pat', max: 5 });
    if (!added.ok) throw new Error('fixture connection');
    const ref = { kind: 'connection' as const, instanceKey: 'source', secretKey: 'instances', accountId: added.connection.id };
    expect(await h.manager.reuse('target', 'token', ref)).toEqual({ ok: true });
    expect(h.manager.resolve('target', 'token')?.value).toBe('connection-pat');
    h.manager.disconnect('target', 'token', ref.accountId);
    expect(h.vault.read('target', 'token')).toBeNull();
    expect(h.connections.resolveTokenByHost('source', 'instances', 'api.example.com')).toBe('connection-pat');
    h.target.manifest.network!.hosts = ['elsewhere.example.com'];
    expect(h.manager.list('target', 'token').options).toEqual([]);
  });

  it('rejects derived platform credentials, exchange changes, and transitive references', async () => {
    const h = setup();
    h.source.manifest.network!.secrets![0]!.source = 'oidc-token';
    expect(h.manager.list('target', 'token').options).toEqual([]);
    delete h.source.manifest.network!.secrets![0]!.source;
    h.target.manifest.network!.secrets![0]!.exchange = { url: 'https://api.example.com/token',
      bodyFormat: '{value}', contentType: 'application/json', tokenPath: 'access_token' };
    expect(h.manager.list('target', 'token').options).toEqual([]);
    delete h.target.manifest.network!.secrets![0]!.exchange;
    expect(await h.manager.reuse('target', 'token', h.ref)).toEqual({ ok: true });
    expect(h.manager.list('source', 'token').options).toEqual([]);
  });

  it('reports failed reference removal instead of claiming access was revoked', async () => {
    const h = setup();
    expect(await h.manager.reuse('target', 'token', h.ref)).toEqual({ ok: true });
    h.vault.remove = vi.fn();
    expect(h.manager.disconnect('target', 'token', 'saved')).toEqual({ ok: false, error: 'VAULT_WRITE_FAILED' });
    expect(h.manager.resolve('target', 'token')?.value).toBe('private-source-token');
  });
});
