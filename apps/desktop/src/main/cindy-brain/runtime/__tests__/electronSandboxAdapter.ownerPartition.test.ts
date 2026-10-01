import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';

const harness = vi.hoisted(() => {
  let nextWebContentsId = 1;
  type RegisteredSession = {
    permissionRequest: ReturnType<typeof vi.fn>;
    permissionCheck: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
    beforeRequest: ReturnType<typeof vi.fn>;
    protocolHandle: ReturnType<typeof vi.fn>;
    protocolHandler?: (request: Request) => Promise<Response>;
    downloadHandler?: (event: { preventDefault(): void }) => void;
  };
  const sessions = new Map<string, RegisteredSession>();
  return {
    activeOwner: {
      mode: 'cloud' as 'signed-out' | 'local' | 'cloud',
      dataOwnerId: 'owner-a' as string | null,
      generation: 1,
    },
    sessions,
    fromPartition: vi.fn((partition: string) => {
      const existing = sessions.get(partition);
      if (existing) return existing;
      const created: RegisteredSession = {
        permissionRequest: vi.fn(),
        permissionCheck: vi.fn(),
        on: vi.fn((event: string, handler: (event: { preventDefault(): void }) => void) => {
          if (event === 'will-download') created.downloadHandler = handler;
        }),
        beforeRequest: vi.fn(),
        protocolHandle: vi.fn(
          (_scheme: string, handler: (request: Request) => Promise<Response>) => {
            created.protocolHandler = handler;
          },
        ),
      };
      sessions.set(partition, created);
      return {
        setPermissionRequestHandler: created.permissionRequest,
        setPermissionCheckHandler: created.permissionCheck,
        on: created.on,
        webRequest: { onBeforeRequest: created.beforeRequest },
        protocol: { handle: created.protocolHandle },
      };
    }),
    browserWindowOptions: [] as Array<Record<string, unknown>>,
    BrowserWindow: vi.fn(function BrowserWindow(options: Record<string, unknown>) {
      harness.browserWindowOptions.push(options);
      return {
        webContents: {
          id: nextWebContentsId++,
          on: vi.fn(),
          isDestroyed: vi.fn(() => false),
          forcefullyCrashRenderer: vi.fn(),
        },
        loadURL: vi.fn().mockResolvedValue(undefined),
        isDestroyed: vi.fn(() => false),
        destroy: vi.fn(),
      };
    }),
  };
});

const kvEndpoint = vi.hoisted(() => ({
  handleGhostKvRequest: vi.fn(),
  readBoundedBodyText: vi.fn(),
}));

vi.mock('electron', () => ({
  BrowserWindow: harness.BrowserWindow,
  session: { fromPartition: harness.fromPartition },
  webContents: { fromId: vi.fn(() => null) },
}));

vi.mock('node:fs', () => ({ createReadStream: vi.fn() }));
vi.mock('node:fs/promises', () => ({
  default: {
    readFile: vi.fn().mockResolvedValue(new Uint8Array([1])),
    stat: vi.fn().mockResolvedValue({ isFile: () => true, size: 0 }),
  },
}));
vi.mock('../../../appSessionState', () => ({
  dataOwnerStorageKey: (ownerId: string) =>
    ownerId.startsWith('collision-') ? 'opaque-collision' : `opaque-${ownerId}`,
  getActiveAppSession: () => ({ ...harness.activeOwner }),
}));
vi.mock('../../../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../../../cindy-media/blobStore', () => ({
  readBlob: vi.fn(),
  resolveHashRef: vi.fn(),
}));
vi.mock('../../../cindy-media/ledger', () => ({
  ghostCanRead: vi.fn(),
  listGhostGallery: vi.fn().mockResolvedValue([]),
}));
vi.mock('../ghostKvEndpoint', () => kvEndpoint);

import type {
  GhostAppContextResult,
  GhostMediaModelsResult,
  InstalledGhost,
} from '../../../../shared/ghost';
import { GhostConnectionManager } from '../../ghostConnections.js';
import { GhostOauthAccountManager } from '../../ghostOauthAccounts.js';
import { handleGhostConnectionsRequest } from '../ghostConnectionsEndpoint.js';
import { handleGhostOauthRequest } from '../ghostOauthEndpoint.js';
import { handleGhostSecretsRequest } from '../ghostSecretsEndpoint.js';
import { ownerScopedGhostPartitionForInstalledGhost } from '../../ghostWebviewPartition.js';
import {
  electronSandboxAdapter,
  ensureGhostProtocolRegistered,
  revokeLegacyGhostProtocolPartition,
  setGhostAppContextProvider,
  setGhostAgentModelsProvider,
  setGhostKvStore,
  setGhostConnectionsHandler,
  setGhostOauthHandler,
  setGhostSecretsHandler,
  setGhostMediaModelsProvider,
} from '../electronSandboxAdapter';

