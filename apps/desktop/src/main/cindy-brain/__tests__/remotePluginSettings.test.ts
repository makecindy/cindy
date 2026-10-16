import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WebContents } from 'electron';
import { PLUGIN_OAUTH_CHANNEL, REMOTE_RESOURCE_INVOKE_CHANNEL } from '@cindy/device-link';
import { MobilePluginPages } from '../mobilePageService.js';
import { AuthenticatedOauthHost, OauthHostIdentity } from '../../plugin-oauth/authentication.js';
import { getRemoteOauthContext, withRemoteOauthContext } from '../../plugin-oauth/context.js';
import { ghostInstallApprovalToken, type InstalledGhost } from '../../../shared/ghost.js';

const mock = vi.hoisted(() => ({
  handlers: new Map<string, (request: Request) => Promise<Response>>(),
  sessions: new Map<string, ReturnType<typeof makeSession>>(),
  peerCurrent: true,
  dialog: vi.fn(async () => ({ response: 1 })),
}));
function makeSession(partition: string) {
  return {
    protocol: {
      handle: (_scheme: string, handler: (request: Request) => Promise<Response>) =>
        mock.handlers.set(partition, handler),
      unhandle: () => mock.handlers.delete(partition),
    },
    webRequest: { onBeforeRequest: vi.fn() },
    setPermissionRequestHandler: vi.fn(),
    setPermissionCheckHandler: vi.fn(),
    on: vi.fn(),
    clearStorageData: vi.fn(async () => {}),
  };
}
vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: () => ({ isDestroyed: () => false }) },
  session: {
    fromPartition: (id: string) => {
      const value = makeSession(id);
      mock.sessions.set(id, value);
      return value;
    },
  },
  dialog: { showMessageBox: mock.dialog },
  shell: { openExternal: vi.fn() },
}));
vi.mock('../runtime/electronSandboxAdapter.js', () => ({
  GHOST_HTML_CSP: "default-src 'self'",
  registerGhostWebContents: vi.fn(),
}));
vi.mock('../../plugin-oauth/runtime.js', () => ({
  capturePluginOauthPeer: () => () => {
    if (!mock.peerCurrent) throw new Error('CLOSED');
  },
}));
vi.mock('../../device-link/broadcast-tap.js', () => ({
  getSafeDataOwnerPushStamp: () => ({ dataOwnerId: 'owner' }),
}));
vi.mock('../../i18n.js', () => ({ t: (key: string) => key }));
import {
  openRemotePluginSettings,
  closeRemotePluginSettings,
  answerRemotePluginSettingsDirectory,
  resolveRemoteSettingsAttach,
  parseSettingsDocument,
} from '../remotePluginSettingsController.js';

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanup.splice(0)) close();
  mock.handlers.clear();
  mock.sessions.clear();
  mock.peerCurrent = true;
  vi.clearAllMocks();
});
function fixture(namespace: string | null = null) {
  let owner: string | null = 'owner',
    revision = 'installed-1',
    allowed = true;
  const file = Buffer.from(
    '<!doctype html><html><head></head><body><input id="original"><script src="settings.js"></script></body></html>',
  );
  const ghost = {
    instanceKey: namespace ? '_ns__' + namespace + '__example' : 'example',
    namespace,
    enabled: true,
    dir: '/fixture/target-only',
    approval: { state: 'approved' },
    manifest: {
      id: 'example',
      name: 'Original plugin',
      version: '1.0.0',
      settingsHtml: 'settings.html',
      network: { secrets: [{ key: 'login', source: 'oauth' }] },
    },
  } as unknown as InstalledGhost;
  const stored = new Map<string, string>(),
    controllerStored = new Map<string, string>();
  const settingsFetch = vi.fn(
    async (
      _ghost: InstalledGhost,
      path: string,
      method: string,
      body: string | undefined,
      current: () => boolean,
    ) => {
      if (!current()) throw new Error('CLOSED');
      if (method === 'PUT') stored.set(path, body!);
      const data =
        path === '/oauth/login/connect'
          ? { ok: true, account: { label: 'Existing account' } }
          : path === '/oauth'
            ? [{ accounts: [{ label: 'Existing account' }] }]
            : method === 'GET'
              ? { configured: stored.has('/secrets/key') }
              : {};
      return {
        status: 200,
        mime: 'application/json',
        base64: Buffer.from(JSON.stringify(data)).toString('base64'),
      };
    },
  );
  const disconnect = vi.fn(async () => {}),
    post = vi.fn(async () => {}),
    connect = vi.fn(async () => {});
  const validateDirectory = vi.fn<(path: string) => Promise<string>>(
    async () => '/target/resolved',
  );
  const service = new MobilePluginPages({
    list: () => [ghost],
    revision: () => revision,
    captureOwner: () => {
      const captured = owner;
      return () => owner === captured;
    },
    captureController: () => () => allowed,
    unread: () => null,
    clearUnread: vi.fn(),
    setEnabled: vi.fn(),
    bundle: async () => [{ path: 'settings.html', mime: 'text/html', size: file.length }],
    asset: async (_ghost, _file, offset) => ({
      mime: 'text/html',
      base64: file.subarray(offset).toString('base64'),
    }),
    connect,
    post,
    poll: async () => [],
    disconnect,
    fetch: vi.fn(),
    settingsFetch,
    validateDirectory,
  });
  const identity = {
    key: new OauthHostIdentity(),
    deviceId: 'target-b',
    realm: 'global' as const,
    membershipId: 'membership',
  };
  const auth = new AuthenticatedOauthHost({
    owner: () => owner,
    available: () => allowed,
    identity: () => identity,
    bind: async (action) => service.settingsBinding(action),
    request: (peer, raw) => service.settingsRequest(peer, raw as never),
  });
  const wire: unknown[] = [];
  const deps = {
    owner: () => owner,
    assertTarget: () => {
      if (!allowed) throw new Error('REVOKED');
    },
    localDeviceId: () => 'controller-a',
    trustIdentity: vi.fn(async () => {}),
    identity: async () => ({
      ...identity,
      ...identity.key.descriptor,
      observedAtMs: Date.now(),
      expiresAtMs: Date.now() + 60_000,
    }),
    invoke: async (_device: string, channel: string, args: unknown[]) => {
      wire.push(args);
      const result =
        channel === PLUGIN_OAUTH_CHANNEL
          ? await auth.request('controller-a', args[0])
          : channel === REMOTE_RESOURCE_INVOKE_CHANNEL
            ? await service.provider().invoke!(
                { controllerDeviceId: 'controller-a' },
                args[0] as never,
              )
            : undefined;
      return { ok: true as const, result };
    },
    openExternal: vi.fn(async () => {}),
  };
  const host = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    send: vi.fn(),
  }) as unknown as WebContents;
  const open = async () => {
    const view = await openRemotePluginSettings(host, deps, {
      deviceId: 'target-b',
      instanceId: ghost.instanceKey!,
      expectedInstalledApproval: ghostInstallApprovalToken(ghost.approval),
    });
    cleanup.push(() => closeRemotePluginSettings(host, view.id));
    const fetch = (path: string, init?: RequestInit) =>
      mock.handlers.get(view.partition)!(new Request('cindy-ghost://example' + path, init));
    return { view, fetch };
  };
  return {
    service,
    ghost,
    stored,
    controllerStored,
    settingsFetch,
    deps,
    host,
    open,
    post,
    connect,
    disconnect,
    wire,
    auth,
    validateDirectory,
    owner: (value: string | null) => {
      owner = value;
    },
    revision: () => {
      revision = 'replacement';
    },
    revoke: () => {
      allowed = false;
    },
  };
}

