import { createGhostProductionCallbacks } from './ghostProductionCallbacksFixture.js';
import { describe, expect, it, vi } from 'vitest';

import type { InstalledGhost } from '../../../shared/ghost.js';
import { GhostConnectionManager } from '../ghostConnections.js';
import { GhostOauthAccountManager } from '../ghostOauthAccounts.js';
import { handleGhostConnectionsRequest } from '../runtime/ghostConnectionsEndpoint.js';
import { handleGhostOauthRequest } from '../runtime/ghostOauthEndpoint.js';
import { handleGhostSecretsRequest } from '../runtime/ghostSecretsEndpoint.js';

type RequestArgs = {
  ghostId: string;
  method: string;
  pathname: string;
  readBodyText: () => Promise<string>;
  isCurrent: () => boolean;
};
type Callback = (args: RequestArgs) => Promise<{ status: number; body?: string }>;

const routes = [
  { setter: 'setGhostSecretsHandler', method: 'PUT', pathname: '/secrets/user_key', body: '{"value":"fake-old-secret"}', status: 204 },
  { setter: 'setGhostOauthHandler', method: 'PUT', pathname: '/oauth/oauth_key/client', body: '{"clientId":"fake-old-client"}', status: 204 },
  { setter: 'setGhostConnectionsHandler', method: 'POST', pathname: '/connections/api', body: '{"host":"api.example.com","token":"fake-old-token"}', status: 200 },
] as const;
type Route = typeof routes[number];

function loadCallback(setter: string, deps: Record<string, unknown>, omitGuard = false): Callback {
  return createGhostProductionCallbacks<{ handler: Callback }>({
    callbacks: { handler: [setter] },
    transformCallback: omitGuard ? (source) => source.replace(/^\s*isCurrent,\r?\n/gm, '') : undefined,
  })(deps).handler;
}

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((finish) => { resolve = finish; });
  return { promise, resolve };
}

function harness(route: Route, opts: { omitGuard?: boolean; githubProbe?: boolean; storagePart?: string } = {}) {
  const ghostId = opts.storagePart ?? (opts.githubProbe ? 'cindy-github' : 'helper');
  const inject = { header: 'Authorization', format: 'Bearer {value}', hosts: ['api.example.com'] };
  let installed: InstalledGhost = {
    dir: '/plugins/helper', enabled: true,
    approval: { state: 'approved', revision: 'original-receipt' },
    manifest: {
      schemaVersion: 2, id: opts.githubProbe ? 'cindy-github' : 'helper', name: 'Helper',
      version: '1.0.0', kind: 'chip', entry: 'main.js', slots: ['network'],
      network: {
        hosts: ['api.example.com'],
        secrets: [
          { key: 'user_key', source: 'user', label: 'User key', inject },
          { key: 'oauth_key', source: 'oauth', label: 'OAuth', inject, oauth: { authorizeUrl: 'https://api.example.com/auth', tokenUrl: 'https://api.example.com/token', scopes: [] } },
          ...(opts.githubProbe ? [{ key: 'host_cli', source: 'gh-cli' as const, label: 'Host CLI', inject }] : []),
        ],
        connections: [{ key: 'api', label: 'API', maxConnections: 2, inject: { header: inject.header, format: inject.format } }],
      },
    },
  };
  const data = new Map([['replacement-sentinel', 'fake-new-source']]);
  const store = vi.fn((targetId: string, key: string, value: string) => {
    data.set(targetId + ' ' + key, value);
    return true;
  });
  const remove = vi.fn((targetId: string, key: string) => { data.delete(targetId + ' ' + key); });
  const vault = { read: (targetId: string, key: string) => data.get(targetId + ' ' + key) ?? null, store, remove };
  const oauthManager = new GhostOauthAccountManager({
    vault, openExternal: vi.fn(), fetchImpl: vi.fn() as unknown as typeof fetch,
  });
  const connectionManager = new GhostConnectionManager({ vault: { ...vault, readTail: () => null } });
  const emit = vi.fn();
  const notice = vi.fn();
  const broadcast = vi.fn();
  const lock = vi.fn(async (_ghostId: string, task: () => unknown) => task());
  const showMessageBox = vi.fn(async () => ({ response: 0 }));
  const probeAvailability = vi.fn(async () => true);
  const handler = loadCallback(route.setter, {
    findGhostForInstanceId: (targetId: string) => targetId === ghostId ? installed : null,
    handleGhostSecretsRequest, handleGhostOauthRequest, handleGhostConnectionsRequest,
    withRuntimeFiloGoogleClient: (manifest: InstalledGhost['manifest']) => manifest,
    getGhostOauthAccountManager: () => oauthManager,
    getGhostConnectionManager: () => connectionManager,
    getGhostManager: () => ({ list: () => [installed] }),
    isGhostTokenBrokerAuthorized: () => false,
    withActiveOwnerGhostOauthMutationLock: lock,
    readGhostSecret: vault.read, readGhostSecretTail: () => null,
    storeGhostSecret: store, removeGhostSecret: remove,
    getGhostSetupChangeBus: () => ({ emit }),
    broadcastGhostHostNotice: notice, broadcastGhostsChanged: broadcast,
    getAuthState: () => ({ user: null }),
    resolveConnectionAudienceForGhost: () => null, isConnectionSecretReady: () => false,
    isCindyOfficialTrustInfo: () => true,
    getSharedGhCliTokenSource: () => ({ probeAvailability }),
    GHOST_NETWORK_MAX_CONNECTIONS_PER_DECL: 2,
    dialog: { showMessageBox }, t: (key: string) => key,
    log: { warn: vi.fn() },
  }, opts.omitGuard);
  const isCurrent = vi.fn(() => installed.approval.state === 'approved' && installed.approval.revision === 'original-receipt');
  const request = (readBodyText: () => Promise<string>) => handler({
    ghostId, method: route.method, pathname: route.pathname, readBodyText, isCurrent,
  });
  const change = (state: 'replacement' | 'invalid') => {
    installed = { ...installed, approval: state === 'invalid'
      ? { state: 'invalid' } : { state: 'approved', revision: 'replacement-receipt' } };
  };
  return { ghostId, request, change, isCurrent, data, store, remove, emit, notice, broadcast, lock, showMessageBox, probeAvailability };
}