function ghost(id: string): InstalledGhost {
  return {
    dir: `/plugins/${id}`,
    enabled: true,
    approval: { state: 'approved', revision: '00000000-0000-4000-8000-000000000001' },
    manifest: {
      schemaVersion: 2,
      id,
      name: id,
      version: '1.0.0',
      kind: 'chip',
      entry: 'main.js',
      slots: ['panel'],
      panel: { html: 'panel.html' },
    },
  };
}

function approvedPartition(base: string, generation = 1, dir?: string): string {
  const storagePart = base.split(':')[3];
  const ghostId = storagePart.startsWith('_ns__') ? storagePart.split('__')[2] : storagePart;
  const receipt = createHash('sha256')
    .update(JSON.stringify(['approved:00000000-0000-4000-8000-000000000001', dir ?? '/plugins/' + ghostId, generation]))
    .digest('hex');
  return base + ':receipt:' + receipt;
}

beforeEach(() => {
  harness.activeOwner = { mode: 'cloud', dataOwnerId: 'owner-a', generation: 1 };
  harness.sessions.clear();
  harness.fromPartition.mockClear();
  harness.BrowserWindow.mockClear();
  harness.browserWindowOptions.length = 0;
  kvEndpoint.handleGhostKvRequest.mockReset();
  kvEndpoint.readBoundedBodyText.mockReset();
  setGhostKvStore({ read: () => ({}), write: vi.fn(), captureTarget: () => 'approved', isTargetCurrent: () => true });
});