describe('original remote plugin settings', () => {
  it.each([null, 'org'])(
    'serves the original HTML in a unique, hardened session for namespace %s',
    async (ns) => {
      const f = fixture(ns),
        { view, fetch } = await f.open();
      const response = await fetch('/settings.html');
      expect(await response.text()).toContain('<input id="original">');
      expect(response.headers.get('Content-Security-Policy')).toBe("default-src 'self'");
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(view.partition).not.toContain('persist:');
      expect(resolveRemoteSettingsAttach(f.host, view.partition, view.src)).toBeTruthy();
      expect(resolveRemoteSettingsAttach({} as WebContents, view.partition, view.src)).toBeNull();
      expect(resolveRemoteSettingsAttach(f.host, view.partition, 'https://example.com')).toBeNull();
      const ses = mock.sessions.get(view.partition)!;
      expect(ses.setPermissionRequestHandler).toHaveBeenCalled();
      expect(ses.setPermissionCheckHandler).toHaveBeenCalled();
    },
  );
  it('writes a new key only to B through the signed encrypted exchange, then reads B status', async () => {
    const f = fixture(),
      { fetch } = await f.open();
    const value = 'synthetic-new-key-only-for-fixture';
    expect(
      (await fetch('/secrets/key', { method: 'PUT', body: JSON.stringify({ value }) })).status,
    ).toBe(200);
    expect(f.stored.get('/secrets/key')).toContain(value);
    expect(f.controllerStored.size).toBe(0);
    expect(JSON.stringify(f.wire)).not.toContain(value);
    expect(await (await fetch('/secrets')).json()).toEqual({ configured: true });
    expect(await (await fetch('/oauth')).json()).toEqual([
      { accounts: [{ label: 'Existing account' }] },
    ]);
  });
  it.each(['owner', 'revision', 'revoke', 'peer'] as const)(
    'rejects a late write after %s changes',
    async (change) => {
      const f = fixture(),
        { fetch } = await f.open();
      if (change === 'owner') f.owner('another-owner');
      else if (change === 'revision') f.revision();
      else if (change === 'revoke') f.revoke();
      else mock.peerCurrent = false;
      expect(
        (await fetch('/secrets/key', { method: 'PUT', body: '{"value":"late"}' })).status,
      ).toBe(503);
      expect(f.stored.size).toBe(0);
    },
  );
  it('rejects unbound channels, arbitrary endpoints and use of the ordinary remote page fetch', async () => {
    const f = fixture(),
      { view, fetch } = await f.open();
    const body = await (await fetch('/settings.html')).text();
    const internal = /src="([^"]+\.js)"/.exec(body)![1].slice(0, -3);
    expect(
      (
        await fetch(internal, {
          method: 'POST',
          body: JSON.stringify({ kind: 'post', channel: 'rogue', data: 'value' }),
        })
      ).status,
    ).toBe(503);
    expect((await fetch('/arbitrary-host-api', { method: 'POST', body: '{}' })).status).toBe(503);
    expect(f.post).not.toHaveBeenCalled();
    const page = [...(f.service as unknown as { pages: Map<string, unknown> }).pages.keys()][0];
    await expect(
      f.service.provider().invoke!(
        { controllerDeviceId: 'controller-a' },
        {
          client: { protocolVersion: 1, primitives: [] },
          collectionId: 'plugins',
          actionId: 'fetch',
          resourceRef: { collectionId: 'plugins', kind: 'plugin', id: f.ghost.instanceKey! },
          input: { pageId: page, path: '/secrets' },
        },
      ),
    ).rejects.toThrow();
    closeRemotePluginSettings(f.host, view.id);
    expect(mock.handlers.has(view.partition)).toBe(false);
  });
  it('updates the original sandbox subscriptions and prevents posting after unsubscribe', async () => {
    const f = fixture(),
      { fetch } = await f.open();
    const html = await (await fetch('/settings.html')).text();
    const internal = /src="([^"]+\.js)"/.exec(html)![1].slice(0, -3);
    const send = (command: unknown) =>
      fetch(internal, { method: 'POST', body: JSON.stringify(command) });
    expect((await send({ kind: 'subscribe', channels: ['one', 'two'] })).status).toBe(200);
    expect(f.connect).toHaveBeenLastCalledWith(f.ghost, expect.any(String), ['one', 'two']);
    expect((await send({ kind: 'unsubscribe', channel: 'one' })).status).toBe(200);
    expect(f.connect).toHaveBeenLastCalledWith(f.ghost, expect.any(String), ['two']);
    expect((await send({ kind: 'post', channel: 'one', data: { stale: true } })).status).toBe(503);
    expect(f.post).not.toHaveBeenCalled();
    expect((await send({ kind: 'post', channel: 'two', data: { active: true } })).status).toBe(200);
    expect(f.post).toHaveBeenCalledTimes(1);
  });
  it('checks the lease inside the original endpoint after its body has been read', async () => {
    const f = fixture(),
      { fetch } = await f.open();
    let resume!: () => void;
    const reading = new Promise<void>((resolve) => {
      resume = resolve;
    });
    f.settingsFetch.mockImplementationOnce(async (_ghost, path, _method, body, current) => {
      await reading;
      if (!current()) throw new Error('CLOSED');
      f.stored.set(path, body!);
      return { status: 200, mime: 'application/json', base64: '' };
    });
    const writing = fetch('/secrets/key', { method: 'PUT', body: '{"value":"fixture"}' });
    await vi.waitFor(() => expect(f.settingsFetch).toHaveBeenCalledTimes(1));
    f.revoke();
    resume();
    expect((await writing).status).toBe(503);
    expect(f.stored.size).toBe(0);
  });
  it('returns a trusted directory selection to the target picker through the sealed page', async () => {
    const f = fixture(),
      { view, fetch } = await f.open();
    const pageId = [...(f.service as unknown as { pages: Map<string, unknown> }).pages.keys()][0];
    const selection = f.service.chooseDirectory(
      pageId,
      f.ghost.instanceKey!,
      'Choose a parent folder',
    );
    const html = await (await fetch('/settings.html')).text();
    const internal = /src="([^"]+\.js)"/.exec(html)![1].slice(0, -3);
    const response = await fetch(internal, {
      method: 'POST',
      body: JSON.stringify({ kind: 'poll', after: 0 }),
    });
    expect((await response.json()).directories).toBeUndefined();
    const notice = vi
      .mocked(f.host.send)
      .mock.calls.find((call) => call[0] === 'device-link:plugin-settings:directory')![1];
    const answer = { viewId: view.id, requestId: notice.request.id, path: '/target/folder' };
    await expect(answerRemotePluginSettingsDirectory({} as WebContents, answer)).rejects.toThrow();
    expect(f.validateDirectory).not.toHaveBeenCalled();
    await answerRemotePluginSettingsDirectory(f.host, answer);
    expect(await selection).toBe('/target/resolved');
    expect(f.validateDirectory).toHaveBeenCalledWith('/target/folder');
    await answerRemotePluginSettingsDirectory(f.host, answer);
    expect(f.validateDirectory).toHaveBeenCalledTimes(1);
  });
  it('binds OAuth to the page and executes its original endpoint inside the existing remote authorization context', async () => {
    const f = fixture();
    await f.open();
    const pageId = [...(f.service as unknown as { pages: Map<string, unknown> }).pages.keys()][0];
    const action = (await f.service.settingsRequest('controller-a', {
      op: 'settings',
      id: pageId,
      command: { kind: 'authorize', path: '/oauth/login/connect' },
    })) as { requestId: string; actionId: string; expectedRevision: number };
    const finish = vi.fn();
    f.settingsFetch.mockImplementationOnce(async (_ghost, _path, _method, _body, current) => {
      expect(current()).toBe(true);
      expect(getRemoteOauthContext()?.peer).toBe('controller-a');
      return {
        status: 200,
        mime: 'application/json',
        base64: Buffer.from('{"ok":true}').toString('base64'),
      };
    });
    withRemoteOauthContext(
      { scope: 'fixture', peer: 'controller-a', assertCurrent() {}, authorize: vi.fn(), finish },
      () => expect(f.service.runSettingsAuthorization(action)).toBe(true),
    );
    await vi.waitFor(() => expect(finish).toHaveBeenCalledWith(true));
    const result = (await f.service.settingsRequest('controller-a', {
      op: 'settings',
      id: pageId,
      command: { kind: 'authorization-result', requestId: action.requestId },
    })) as { base64: string };
    expect(Buffer.from(result.base64, 'base64').toString()).toBe('{"ok":true}');
    expect(f.service.settingsAuthorizationBinding(action)).toBeNull();
  });
  it('rejects foreign identities and unsafe package descriptors', () => {
    expect(() =>
      parseSettingsDocument({ pageId: 'p', pluginId: 'elsewhere' }, 'example'),
    ).toThrow();
    expect(() =>
      parseSettingsDocument(
        {
          pageId: 'p',
          pluginId: 'example',
          manifestId: 'example',
          name: 'Plugin',
          entry: '../outside.html',
          files: [],
        },
        'example',
      ),
    ).toThrow();
  });
});