describe('Credential protocol wiring through actual index callbacks', () => {
  it.each(routes.flatMap((route) => (['replacement', 'invalid'] as const).map((change) => ({ route, change }))))(
    'blocks $route.pathname after $change while the old body is pending', async ({ route, change }) => {
      const target = harness(route);
      const body = deferred<string>();
      const before = new Map(target.data);
      const pending = target.request(() => body.promise);
      target.change(change);
      body.resolve(route.body);
      expect(await pending).toEqual({ status: 403 });
      expect(target.data).toEqual(before);
      expect(target.store).not.toHaveBeenCalled();
      expect(target.emit).not.toHaveBeenCalled();
      expect(target.notice).not.toHaveBeenCalled();
      expect(target.broadcast).not.toHaveBeenCalled();
      expect(target.isCurrent).toHaveBeenCalled();
    },
  );

  it.each(routes)('demonstrates the late-write regression when $setter omits only the forwarded guard', async (route) => {
    const target = harness(route, { omitGuard: true });
    const body = deferred<string>();
    const before = new Map(target.data);
    const pending = target.request(() => body.promise);
    target.change('replacement');
    body.resolve(route.body);
    expect((await pending).status).toBe(route.status);
    expect(target.data).not.toEqual(before);
    expect(target.store).toHaveBeenCalled();
    expect(target.emit).toHaveBeenCalled();
    expect(target.isCurrent).not.toHaveBeenCalled();
  });

  it.each(routes)('allows $pathname for the unchanged organization instance', async (route) => {
    const target = harness(route, { storagePart: '_ns__acme__helper' });
    const result = await target.request(async () => route.body);
    expect(result.status).toBe(route.status);
    expect(target.store).toHaveBeenCalled();
    expect(target.store.mock.calls.every(([targetId]) => targetId === '_ns__acme__helper')).toBe(true);
    expect(target.emit).toHaveBeenCalled();
    expect(target.isCurrent).toHaveBeenCalled();
  });

  it('keeps the forwarded OAuth guard inside the production mutation lock', async () => {
    const target = harness(routes[1]);
    const entered = deferred<void>();
    const release = deferred<void>();
    target.lock.mockImplementationOnce(async (_ghostId, task) => {
      entered.resolve();
      await release.promise;
      return task();
    });
    const pending = target.request(async () => routes[1].body);
    await entered.promise;
    target.change('replacement');
    release.resolve();
    expect(await pending).toEqual({ status: 403 });
    expect(target.store).not.toHaveBeenCalled();
    expect(target.emit).not.toHaveBeenCalled();
    expect(target.broadcast).not.toHaveBeenCalled();
  });

  it('keeps the forwarded connection guard after the production host confirmation', async () => {
    const target = harness(routes[2]);
    const entered = deferred<void>();
    const confirmation = deferred<{ response: number }>();
    target.showMessageBox.mockImplementationOnce(() => { entered.resolve(); return confirmation.promise; });
    const pending = target.request(async () => routes[2].body);
    await entered.promise;
    target.change('replacement');
    confirmation.resolve({ response: 0 });
    expect(await pending).toEqual({ status: 403 });
    expect(target.store).not.toHaveBeenCalled();
    expect(target.emit).not.toHaveBeenCalled();
    expect(target.notice).not.toHaveBeenCalled();
  });

  it('forwards the original guard after the Secrets callback awaits its host credential probe', async () => {
    const target = harness(routes[0], { githubProbe: true });
    const probe = deferred<boolean>();
    target.probeAvailability.mockReturnValueOnce(probe.promise);
    const readBodyText = vi.fn(async () => routes[0].body);
    const pending = target.request(readBodyText);
    target.change('replacement');
    probe.resolve(true);
    expect(await pending).toEqual({ status: 403 });
    expect(readBodyText).not.toHaveBeenCalled();
    expect(target.store).not.toHaveBeenCalled();
    expect(target.emit).not.toHaveBeenCalled();
    expect(target.notice).not.toHaveBeenCalled();
  });
});
