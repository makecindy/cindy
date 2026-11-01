import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';

const harness = vi.hoisted(() => {
  let nextWebContentsId = 1;
  type RegisteredSession = {
    permissionRequest: ReturnType<typeof vi.fn>;
    permissionCheck: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
    beforeRequest: ReturnType<typeof vi.fn>;
    headersReceived: ReturnType<typeof vi.fn>;
    protocolHandle: ReturnType<typeof vi.fn>;
    protocolHandler?: (request: Request) => Promise<Response>;
    downloadHandler?: (event: { preventDefault(): void }) => void;
    session?: object;
    fetch: ReturnType<typeof vi.fn>;
  };
  const sessions = new Map<string, RegisteredSession>();
  const contents = new Map<number, { session: object; isDestroyed(): boolean; executeJavaScript: ReturnType<typeof vi.fn> }>();
  return {
    activeOwner: {
      mode: 'cloud' as 'signed-out' | 'local' | 'cloud',
      dataOwnerId: 'owner-a' as string | null,
      generation: 1,
    },
    sessions,
    contents,
    fromPartition: vi.fn((partition: string) => {
      const existing = sessions.get(partition);
      if (existing) return existing.session;
      const created: RegisteredSession = {
        permissionRequest: vi.fn(),
        permissionCheck: vi.fn(),
        on: vi.fn((event: string, handler: (event: { preventDefault(): void }) => void) => {
          if (event === 'will-download') created.downloadHandler = handler;
        }),
        beforeRequest: vi.fn(),
        headersReceived: vi.fn(),
        fetch: vi.fn(async (url: string, options: RequestInit) => created.protocolHandler
          ? created.protocolHandler(new Request(url, options)) : new Response(null, { status: 404 })),
        protocolHandle: vi.fn(
          (_scheme: string, handler: (request: Request) => Promise<Response>) => {
            created.protocolHandler = handler;
          },
        ),
      };
      created.session = {
        setPermissionRequestHandler: created.permissionRequest,
        setPermissionCheckHandler: created.permissionCheck,
        on: created.on,
        webRequest: { onBeforeRequest: created.beforeRequest, onHeadersReceived: created.headersReceived },
        protocol: { handle: created.protocolHandle },
        fetch: created.fetch,
      };
      sessions.set(partition, created);
      return created.session;
    }),
    browserWindowOptions: [] as Array<Record<string, unknown>>,
    BrowserWindow: vi.fn(function BrowserWindow(options: Record<string, unknown>) {
      harness.browserWindowOptions.push(options);
      const preferences = options.webPreferences as { partition: string };
      const contents = { id: nextWebContentsId++, session: harness.fromPartition(preferences.partition)!,
        on: vi.fn(), isDestroyed: vi.fn(() => false), forcefullyCrashRenderer: vi.fn(),
        executeJavaScript: vi.fn(async () => []) };
      harness.contents.set(contents.id, contents);
      return {
        webContents: contents,
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
  webContents: { fromId: vi.fn((id: number) => harness.contents.get(id) ?? null) },
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
vi.mock('../../../i18n.js', () => ({ t: () => 'Play video' }));

import { GhostConnectionManager } from '../../ghostConnections.js';
import { GhostOauthAccountManager } from '../../ghostOauthAccounts.js';
import { handleGhostConnectionsRequest } from '../ghostConnectionsEndpoint.js';
import { handleGhostOauthRequest } from '../ghostOauthEndpoint.js';
import { handleGhostSecretsRequest } from '../ghostSecretsEndpoint.js';
import { ownerScopedGhostPartitionForInstalledGhost } from '../../ghostWebviewPartition.js';
import {
  electronSandboxAdapter,
  ghostIdForLogicWebContents,
  invokeGhostMobileRelay,
  fetchGhostMobilePage,
  ensureGhostProtocolRegistered,
  revokeLegacyGhostProtocolPartition,
  setGhostAppContextProvider,
  setGhostAgentModelsProvider,
  setGhostModelPickerProvider,
  setGhostKvStore,
  setGhostConnectionsHandler,
  setGhostOauthHandler,
  setGhostSecretsHandler,
  setGhostMediaModelsProvider,
} from '../electronSandboxAdapter';
import { createGhostAgentModelsCache } from '../../ghostAgentModels.js';
import type { ProviderView } from '@cindy/model-providers';

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
  harness.contents.clear();
  harness.fromPartition.mockClear();
  harness.BrowserWindow.mockClear();
  harness.browserWindowOptions.length = 0;
  kvEndpoint.handleGhostKvRequest.mockReset();
  kvEndpoint.readBoundedBodyText.mockReset();
  setGhostKvStore({ read: () => ({}), write: vi.fn(), captureTarget: () => 'approved', isTargetCurrent: () => true });
});

describe('electronSandboxAdapter owner partition', () => {
  it.each([undefined, null, 'acme'])('uses the running receipt partition for mobile relay and fetch (%s)', async (namespace) => {
    const installed = { ...ghost('mobile-' + (namespace ?? 'root')),
      ...(namespace === undefined ? {} : { namespace }),
      dir: namespace === undefined ? '/plugins/mobile-root' : '/plugins/_ns/' + (namespace ?? '_root') + '/mobile-' + (namespace ?? 'root') };
    electronSandboxAdapter.create(installed);
    await expect(invokeGhostMobileRelay(installed, { op: 'connect', pageId: 'phone', channels: [] })).resolves.toEqual([]);
    const contents = [...harness.contents.values()][0];
    expect(contents.executeJavaScript).toHaveBeenCalledOnce();
    await expect(fetchGhostMobilePage(installed, '/gallery', 'GET')).resolves.toMatchObject({ status: 200 });
    const partition = ownerScopedGhostPartitionForInstalledGhost(installed, harness.activeOwner)!;
    expect(harness.sessions.get(partition)!.fetch).toHaveBeenCalledOnce();
    harness.activeOwner.generation++;
    await expect(invokeGhostMobileRelay(installed, { op: 'poll', pageId: 'phone', after: 0 })).rejects.toThrow('PLUGIN_PAGE_UNAVAILABLE');
    expect(contents.executeJavaScript).toHaveBeenCalledOnce();
  });
  it('rejects stale registration before reading the request URL or body', async () => {
    let target = 'original';
    setGhostKvStore({ read: () => ({}), write: vi.fn(), captureTarget: () => target, isTargetCurrent: (_id, expected) => expected === target });
    const installed = ghost('stale-registration');
    ensureGhostProtocolRegistered(installed);
    const handler = harness.sessions.get(ownerScopedGhostPartitionForInstalledGhost(installed, harness.activeOwner)!)!.protocolHandler!;
    target = 'replacement';
    const readUrl = vi.fn(() => 'cindy-ghost://' + installed.manifest.id + '/kv');
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
    const partition = approvedPartition('cindy-ghost-owner:cloud:opaque-owner-a:' + installed.manifest.id + ':ns:acme');
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

  it('keeps an in-place organization session on its directory key and separates a later root install', () => {
    const organization = { ...ghost('shared'), namespace: 'acme' };
    ensureGhostProtocolRegistered(organization);
    expect(harness.sessions.has(approvedPartition('cindy-ghost-owner:cloud:opaque-owner-a:shared:ns:acme'))).toBe(true);
    expect(harness.sessions.has(approvedPartition('cindy-ghost-owner:cloud:opaque-owner-a:_ns__acme__shared:ns:acme'))).toBe(false);
    ensureGhostProtocolRegistered({ ...ghost('shared'), namespace: null, dir: '/plugins/_ns/_root/shared' });
    expect(harness.sessions.size).toBe(2);
    expect(harness.sessions.has(approvedPartition(
      'cindy-ghost-owner:cloud:opaque-owner-a:_root__shared:root',
      1,
      '/plugins/_ns/_root/shared',
    ))).toBe(true);
  });

  it('reuses the directory key for an in-place stamp but opens a separate session per committed namespace', () => {
    ensureGhostProtocolRegistered(ghost('legacy-shared'));
    ensureGhostProtocolRegistered({ ...ghost('legacy-shared'), namespace: 'acme' });
    ensureGhostProtocolRegistered({ ...ghost('legacy-shared'), namespace: null });
    expect([...harness.sessions.keys()]).toEqual([
      approvedPartition('cindy-ghost-owner:cloud:opaque-owner-a:legacy-shared'),
      approvedPartition('cindy-ghost-owner:cloud:opaque-owner-a:legacy-shared:ns:acme'),
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

  it('serves an in-place organization commit from a fresh session while the legacy one stays revoked', async () => {
    ensureGhostProtocolRegistered(ghost('committed-org'));
    const oldHandler = harness.sessions.get(approvedPartition('cindy-ghost-owner:cloud:opaque-owner-a:committed-org'))?.protocolHandler;
    revokeLegacyGhostProtocolPartition('committed-org');
    ensureGhostProtocolRegistered({ ...ghost('committed-org'), namespace: 'acme' });
    const orgHandler = harness.sessions.get(approvedPartition('cindy-ghost-owner:cloud:opaque-owner-a:committed-org:ns:acme'))?.protocolHandler;
    expect((await orgHandler?.(new Request('cindy-ghost://committed-org/')))?.status).toBe(200);
    expect((await oldHandler?.(new Request('cindy-ghost://committed-org/')))?.status).toBe(403);
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

  // #8128: production session/protocol admission; old coverage only tested images/loopback.
  // Minimum failure: a remote player fetching /wake, or an unapproved historical declaration.
  // Tier: unit, real registered callbacks with an in-memory Electron session.
  it('requires explicit video approval and isolates player requests from plugin capabilities', async () => {
    const unapproved = ghost('video-unapproved');
    unapproved.manifest.videoPlayers = ['bilibili'];
    ensureGhostProtocolRegistered(unapproved);
    const denied = harness.sessions.get(approvedPartition('cindy-ghost-owner:cloud:opaque-owner-a:video-unapproved'))!;
    expect((await denied.protocolHandler!(new Request('cindy-ghost://video-unapproved/__video_player__/bilibili?aid=1'))).status).toBe(403);
    expect(denied.headersReceived).not.toHaveBeenCalled();
    const approved = ghost('video-approved');
    approved.manifest.videoPlayers = ['bilibili']; approved.videoPlayerApprovals = ['bilibili'];
    ensureGhostProtocolRegistered(approved);
    const registered = harness.sessions.get(approvedPartition('cindy-ghost-owner:cloud:opaque-owner-a:video-approved'))!;
    const prefix = 'cindy-ghost://video-approved/';
    const wrapper = { url: prefix + '__video_player__/bilibili?aid=1', parent: { url: prefix + 'panel.html', parent: null } };
    const player = { url: 'https://player.bilibili.com/player.html?aid=1&page=1&autoplay=0', parent: wrapper };
    const request = registered.beforeRequest.mock.calls[0][0];
    const check = (url: string, resourceType: string, frame = player, webContentsId = 42) => {
      const result = vi.fn(); request({ url, resourceType, frame, webContentsId }, result); return result.mock.calls[0][0].cancel;
    };
    harness.contents.set(42, { session: registered.session!, isDestroyed: () => false, executeJavaScript: vi.fn(), getType: () => 'webview' } as never);
    expect(check(player.url, 'subFrame')).toBe(false);
    expect(check('https://api.bilibili.com/x/player/v2', 'xhr')).toBe(false);
    expect(check(prefix + 'wake', 'xhr')).toBe(true);
    expect(check('https://evil.example/steal', 'image')).toBe(true);
    expect(check(player.url.replace('autoplay=0', 'autoplay=1'), 'subFrame')).toBe(true);
    expect(check(player.url, 'subFrame', player, 999)).toBe(true);
    const document = await registered.protocolHandler!(new Request(wrapper.url));
    expect(document.status).toBe(200);
    expect(document.headers.get('content-security-policy')).toContain('frame-src https://player.bilibili.com');
    expect(await document.text()).not.toContain('<iframe');
    const callback = vi.fn();
    registered.headersReceived.mock.calls[0][0]({url: player.url, responseHeaders: {'Content-Security-Policy':['original-policy']}}, callback);
    expect(callback.mock.calls[0][0].responseHeaders['Content-Security-Policy']).toEqual(['original-policy', expect.stringContaining('sandbox allow-scripts allow-same-origin')]);
    harness.activeOwner = { mode: 'cloud', dataOwnerId: 'owner-b', generation: 2 };
    expect(check(player.url, 'subFrame')).toBe(true);
    expect((await registered.protocolHandler!(new Request(wrapper.url))).status).toBe(403);
  });

  it('回环嵌入插件:面板子帧及其同端口请求放行,面板自身与其它端口仍拒绝', async () => {
    const embed = ghost('loopback-embed');
    embed.manifest.preview = { hosts: ['127.0.0.1'] };
    embed.manifest.node = { entry: 'node/worker.cjs', protocol: 'json-rpc-stdio' };
    ensureGhostProtocolRegistered(embed);
    const registered = harness.sessions.get(
      approvedPartition('cindy-ghost-owner:cloud:opaque-owner-a:loopback-embed'),
    );
    const handler = registered?.beforeRequest.mock.calls[0]?.[0] as
      | ((details: Record<string, unknown>, callback: (result: { cancel: boolean }) => void) => void)
      | undefined;
    expect(handler).toBeTypeOf('function');
    const cancelled = (details: Record<string, unknown>): boolean => {
      const callback = vi.fn();
      handler?.(details, callback);
      return callback.mock.calls[0]?.[0].cancel as boolean;
    };
    const panelUrl = 'cindy-ghost://loopback-embed/panel.html';
    const page = 'http://127.0.0.1:50365/control?udid=x';
    // 面板把本机页面装进 <iframe>
    expect(cancelled({ url: page, resourceType: 'subFrame', frame: { url: 'about:blank', parent: { url: panelUrl } } })).toBe(false);
    expect(cancelled({ url: page, resourceType: 'subFrame', referrer: panelUrl })).toBe(false);
    // 本机页面自己的更深一层子帧(控制页把设备画面再套一层 iframe):同端口才放行
    expect(cancelled({ url: 'http://127.0.0.1:50365/simulators/x?handheld=1', resourceType: 'subFrame', frame: { url: 'about:blank', parent: { url: page } } })).toBe(false);
    expect(cancelled({ url: 'http://127.0.0.1:50365/simulators/x?handheld=1', resourceType: 'subFrame', referrer: page })).toBe(false);
    // 子帧内回到同一主机:端口的资源与 WebSocket
    for (const [url, resourceType] of [
      ['http://127.0.0.1:50365/control.js', 'script'],
      ['http://127.0.0.1:50365/control.css', 'stylesheet'],
      ['http://127.0.0.1:50365/control-api', 'xhr'],
      ['ws://127.0.0.1:50365/simulators/x/stream', 'webSocket'],
      ['http://127.0.0.1:50365/shot.jpg', 'image'],
    ] as const) {
      expect(cancelled({ url, resourceType, frame: { url: page } }), `${resourceType} ${url}`).toBe(false);
    }
    // 拒绝:顶层导航、面板页自己直连回环、换端口、换主机、非回环父帧、HTTPS 伪装
    for (const details of [
      { url: page, resourceType: 'mainFrame', frame: { url: panelUrl } },
      { url: 'http://127.0.0.1:50365/control-api', resourceType: 'xhr', frame: { url: panelUrl } },
      { url: 'http://127.0.0.1:50365/control-api', resourceType: 'xhr', referrer: panelUrl },
      { url: 'http://127.0.0.1:1/other', resourceType: 'xhr', frame: { url: page } },
      { url: 'ws://127.0.0.1:1/socket', resourceType: 'webSocket', frame: { url: page } },
      { url: 'http://10.0.0.5:50365/x', resourceType: 'xhr', frame: { url: page } },
      { url: page, resourceType: 'subFrame', frame: { url: 'about:blank', parent: { url: 'cindy-ghost://other-ghost/panel.html' } } },
      { url: page, resourceType: 'subFrame', frame: { url: 'about:blank', parent: { url: 'https://evil.example/' } } },
      // 更深的子帧跨到另一个回环端口/主机:拒绝
      { url: 'http://127.0.0.1:1/control?udid=x', resourceType: 'subFrame', frame: { url: 'about:blank', parent: { url: page } } },
      { url: 'http://10.0.0.5:50365/control?udid=x', resourceType: 'subFrame', frame: { url: 'about:blank', parent: { url: page } } },
      { url: page, resourceType: 'subFrame' },
      { url: 'http://user:pw@127.0.0.1:50365/x', resourceType: 'xhr', frame: { url: page } },
      { url: 'https://127.0.0.1:50365/x', resourceType: 'xhr', frame: { url: page } },
    ]) {
      expect(cancelled(details), JSON.stringify(details)).toBe(true);
    }
    const response = await registered?.protocolHandler?.(new Request('cindy-ghost://loopback-embed/panel.html'));
    expect(response?.headers.get('content-security-policy')).toContain("frame-src 'self' http://127.0.0.1:* http://localhost:*");
  });

  it('未同时声明 panel、node 与回环 preview 的插件不放行任何回环请求,CSP 不含 frame-src', async () => {
    const cases: Array<[string, (m: Record<string, unknown>) => void]> = [
      ['loopback-no-node', (m) => { m.preview = { hosts: ['127.0.0.1'] }; }],
      ['loopback-no-preview', (m) => { m.node = { entry: 'node/worker.cjs', protocol: 'json-rpc-stdio' }; }],
      ['loopback-remote-preview', (m) => { m.preview = { hosts: ['demo.example.dev'] }; m.node = { entry: 'node/worker.cjs', protocol: 'json-rpc-stdio' }; }],
    ];
    for (const [id, mutate] of cases) {
      const installed = ghost(id);
      mutate(installed.manifest as unknown as Record<string, unknown>);
      ensureGhostProtocolRegistered(installed);
      const registered = harness.sessions.get(approvedPartition(`cindy-ghost-owner:cloud:opaque-owner-a:${id}`));
      const handler = registered?.beforeRequest.mock.calls[0]?.[0] as
        | ((details: Record<string, unknown>, callback: (result: { cancel: boolean }) => void) => void)
        | undefined;
      const callback = vi.fn();
      handler?.({ url: 'http://127.0.0.1:50365/control', resourceType: 'subFrame', frame: { url: 'about:blank', parent: { url: `cindy-ghost://${id}/panel.html` } } }, callback);
      expect(callback.mock.calls[0]?.[0].cancel, id).toBe(true);
      const response = await registered?.protocolHandler?.(new Request(`cindy-ghost://${id}/panel.html`));
      expect(response?.headers.get('content-security-policy'), id).not.toContain('frame-src');
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

  // 更新重启的 forceQuit 先逐个 destroy 全部 BrowserWindow,before-quit 才 destroyAll;
  // 已销毁窗口再读 webContents 抛 Object has been destroyed,曾打断整个 destroyAll。
  it('收尾已被外部销毁的逻辑沙箱时不再访问窗口，且解除管子验身绑定', () => {
    const handle = electronSandboxAdapter.create(ghost('gone-first'));
    const win = harness.BrowserWindow.mock.results[0]!.value as {
      webContents: { id: number };
      isDestroyed: ReturnType<typeof vi.fn>;
      destroy: ReturnType<typeof vi.fn>;
    };
    const logicId = win.webContents.id;
    expect(ghostIdForLogicWebContents(logicId)).not.toBeNull();

    win.isDestroyed.mockReturnValue(true);
    Object.defineProperty(win, 'webContents', {
      get() {
        throw new TypeError('Object has been destroyed');
      },
    });

    expect(() => handle.destroy()).not.toThrow();
    expect(win.destroy).not.toHaveBeenCalled();
    expect(ghostIdForLogicWebContents(logicId)).toBeNull();
  });
});

describe('Host model picker endpoint', () => {
  beforeEach(() => {
    kvEndpoint.readBoundedBodyText.mockImplementation((request: Request) => request.text());
  });
  // New interactive route: catalog tests cover GET only. Minimal POST must use the
  // physical plugin identity; author-supplied remote origins must be rejected. Tier: unit.
  it('opens only from a same-instance POST and returns a credential-free selection', async () => {
    const route = { agentKind: 'codex', providerId: 'provider', model: 'model', effort: '', fastMode: false };
    const provider = vi.fn().mockResolvedValue({ ok: true, route });
    setGhostModelPickerProvider(provider);
    ensureGhostProtocolRegistered(ghost('model-picker'));
    const handler = harness.sessions.get(approvedPartition('cindy-ghost-owner:cloud:opaque-owner-a:model-picker'))!.protocolHandler!;
    for (const [url, method, body, status] of [
      ['model-picker/model-picker', 'GET', undefined, 405],
      ['other/model-picker', 'POST', '{}', 403],
      ['model-picker/model-picker?owner=b', 'POST', '{}', 400],
      ['model-picker/model-picker', 'POST', '{"mobilePageId":"other"}', 400],
      ['model-picker/model-picker', 'POST', '{', 400],
    ] as const) {
      const result = await handler(new Request('cindy-ghost://' + url, { method, body }));
      expect(result.status).toBe(status);
    }
    expect(provider).not.toHaveBeenCalled();
    const result = await handler(new Request('cindy-ghost://model-picker/model-picker', { method: 'POST', body: '{}' }));
    expect(await result.json()).toEqual({ ok: true, route });
    expect(result.headers.get('cache-control')).toBe('no-store');
    expect(provider.mock.calls[0][0]).toBe('model-picker');
  });

  it('withholds an interactive result when the originating installation changes while the picker is open', async () => {
    let finish!: (value: import('../../../../shared/pluginModelPicker').PluginModelPickerResult) => void;
    setGhostModelPickerProvider(() => new Promise(resolve => { finish = resolve; }));
    ensureGhostProtocolRegistered(ghost('model-picker-owner'));
    const handler = harness.sessions.get(approvedPartition('cindy-ghost-owner:cloud:opaque-owner-a:model-picker-owner'))!.protocolHandler!;
    const pending = handler(new Request('cindy-ghost://model-picker-owner/model-picker', { method: 'POST', body: '{}' }));
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    harness.activeOwner = { mode: 'cloud', dataOwnerId: 'owner-b', generation: 2 };
    finish({ ok: true, route: { agentKind: 'codex', providerId: 'provider', model: 'model', effort: '', fastMode: false } });
    expect((await pending).status).toBe(403);
  });
});

describe('read-only agent model directory', () => {
  // 测试价值：生产入口 protocolHandler GET /agent-models；#7452 远程位置/400/503/60s 缓存；原用例只覆盖无参。tier=unit
  it('identifies the organization instance when a root plugin has the same id', async () => {
    const provider = vi.fn().mockResolvedValue({ ok: true, models: [] });
    setGhostAgentModelsProvider(provider);
    ensureGhostProtocolRegistered({ ...ghost('shared-models'), namespace: 'acme', dir: '/plugins/_ns/acme/shared-models' });
    const handler = harness.sessions.get(approvedPartition('cindy-ghost-owner:cloud:opaque-owner-a:_ns__acme__shared-models:ns:acme', 1, '/plugins/_ns/acme/shared-models'))?.protocolHandler;
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

  it('appends locations on unparameterized GET and still calls the provider with one argument', async () => {
    const provider = vi.fn().mockResolvedValue({
      ok: true,
      models: [{ id: 'local', name: 'Local', agent: 'codex', providerId: 'p', providerName: 'P', efforts: [], defaultEffort: null }],
      locations: [{ agentDeviceId: 'claude', name: 'Claude' }],
    });
    setGhostAgentModelsProvider(provider);
    ensureGhostProtocolRegistered(ghost('agent-locations'));
    const handler = harness.sessions.get(approvedPartition('cindy-ghost-owner:cloud:opaque-owner-a:agent-locations'))!.protocolHandler!;
    const response = await handler(new Request('cindy-ghost://agent-locations/agent-models'));
    expect(response.status).toBe(200);
    expect(provider).toHaveBeenCalledExactlyOnceWith('agent-locations');
    expect(await response.json()).toEqual({
      ok: true,
      models: [{ id: 'local', name: 'Local', agent: 'codex', providerId: 'p', providerName: 'P', efforts: [], defaultEffort: null }],
      locations: [{ agentDeviceId: 'claude', name: 'Claude' }],
    });
  });

  it('rejects duplicate, empty, oversized, or extra query parameters with 400', async () => {
    const provider = vi.fn().mockResolvedValue({ ok: true, models: [{ id: 'local' }] });
    setGhostAgentModelsProvider(provider);
    ensureGhostProtocolRegistered(ghost('agent-bad-query'));
    const handler = harness.sessions.get(approvedPartition('cindy-ghost-owner:cloud:opaque-owner-a:agent-bad-query'))!.protocolHandler!;
    for (const path of [
      'agent-models?agent_device_id=a&agent_device_id=b',
      'agent-models?agent_device_id=',
      `agent-models?agent_device_id=${'x'.repeat(129)}`,
      'agent-models?agent_device_id=ok&extra=1',
    ]) {
      const response = await handler(new Request('cindy-ghost://agent-bad-query/' + path));
      expect(response.status).toBe(400);
      expect(await response.text()).toBe('');
    }
    expect(provider).not.toHaveBeenCalled();
  });

  it('reads a remote location, echoes agentDeviceId, and keeps no-store GET-only constraints', async () => {
    const provider = vi.fn().mockResolvedValue({
      ok: true,
      agentDeviceId: 'claude',
      models: [
        { id: 'opus', name: 'Opus', agent: 'claude-code', providerId: 'anthropic', providerName: 'Anthropic', efforts: ['high'], defaultEffort: 'high', visible: true },
        { id: 'opus', name: 'Opus', agent: 'claude-code', providerId: 'anthropic-api', providerName: 'Anthropic API', efforts: ['high'], defaultEffort: 'high', visible: true },
      ],
    });
    setGhostAgentModelsProvider(provider);
    ensureGhostProtocolRegistered(ghost('agent-remote'));
    const handler = harness.sessions.get(approvedPartition('cindy-ghost-owner:cloud:opaque-owner-a:agent-remote'))!.protocolHandler!;
    const response = await handler(new Request('cindy-ghost://agent-remote/agent-models?agent_device_id=claude'));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(provider).toHaveBeenCalledExactlyOnceWith('agent-remote', 'claude');
    expect(await response.json()).toEqual({
      ok: true,
      agentDeviceId: 'claude',
      models: [
        { id: 'opus', name: 'Opus', agent: 'claude-code', providerId: 'anthropic', providerName: 'Anthropic', efforts: ['high'], defaultEffort: 'high', visible: true },
        { id: 'opus', name: 'Opus', agent: 'claude-code', providerId: 'anthropic-api', providerName: 'Anthropic API', efforts: ['high'], defaultEffort: 'high', visible: true },
      ],
    });
    expect((await handler(new Request('cindy-ghost://agent-remote/agent-models?agent_device_id=claude', { method: 'POST' }))).status).toBe(405);
  });

  it('returns 503 NOT_AVAILABLE without local models when a well-formed location cannot be read', async () => {
    const provider = vi.fn().mockResolvedValue({ ok: false, errorCode: 'NOT_AVAILABLE', message: 'Model catalog unavailable' });
    setGhostAgentModelsProvider(provider);
    ensureGhostProtocolRegistered(ghost('agent-missing'));
    const handler = harness.sessions.get(approvedPartition('cindy-ghost-owner:cloud:opaque-owner-a:agent-missing'))!.protocolHandler!;
    const response = await handler(new Request('cindy-ghost://agent-missing/agent-models?agent_device_id=offline-box'));
    expect(response.status).toBe(503);
    expect(provider).toHaveBeenCalledExactlyOnceWith('agent-missing', 'offline-box');
    const body = await response.json();
    expect(body).toEqual({ ok: false, errorCode: 'NOT_AVAILABLE', message: 'Model catalog unavailable' });
    expect(JSON.stringify(body)).not.toMatch(/endpoint|apiKey|local/);
  });

  it('does not deliver an in-flight parameterized catalog after owner changes', async () => {
    let finish!: (value: { ok: true; models: []; agentDeviceId: string }) => void;
    setGhostAgentModelsProvider(() => new Promise(resolve => { finish = resolve; }));
    ensureGhostProtocolRegistered(ghost('agent-remote-owner'));
    const handler = harness.sessions.get(approvedPartition('cindy-ghost-owner:cloud:opaque-owner-a:agent-remote-owner'))!.protocolHandler!;
    const pending = handler(new Request('cindy-ghost://agent-remote-owner/agent-models?agent_device_id=claude'));
    harness.activeOwner = { mode: 'cloud', dataOwnerId: 'owner-b', generation: 2 };
    finish({ ok: true, models: [], agentDeviceId: 'claude' });
    expect((await pending).status).toBe(403);
  });

  it('caches successful locations and remote catalogs for 60s and does not cache failures', async () => {
    let now = 1_000;
    const listLocations = vi.fn()
      .mockRejectedValueOnce(new Error('cloud down'))
      .mockResolvedValue({ status: 'complete', locations: [{ agentDeviceId: 'claude', name: 'Claude' }] });
    const readRemote = vi.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue([] as ProviderView[]);
    const cache = createGhostAgentModelsCache({ now: () => now });
    setGhostAgentModelsProvider(async (_id, agentDeviceId) => {
      if (agentDeviceId) return cache.catalog('owner-a', agentDeviceId, () => readRemote());
      const locations = await cache.locations('owner-a', listLocations);
      return { ok: true, models: [], ...(locations ? { locations } : {}) };
    });
    ensureGhostProtocolRegistered(ghost('agent-cache'));
    const handler = harness.sessions.get(approvedPartition('cindy-ghost-owner:cloud:opaque-owner-a:agent-cache'))!.protocolHandler!;
    const noArg = () => handler(new Request('cindy-ghost://agent-cache/agent-models'));
    const withArg = () => handler(new Request('cindy-ghost://agent-cache/agent-models?agent_device_id=claude'));

    expect(await (await noArg()).json()).toEqual({ ok: true, models: [] });
    expect(listLocations).toHaveBeenCalledTimes(1);
    expect(await (await noArg()).json()).toEqual({
      ok: true, models: [], locations: [{ agentDeviceId: 'claude', name: 'Claude' }],
    });
    expect(listLocations).toHaveBeenCalledTimes(2);
    now += 30_000;
    await noArg();
    expect(listLocations).toHaveBeenCalledTimes(2);
    now += 30_000;
    await noArg();
    expect(listLocations).toHaveBeenCalledTimes(3);

    now = 100_000;
    expect((await withArg()).status).toBe(503);
    expect(readRemote).toHaveBeenCalledTimes(1);
    expect(await (await withArg()).json()).toMatchObject({ ok: true, agentDeviceId: 'claude' });
    expect(readRemote).toHaveBeenCalledTimes(2);
    now += 30_000;
    await withArg();
    expect(readRemote).toHaveBeenCalledTimes(2);
    now += 30_000;
    await withArg();
    expect(readRemote).toHaveBeenCalledTimes(3);
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
