import { describe, expect, it, vi } from 'vitest';
import type { GhostManifest } from '../../../shared/ghost.js';
import { GhostConnectionManager } from '../ghostConnections.js';
import { GhostSavedCredentialManager } from '../ghostSavedCredentials.js';
import { createGhostProductionCallbacks } from './ghostProductionCallbacksFixture.js';

const createReuseIpc = createGhostProductionCallbacks<{
  list(event: { trusted: boolean }, id: string): unknown;
  change(event: { trusted: boolean }, id: string, request: unknown): Promise<{ ok: boolean }>;
}>({ callbacks: { list: ['ipcMain.handle', 'ghosts:reusable-accounts'], change: ['ipcMain.handle', 'ghosts:reuse-account'] } });

// §4 credential handoff: OAuth reuse tests cannot exercise saved PATs or
// connection tokens. Unit tier; the public manager must persist references,
// observe source rotation/removal and reject unconfirmed or changed installs.
function setup() {
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
    withMutationLock: async (_id, task) => task(),
  });
  vault.store('source', 'token', 'private-source-token');
  return { manager, vault, data, source, target, sources, connections, confirm, connectionSources,
    boundary: () => { generation++; },
    ref: { kind: 'secret' as const, instanceKey: 'source', secretKey: 'token', accountId: 'saved' } };
}

describe('saved credential references', () => {
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
