import { beforeEach, describe, expect, it, vi } from 'vitest';

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
import {
  electronSandboxAdapter,
  ensureGhostProtocolRegistered,
  setGhostAppContextProvider,
  setGhostKvStore,
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

beforeEach(() => {
  harness.activeOwner = { mode: 'cloud', dataOwnerId: 'owner-a', generation: 1 };
  harness.sessions.clear();
  harness.fromPartition.mockClear();
  harness.BrowserWindow.mockClear();
  harness.browserWindowOptions.length = 0;
  kvEndpoint.handleGhostKvRequest.mockReset();
  kvEndpoint.readBoundedBodyText.mockReset();
});

describe('electronSandboxAdapter owner partition', () => {
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
      'cindy-ghost-owner:cloud:opaque-owner-a:same-ghost',
    );
    const sessionB = harness.sessions.get(
      'cindy-ghost-owner:cloud:opaque-owner-b:same-ghost',
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

  it('同 owner 只增加 generation 时复用原 partition', () => {
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

    expect(harness.fromPartition).toHaveBeenCalledOnce();
    expect([...harness.sessions.keys()]).toEqual([
      'cindy-ghost-owner:cloud:opaque-owner-a:generation-stable',
    ]);
  });

  it('owner 切换后旧 Session 的新请求在路由和业务读取前返回 403', async () => {
    const store = { read: vi.fn(() => ({})), write: vi.fn() };
    setGhostKvStore(store);
    ensureGhostProtocolRegistered(ghost('stale-request'), {
      mode: 'cloud',
      dataOwnerId: 'owner-a',
      generation: 1,
    });
    const sessionA = harness.sessions.get(
      'cindy-ghost-owner:cloud:opaque-owner-a:stale-request',
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

  it('同 owner generation 变化后旧 Session 仍可走静态与能力路由', async () => {
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
      'cindy-ghost-owner:cloud:opaque-owner-a:active-request',
    );

    const bootResponse = await registered?.protocolHandler?.(
      new Request('cindy-ghost://active-request/'),
    );
    const contextResponse = await registered?.protocolHandler?.(
      new Request('cindy-ghost://active-request/app-context'),
    );

    expect(bootResponse?.status).toBe(200);
    expect(contextResponse?.status).toBe(200);
    expect(appContextProvider).toHaveBeenCalledOnce();
  });

  it('boot 与任意插件 HTML 响应统一允许 HTTPS 图片，其他 CSP 能力不放宽', async () => {
    const installed = ghost('https-image-csp');
    installed.manifest.settingsHtml = 'settings.html';
    installed.manifest.mainView = { html: 'main-view.html' };
    ensureGhostProtocolRegistered(installed);
    const registered = harness.sessions.get(
      'cindy-ghost-owner:cloud:opaque-owner-a:https-image-csp',
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
      'cindy-ghost-owner:cloud:opaque-owner-a:https-image-network',
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
      'cindy-ghost-owner:cloud:opaque-owner-a:https-image-listener-once',
    );
    expect(harness.fromPartition).toHaveBeenCalledOnce();
    expect(registered?.beforeRequest).toHaveBeenCalledOnce();
    expect(registered?.protocolHandle).toHaveBeenCalledOnce();
  });

  it('请求已进入 handler 后切换 owner 不取消或重新检查在途 provider', async () => {
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
      'cindy-ghost-owner:cloud:opaque-owner-a:inflight-request',
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
    expect(response?.status).toBe(200);
    await expect(response?.json()).resolves.toEqual(outcome);
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
        generation: 2,
      }),
    ).toThrow('ghost protocol partition already belongs to a different data owner');
  });

  it('逻辑沙箱也使用当前 owner 的同一非持久 partition', () => {
    harness.activeOwner = { mode: 'local', dataOwnerId: 'local-owner', generation: 4 };
    const handle = electronSandboxAdapter.create(ghost('panel-owner'));

    expect(harness.browserWindowOptions[0]?.webPreferences).toMatchObject({
      partition: 'cindy-ghost-owner:local:opaque-local-owner:panel-owner',
    });
    expect(
      (harness.browserWindowOptions[0]?.webPreferences as { partition: string }).partition,
    ).not.toMatch(/^persist:/);
    handle.destroy();
  });
});