describe('electronSandboxAdapter owner partition', () => {
  it.each(['/media/hash.png', '/library/result.png', '/gallery', '/wake', '/app-context', '/agent-models', '/media-models?type=image', '/kv', '/secrets/token', '/oauth/token/client', '/connections/token', '/', '/panel.html'])('rejects stale registration before routing %s', async (pathname) => {
    let target = 'original';
    setGhostKvStore({ read: () => ({}), write: vi.fn(), captureTarget: () => target, isTargetCurrent: (_id, expected) => expected === target });
    const installed = ghost('route-' + pathname.replace(/[^a-z]/g, '').slice(0, 25));
    ensureGhostProtocolRegistered(installed);
    const handler = harness.sessions.get(ownerScopedGhostPartitionForInstalledGhost(installed, harness.activeOwner)!)!.protocolHandler!;
    target = 'replacement';
    const readUrl = vi.fn(() => 'cindy-ghost://' + installed.manifest.id + pathname);
    const request = { get url() { return readUrl(); } } as Request;
    expect((await handler(request)).status).toBe(403);
    expect(readUrl).not.toHaveBeenCalled();
    expect(kvEndpoint.readBoundedBodyText).not.toHaveBeenCalled();
  });

  it.each([undefined, { state: 'legacy-unapproved' as const }, { state: 'invalid' as const }])('denies unsigned or nonapproved registrations without a trusted target (%s)', async (approval) => {
    setGhostKvStore({ read: () => ({}), write: vi.fn(), captureTarget: () => null, isTargetCurrent: () => true });
    const installed = { ...ghost('unapproved-' + (approval?.state ?? 'missing')), approval } as InstalledGhost;
    ensureGhostProtocolRegistered(installed);
    const handler = harness.sessions.get(ownerScopedGhostPartitionForInstalledGhost(installed, harness.activeOwner)!)!.protocolHandler!;
    expect((await handler(new Request('cindy-ghost://' + installed.manifest.id + '/kv', { method: 'PUT' }))).status).toBe(403);
    expect(kvEndpoint.readBoundedBodyText).not.toHaveBeenCalled();
  });

  it('keeps old A denied and new A usable after an owner generation ABA', async () => {
    const installed = ghost('owner-aba');
    const currentTarget = () => JSON.stringify([harness.activeOwner.mode, harness.activeOwner.dataOwnerId, harness.activeOwner.generation, installed.dir, installed.approval]);
    setGhostKvStore({ read: () => ({}), write: vi.fn(), captureTarget: currentTarget, isTargetCurrent: (_id, expected) => currentTarget() === expected });
    ensureGhostProtocolRegistered(installed);
    const firstPartition = ownerScopedGhostPartitionForInstalledGhost(installed, harness.activeOwner)!;
    const oldHandler = harness.sessions.get(firstPartition)!.protocolHandler!;
    harness.activeOwner = { mode: 'cloud', dataOwnerId: 'owner-b', generation: 2 };
    expect((await oldHandler(new Request('cindy-ghost://owner-aba/'))).status).toBe(403);
    harness.activeOwner = { mode: 'cloud', dataOwnerId: 'owner-a', generation: 3 };
    ensureGhostProtocolRegistered(installed);
    const currentPartition = ownerScopedGhostPartitionForInstalledGhost(installed, harness.activeOwner)!;
    expect((await oldHandler(new Request('cindy-ghost://owner-aba/'))).status).toBe(403);
    expect((await harness.sessions.get(currentPartition)!.protocolHandler!(new Request('cindy-ghost://owner-aba/'))).status).toBe(200);
    expect(currentPartition).not.toBe(firstPartition);
  });

  it('rejects a delayed read response after its registered receipt changes', async () => {
    let target = 'original';
    setGhostKvStore({ read: () => ({}), write: vi.fn(), captureTarget: () => target, isTargetCurrent: (_id, expected) => target === expected });
    let finishProvider!: (result: GhostMediaModelsResult) => void;
    const provider = vi.fn(() => new Promise<GhostMediaModelsResult>((resolve) => { finishProvider = resolve; }));
    setGhostMediaModelsProvider(provider);
    const installed = ghost('delayed-receipt-read');
    ensureGhostProtocolRegistered(installed);
    const handler = harness.sessions.get(ownerScopedGhostPartitionForInstalledGhost(installed, harness.activeOwner)!)!.protocolHandler!;
    const pending = handler(new Request('cindy-ghost://delayed-receipt-read/media-models?type=image'));
    expect(provider).toHaveBeenCalledOnce();
    target = 'replacement';
    finishProvider({ ok: true, type: 'image', models: [], defaultModelId: null, defaultProviderId: null });
    expect((await pending).status).toBe(403);
  });

  it('denies a fresh old-session PUT after same-version receipt replacement and permits the new session', async () => {
    const endpoint = await vi.importActual<typeof import('../ghostKvEndpoint.js')>('../ghostKvEndpoint.js');
    kvEndpoint.handleGhostKvRequest.mockImplementation(endpoint.handleGhostKvRequest);
    kvEndpoint.readBoundedBodyText.mockResolvedValue(JSON.stringify({ source: 'current' }));
    let target = 'receipt-original';
    const write = vi.fn();
    const captureTarget = vi.fn(() => target);
    setGhostKvStore({ read: () => ({}), write, captureTarget, isTargetCurrent: (_id, expected) => expected === target });
    const original = ghost('fresh-receipt-write');
    ensureGhostProtocolRegistered(original);
    const oldPartition = ownerScopedGhostPartitionForInstalledGhost(original, harness.activeOwner)!;
    const oldHandler = harness.sessions.get(oldPartition)!.protocolHandler!;
    target = 'receipt-replacement';
    const replacement = { ...original, approval: { state: 'approved' as const, revision: '00000000-0000-4000-8000-000000000002' } };
    ensureGhostProtocolRegistered(replacement);
    expect((await oldHandler(new Request('cindy-ghost://fresh-receipt-write/kv', { method: 'PUT' }))).status).toBe(403);
    expect(write).not.toHaveBeenCalled();
    expect(kvEndpoint.readBoundedBodyText).not.toHaveBeenCalled();
    const newPartition = ownerScopedGhostPartitionForInstalledGhost(replacement, harness.activeOwner)!;
    expect(newPartition).not.toBe(oldPartition);
    expect((await harness.sessions.get(newPartition)!.protocolHandler!(new Request('cindy-ghost://fresh-receipt-write/kv', { method: 'PUT' }))).status).toBe(204);
    expect(write).toHaveBeenCalledExactlyOnceWith('fresh-receipt-write', { source: 'current' });
    expect(captureTarget).toHaveBeenCalledTimes(2);
  });

  const credentialRoutes = [
    ['/secrets/token', 'PUT', '{"value":"fake-old-secret"}', 204],
    ['/oauth/token/client', 'PUT', '{"clientId":"fake-old-client"}', 204],
    ['/connections/token', 'POST', '{"host":"api.example.com","token":"fake-old-token"}', 200],
  ] as const;

  it.each(credentialRoutes.flatMap((route) =>
    (['replacement', 'invalid', 'owner', 'unchanged'] as const).map((transition) => [...route, transition] as const),
  ))('guards %s during a pending body (%s %s %s %s)', async (pathname, method, text, successStatus, transition) => {
    let currentTarget: string | null = 'approved-original';
    const captureTarget = vi.fn(() => currentTarget);
    const store = vi.fn(() => true);
    const remove = vi.fn();
    const onChanged = vi.fn();
    const vault = { read: () => null, store, remove };
    const oauthManager = new GhostOauthAccountManager({
      vault, openExternal: vi.fn(), fetchImpl: vi.fn() as unknown as typeof fetch,
    });
    const connectionManager = new GhostConnectionManager({ vault: { ...vault, readTail: () => null } });
    setGhostKvStore({
      read: vi.fn(() => ({})), write: vi.fn(), captureTarget,
      isTargetCurrent: (_ghostId, expected) => currentTarget === expected,
    });
    setGhostSecretsHandler((args) => handleGhostSecretsRequest({
      ...args, userSecretKeys: ['token'],
      vault: { ...vault, saved: () => false, tail: () => null }, onStored: onChanged,
    }));
    setGhostOauthHandler((args) => handleGhostOauthRequest({
      ...args, manager: oauthManager, onChanged,
      oauthSecrets: new Map([['token', { authorizeUrl: 'https://api.example.com/auth', tokenUrl: 'https://api.example.com/token', scopes: [] }]]),
    }));
    setGhostConnectionsHandler((args) => handleGhostConnectionsRequest({
      ...args, manager: connectionManager, onChanged, onAdded: onChanged,
      decls: new Map([['token', { label: 'API', maxConnections: 2 }]]), confirmAddHost: async () => true,
    }));
    let finishBody!: (body: string) => void;
    kvEndpoint.readBoundedBodyText.mockReturnValue(new Promise<string>((resolve) => { finishBody = resolve; }));
    const installed = ghost('cred-' + pathname.split('/')[1].slice(0, 4) + '-' + transition);
    ensureGhostProtocolRegistered(installed);
    const handler = harness.sessions.get(approvedPartition('cindy-ghost-owner:cloud:opaque-owner-a:' + installed.manifest.id))!.protocolHandler!;
    const pending = handler(new Request('cindy-ghost://' + installed.manifest.id + pathname, { method }));
    if (transition === 'replacement') currentTarget = 'approved-replacement';
    if (transition === 'invalid') currentTarget = null;
    if (transition === 'owner') harness.activeOwner = { mode: 'cloud', dataOwnerId: 'owner-b', generation: 2 };
    finishBody(text);
    expect((await pending).status).toBe(transition === 'unchanged' ? successStatus : 403);
    if (transition === 'unchanged') {
      expect(store).toHaveBeenCalled();
      expect(onChanged).toHaveBeenCalled();
    } else {
      expect(store).not.toHaveBeenCalled();
      expect(onChanged).not.toHaveBeenCalled();
    }
    expect(captureTarget).toHaveBeenCalledExactlyOnceWith(installed.manifest.id);
  });

  it.each(['replacement', 'invalid', 'owner'] as const)('rejects an old KV PUT after %s while its body is pending', async (transition) => {
    const endpoint = await vi.importActual<typeof import('../ghostKvEndpoint.js')>('../ghostKvEndpoint.js');
    kvEndpoint.handleGhostKvRequest.mockImplementation(endpoint.handleGhostKvRequest);
    let finishBody!: (body: string) => void;
    const body = new Promise<string>((resolve) => { finishBody = resolve; });
    kvEndpoint.readBoundedBodyText.mockReturnValue(body);
    const installed = { ...ghost('kv-late-' + transition), namespace: 'acme' };
    let target: string | null = 'approved-original';
    const captureTarget = vi.fn(() => target);
    const write = vi.fn();
    setGhostKvStore({
      read: vi.fn(() => ({ source: 'replacement' })), write, captureTarget,
      isTargetCurrent: (_ghostId, expected) => target === expected,
    });
    ensureGhostProtocolRegistered(installed);
    const partition = approvedPartition('cindy-ghost-owner:cloud:opaque-owner-a:_ns__acme__' + installed.manifest.id);
    const handler = harness.sessions.get(partition)!.protocolHandler!;
    const pending = handler(new Request('cindy-ghost://' + installed.manifest.id + '/kv', { method: 'PUT' }));
    if (transition === 'replacement') target = 'approved-replacement';
    if (transition === 'invalid') target = null;
    if (transition === 'owner') harness.activeOwner = { mode: 'cloud', dataOwnerId: 'owner-b', generation: 2 };
    finishBody('{"source":"old"}');
    expect((await pending).status).toBe(403);
    expect(write).not.toHaveBeenCalled();
    expect(captureTarget).toHaveBeenCalledTimes(1);
    expect(captureTarget).toHaveBeenNthCalledWith(1, installed.manifest.id);
  });

  it.each([undefined, null])('rejects an unavailable KV install target (%s) before body reading', async (target) => {
    const endpoint = await vi.importActual<typeof import('../ghostKvEndpoint.js')>('../ghostKvEndpoint.js');
    kvEndpoint.handleGhostKvRequest.mockImplementation(endpoint.handleGhostKvRequest);
    const write = vi.fn();
    setGhostKvStore({
      read: vi.fn(() => ({})), write, captureTarget: () => target, isTargetCurrent: () => true,
    });
    const installed = ghost('kv-unavailable-' + String(target));
    ensureGhostProtocolRegistered(installed);
    const handler = harness.sessions.get(approvedPartition('cindy-ghost-owner:cloud:opaque-owner-a:' + installed.manifest.id))!.protocolHandler!;
    expect((await handler(new Request('cindy-ghost://' + installed.manifest.id + '/kv', { method: 'PUT' }))).status).toBe(403);
    expect(kvEndpoint.readBoundedBodyText).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it('allows a delayed KV PUT when the captured install remains current', async () => {
    const endpoint = await vi.importActual<typeof import('../ghostKvEndpoint.js')>('../ghostKvEndpoint.js');
    kvEndpoint.handleGhostKvRequest.mockImplementation(endpoint.handleGhostKvRequest);
    let finishBody!: (body: string) => void;
    kvEndpoint.readBoundedBodyText.mockReturnValue(new Promise<string>((resolve) => { finishBody = resolve; }));
    const captureTarget = vi.fn(() => 'approved-original');
    const write = vi.fn();
    setGhostKvStore({
      read: vi.fn(() => ({})), write, captureTarget,
      isTargetCurrent: (_ghostId, expected) => expected === 'approved-original',
    });
    ensureGhostProtocolRegistered(ghost('kv-unchanged'));
    const handler = harness.sessions.get(approvedPartition('cindy-ghost-owner:cloud:opaque-owner-a:kv-unchanged'))!.protocolHandler!;
    const pending = handler(new Request('cindy-ghost://kv-unchanged/kv', { method: 'PUT' }));
    finishBody('{"source":"current"}');
    expect((await pending).status).toBe(204);
    expect(write).toHaveBeenCalledExactlyOnceWith('kv-unchanged', { source: 'current' });
    expect(captureTarget).toHaveBeenCalledExactlyOnceWith('kv-unchanged');
  });

  it('separates an in-place organization WebView session from a later root install', () => {
    const organization = { ...ghost('shared'), namespace: 'acme' };
    ensureGhostProtocolRegistered(organization);
    expect(harness.sessions.has(approvedPartition('cindy-ghost-owner:cloud:opaque-owner-a:_ns__acme__shared'))).toBe(true);
    expect(harness.sessions.has(approvedPartition('cindy-ghost-owner:cloud:opaque-owner-a:shared'))).toBe(false);
    ensureGhostProtocolRegistered({ ...ghost('shared'), namespace: null, dir: '/plugins/_root/shared' });
    expect(harness.sessions.size).toBe(2);
  });

  it('does not reuse a legacy root session after an organization stamp and root replacement', () => {
    ensureGhostProtocolRegistered(ghost('legacy-shared'));
    ensureGhostProtocolRegistered({ ...ghost('legacy-shared'), namespace: 'acme' });
    ensureGhostProtocolRegistered({ ...ghost('legacy-shared'), namespace: null });
    expect([...harness.sessions.keys()]).toEqual([
      approvedPartition('cindy-ghost-owner:cloud:opaque-owner-a:legacy-shared'),
      approvedPartition('cindy-ghost-owner:cloud:opaque-owner-a:_ns__acme__legacy-shared'),
      approvedPartition('cindy-ghost-owner:cloud:opaque-owner-a:legacy-shared:root'),
    ]);
  });

  it('refuses new protocol requests from a legacy WebView after namespace commit', async () => {
    ensureGhostProtocolRegistered(ghost('committed-legacy'));
    const oldHandler = harness.sessions.get(approvedPartition('cindy-ghost-owner:cloud:opaque-owner-a:committed-legacy'))?.protocolHandler;
    revokeLegacyGhostProtocolPartition('committed-legacy');
    expect((await oldHandler?.(new Request('cindy-ghost://committed-legacy/kv')))?.status).toBe(403);
    expect(kvEndpoint.handleGhostKvRequest).not.toHaveBeenCalled();
    ensureGhostProtocolRegistered({ ...ghost('committed-legacy'), namespace: null });
    const rootHandler = harness.sessions.get(approvedPartition('cindy-ghost-owner:cloud:opaque-owner-a:committed-legacy:root'))?.protocolHandler;
    expect((await rootHandler?.(new Request('cindy-ghost://committed-legacy/')))?.status).toBe(200);
  });
  it('同 ghostId 的不同 owner 使用不同的非持久 session，并显式拒绝权限和下载', () => {
    const installed = ghost('same-ghost');
    ensureGhostProtocolRegistered(installed, {
      mode: 'cloud',
      dataOwnerId: 'owner-a',
      generation: 1,
    });
    ensureGhostProtocolRegistered(installed, {
      mode: 'cloud',
      dataOwnerId: 'owner-b',
      generation: 2,
    });

    const sessionA = harness.sessions.get(
      approvedPartition('cindy-ghost-owner:cloud:opaque-owner-a:same-ghost'),
    );
    const sessionB = harness.sessions.get(
      approvedPartition('cindy-ghost-owner:cloud:opaque-owner-b:same-ghost', 2),
    );
    for (const registered of [sessionA, sessionB]) {
      expect(registered).toBeDefined();
      const permissionCallback = vi.fn();
      registered?.permissionRequest.mock.calls[0]?.[0](null, 'camera', permissionCallback);
      expect(permissionCallback).toHaveBeenCalledWith(false);
      expect(registered?.permissionCheck.mock.calls[0]?.[0]()).toBe(false);
      const downloadEvent = { preventDefault: vi.fn() };
      registered?.downloadHandler?.(downloadEvent);
      expect(downloadEvent.preventDefault).toHaveBeenCalledOnce();
    }
  });

  it('同 owner 增加 generation 时使用新 partition', () => {
    const installed = ghost('generation-stable');
    ensureGhostProtocolRegistered(installed, {
      mode: 'cloud',
      dataOwnerId: 'owner-a',
      generation: 1,
    });
    ensureGhostProtocolRegistered(installed, {
      mode: 'cloud',
      dataOwnerId: 'owner-a',
      generation: 2,
    });

    expect(harness.fromPartition).toHaveBeenCalledTimes(2);
    expect([...harness.sessions.keys()]).toEqual([
      approvedPartition('cindy-ghost-owner:cloud:opaque-owner-a:generation-stable'),
      approvedPartition('cindy-ghost-owner:cloud:opaque-owner-a:generation-stable', 2),
    ]);
  });

  it('owner 切换后旧 Session 的新请求在路由和业务读取前返回 403', async () => {
    const store = {
      read: vi.fn(() => ({})), write: vi.fn(),
      captureTarget: () => 'approved', isTargetCurrent: () => true,
    };
    setGhostKvStore(store);
    ensureGhostProtocolRegistered(ghost('stale-request'), {
      mode: 'cloud',
      dataOwnerId: 'owner-a',
      generation: 1,
    });
    const sessionA = harness.sessions.get(
      approvedPartition('cindy-ghost-owner:cloud:opaque-owner-a:stale-request'),
    );
    const routeRead = vi.fn(() => 'cindy-ghost://stale-request/kv');
    const request = {
      get url() {
        return routeRead();
      },
      method: 'POST',
      headers: new Headers(),
    } as unknown as Request;

    harness.activeOwner = { mode: 'cloud', dataOwnerId: 'owner-b', generation: 2 };
    const response = await sessionA?.protocolHandler?.(request);

    expect(response?.status).toBe(403);
    expect(response?.headers.get('cache-control')).toBe('no-store');
    expect(routeRead).not.toHaveBeenCalled();
    expect(kvEndpoint.handleGhostKvRequest).not.toHaveBeenCalled();
    expect(kvEndpoint.readBoundedBodyText).not.toHaveBeenCalled();
    expect(store.read).not.toHaveBeenCalled();
    expect(store.write).not.toHaveBeenCalled();
  });

  it('同 owner generation 变化后旧 Session 拒绝静态与能力路由', async () => {
    const appContext: GhostAppContextResult = {
      ok: true,
      context: { region: 'global', locale: 'en' },
    };
    const appContextProvider = vi.fn(() => appContext);
    setGhostAppContextProvider(appContextProvider);
    ensureGhostProtocolRegistered(ghost('active-request'), {
      mode: 'cloud',
      dataOwnerId: 'owner-a',
      generation: 1,
    });
    harness.activeOwner.generation = 99;
    const registered = harness.sessions.get(
      approvedPartition('cindy-ghost-owner:cloud:opaque-owner-a:active-request'),
    );

    const bootResponse = await registered?.protocolHandler?.(
      new Request('cindy-ghost://active-request/'),
    );
    const contextResponse = await registered?.protocolHandler?.(
      new Request('cindy-ghost://active-request/app-context'),
    );

    expect(bootResponse?.status).toBe(403);
    expect(contextResponse?.status).toBe(403);
    expect(appContextProvider).not.toHaveBeenCalled();
  });

  it('boot 与任意插件 HTML 响应统一允许 HTTPS 图片，其他 CSP 能力不放宽', async () => {
    const installed = ghost('https-image-csp');
    installed.manifest.settingsHtml = 'settings.html';
    installed.manifest.mainView = { html: 'main-view.html' };
    ensureGhostProtocolRegistered(installed);
    const registered = harness.sessions.get(
      approvedPartition('cindy-ghost-owner:cloud:opaque-owner-a:https-image-csp'),
    );

    for (const pathname of ['/', '/panel.html', '/settings.html', '/main-view.html', '/other.html']) {
      const response = await registered?.protocolHandler?.(
        new Request(`cindy-ghost://https-image-csp${pathname}`),
      );
      const csp = response?.headers.get('content-security-policy');
      expect(csp, pathname).toContain("img-src 'self' data: blob: https:");
      expect(csp, pathname).toContain("default-src 'self'");
      expect(csp, pathname).not.toContain('connect-src https:');
      expect(csp, pathname).not.toContain('script-src https:');
      expect(csp, pathname).not.toContain('style-src https:');
      expect(csp, pathname).not.toContain('media-src https:');
    }
  });

  it('插件 session 只额外放行 HTTPS image，同源资源保持放行', () => {
    ensureGhostProtocolRegistered(ghost('https-image-network'));
    const registered = harness.sessions.get(
      approvedPartition('cindy-ghost-owner:cloud:opaque-owner-a:https-image-network'),
    );
    const handler = registered?.beforeRequest.mock.calls[0]?.[0] as
      | ((
          details: { url: string; resourceType: string },
          callback: (result: { cancel: boolean }) => void,
        ) => void)
      | undefined;
    expect(handler).toBeTypeOf('function');

    const isCancelled = (url: string, resourceType: string): boolean => {
      const callback = vi.fn();
      handler?.({ url, resourceType }, callback);
      expect(callback).toHaveBeenCalledOnce();
      return callback.mock.calls[0]?.[0].cancel as boolean;
    };

    expect(isCancelled('https://images.example.com/logo.png', 'image')).toBe(false);
    expect(isCancelled('cindy-ghost://https-image-network/panel.html', 'mainFrame')).toBe(false);
    expect(isCancelled('cindy-ghost://https-image-network/icon.png', 'image')).toBe(false);

    for (const [url, resourceType] of [
      ['http://images.example.com/logo.png', 'image'],
      ['https://example.com/data', 'xhr'],
      ['https://example.com/data', 'fetch'],
      ['https://example.com/app.js', 'script'],
      ['https://example.com/app.css', 'stylesheet'],
      ['https://example.com/font.woff2', 'font'],
      ['https://example.com/video.mp4', 'media'],
      ['wss://example.com/socket', 'webSocket'],
      ['ftp://example.com/logo.png', 'image'],
      ['not a valid URL', 'image'],
      ['cindy-ghost://other-ghost/icon.png', 'image'],
    ] as const) {
      expect(isCancelled(url, resourceType), `${resourceType} ${url}`).toBe(true);
    }
  });

  it('重复确保同一分区不会累积网络或协议 listener', () => {
    const installed = ghost('https-image-listener-once');
    ensureGhostProtocolRegistered(installed);
    ensureGhostProtocolRegistered(installed);

    const registered = harness.sessions.get(
      approvedPartition('cindy-ghost-owner:cloud:opaque-owner-a:https-image-listener-once'),
    );
    expect(harness.fromPartition).toHaveBeenCalledOnce();
    expect(registered?.beforeRequest).toHaveBeenCalledOnce();
    expect(registered?.protocolHandle).toHaveBeenCalledOnce();
  });

  it('请求已进入 handler 后切换 owner 拒绝在途 provider 的响应', async () => {
    let finishProvider!: (result: GhostMediaModelsResult) => void;
    const provider = vi.fn(
      () =>
        new Promise<GhostMediaModelsResult>((resolve) => {
          finishProvider = resolve;
        }),
    );
    setGhostMediaModelsProvider(provider);
    ensureGhostProtocolRegistered(ghost('inflight-request'), {
      mode: 'cloud',
      dataOwnerId: 'owner-a',
      generation: 1,
    });
    const registered = harness.sessions.get(
      approvedPartition('cindy-ghost-owner:cloud:opaque-owner-a:inflight-request'),
    );
    const pending = registered?.protocolHandler?.(
      new Request('cindy-ghost://inflight-request/media-models?type=image'),
    );
    await vi.waitFor(() => expect(provider).toHaveBeenCalledOnce());

    harness.activeOwner = { mode: 'cloud', dataOwnerId: 'owner-b', generation: 2 };
    const outcome: GhostMediaModelsResult = {
      ok: true,
      type: 'image',
      models: [],
      defaultModelId: null,
      defaultProviderId: null,
    };
    finishProvider(outcome);

    const response = await pending;
    expect(response?.status).toBe(403);
  });

  it('相同 partition 不能被不同 owner snapshot 重新认领', () => {
    const installed = ghost('owner-collision');
    ensureGhostProtocolRegistered(installed, {
      mode: 'cloud',
      dataOwnerId: 'collision-a',
      generation: 1,
    });

    expect(() =>
      ensureGhostProtocolRegistered(installed, {
        mode: 'cloud',
        dataOwnerId: 'collision-b',
        generation: 1,
      }),
    ).toThrow('ghost protocol partition already belongs to a different data owner');
  });

  it('逻辑沙箱也使用当前 owner 的同一非持久 partition', () => {
    harness.activeOwner = { mode: 'local', dataOwnerId: 'local-owner', generation: 4 };
    const handle = electronSandboxAdapter.create(ghost('panel-owner'));

    expect(harness.browserWindowOptions[0]?.webPreferences).toMatchObject({
      partition: approvedPartition('cindy-ghost-owner:local:opaque-local-owner:panel-owner', 4),
    });
    expect(
      (harness.browserWindowOptions[0]?.webPreferences as { partition: string }).partition,
    ).not.toMatch(/^persist:/);
    handle.destroy();
  });
});

describe('read-only agent model directory', () => {
  it('identifies the organization instance when a root plugin has the same id', async () => {
    const provider = vi.fn().mockResolvedValue({ ok: true, models: [] });
    setGhostAgentModelsProvider(provider);
    ensureGhostProtocolRegistered({ ...ghost('shared-models'), namespace: 'acme', dir: '/plugins/_ns/acme/shared-models' });
    const handler = harness.sessions.get(approvedPartition('cindy-ghost-owner:cloud:opaque-owner-a:_ns__acme__shared-models', 1, '/plugins/_ns/acme/shared-models'))?.protocolHandler;
    expect((await handler?.(new Request('cindy-ghost://shared-models/agent-models')))?.status).toBe(200);
    expect(provider).toHaveBeenCalledWith('_ns__acme__shared-models');
  });
  it('serves no-store metadata without accepting writes or query overrides', async () => {
    const provider = vi.fn().mockResolvedValue({ ok: true, models: [] });
    setGhostAgentModelsProvider(provider);
    ensureGhostProtocolRegistered(ghost('agent-directory'));
    const handler = harness.sessions.get(approvedPartition('cindy-ghost-owner:cloud:opaque-owner-a:agent-directory'))!.protocolHandler!;
    for (const [url, method, status] of [
      ['agent-directory/agent-models', 'GET', 200],
      ['agent-directory/agent-models', 'POST', 405],
      ['agent-directory/agent-models?owner=other', 'GET', 400],
      ['other/agent-models', 'GET', 403],
    ] as const) {
      const response = await handler(new Request('cindy-ghost://' + url, { method }));
      expect(response.status).toBe(status);
    }
    expect(provider).toHaveBeenCalledExactlyOnceWith('agent-directory');
    const response = await handler(new Request('cindy-ghost://agent-directory/agent-models'));
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ ok: true, models: [] });
    provider.mockRejectedValue(new Error('secret upstream details'));
    const failed = await handler(new Request('cindy-ghost://agent-directory/agent-models'));
    expect(failed.status).toBe(503);
    expect(await failed.text()).not.toContain('secret');
  });
  it('does not deliver an in-flight catalog after owner changes', async () => {
    let finish!: (value: { ok: true; models: [] }) => void;
    setGhostAgentModelsProvider(() => new Promise(resolve => { finish = resolve; }));
    ensureGhostProtocolRegistered(ghost('agent-owner'));
    const handler = harness.sessions.get(approvedPartition('cindy-ghost-owner:cloud:opaque-owner-a:agent-owner'))!.protocolHandler!;
    const pending = handler(new Request('cindy-ghost://agent-owner/agent-models'));
    harness.activeOwner = { mode: 'cloud', dataOwnerId: 'owner-b', generation: 2 };
    finish({ ok: true, models: [] });
    expect((await pending).status).toBe(403);
    expect((await handler(new Request('cindy-ghost://agent-owner/agent-models'))).status).toBe(403);
  });
});

it('rejects failed in-flight model reads after owner changes', async () => {
  let reject!: (error: Error) => void;
  setGhostAgentModelsProvider(() => new Promise((_resolve, fail) => { reject = fail; }));
  ensureGhostProtocolRegistered(ghost('agent-rejected-owner'));
  const handler = harness.sessions.get(approvedPartition('cindy-ghost-owner:cloud:opaque-owner-a:agent-rejected-owner'))!.protocolHandler!;
  const pending = handler(new Request('cindy-ghost://agent-rejected-owner/agent-models'));
  harness.activeOwner = { mode: 'cloud', dataOwnerId: 'owner-b', generation: 2 };
  reject(new Error('old visibility mirror cleared'));
  expect((await pending).status).toBe(403);
});
