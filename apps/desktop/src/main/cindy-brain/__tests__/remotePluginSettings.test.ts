import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WebContents } from 'electron';
import { PLUGIN_OAUTH_CHANNEL, REMOTE_RESOURCE_INVOKE_CHANNEL } from '@cindy/device-link';
import { MobilePluginPages } from '../mobilePageService.js';
import { GhostModelPicker } from '../ghostModelPicker.js';
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
  answerRemotePluginSettingsModelPicker,
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
function fixture(namespace: string | null = null,
  answerModelPicker?: ConstructorParameters<typeof MobilePluginPages>[0]['answerModelPicker']) {
  let owner: string | null = 'owner',
    revision = 'installed-1',
    allowed = true,
    nowOffset = 0;
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
  const settingsFetch = vi.fn<
    NonNullable<ConstructorParameters<typeof MobilePluginPages>[0]['settingsFetch']>
  >(
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
    post = vi.fn(async (_ghost: InstalledGhost, _pageId: string, _channel: string, _data: unknown, _sourceId?: string) => {}),
    connect = vi.fn(async () => {}),
    poll = vi.fn(async (): Promise<any[]> => []);
  const validateDirectory = vi.fn<(path: string) => Promise<string>>(
    async () => '/target/resolved',
  );
  const service = new MobilePluginPages({
    answerModelPicker,
    now: () => Date.now() + nowOffset,
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
    poll,
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
    identity: async () => {
      const observedAtMs = Date.now();
      return {
        ...identity,
        ...identity.key.descriptor,
        observedAtMs,
        expiresAtMs: observedAtMs + 60_000,
      };
    },
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
    advance: (ms: number) => { nowOffset += ms; },
    now: () => Date.now() + nowOffset,
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
    poll,
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
  it('advertises controller-routed settings authorization in the opened document', async () => {
    const f = fixture();
    const response = await f.service.provider().invoke!(
      { controllerDeviceId: 'controller-a' },
      { collectionId: 'plugins', actionId: 'settings:open', resourceRef: { collectionId: 'plugins', kind: 'plugin', id: f.ghost.instanceKey }, input: { expectedInstalledApproval: ghostInstallApprovalToken(f.ghost.approval) } } as never,
    );
    expect(response).toMatchObject({ result: { controllerAuthorization: true, pluginId: f.ghost.instanceKey } });
  });
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
  it('carries a credential check only inside the encrypted settings session', async () => {
    const f = fixture(), { fetch } = await f.open();
    f.settingsFetch.mockResolvedValueOnce({ status: 200, mime: 'application/json', base64: Buffer.from('{"valid":true}').toString('base64') });
    const value = 'synthetic-check-candidate';
    expect(await (await fetch('/secrets/key/check', { method: 'POST', body: JSON.stringify({ value }) })).json()).toEqual({ valid: true });
    expect(f.settingsFetch).toHaveBeenCalledWith(expect.anything(), '/secrets/key/check', 'POST', JSON.stringify({ value }), expect.any(Function), expect.any(Function));
    expect(JSON.stringify(f.wire)).not.toContain(value);
    expect(f.controllerStored.size).toBe(0);
  });
  it('writes a new key only to B through the signed encrypted exchange, then reads B status', async ({ onTestFinished }) => {
    // Unit regression: the real handshake/write must work when each clock read advances 1 ms.
    // The wall-clock fixture previously missed this boundary and intermittently failed in CI.
    let now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now++);
    onTestFinished(() => clock.mockRestore());
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
  it('renews before the authenticated message budget runs out, including concurrent reads', async () => {
    const f = fixture(),
      { fetch } = await f.open();
    for (let offset = 0; offset < 1050; offset += 50) {
      const responses = await Promise.all(Array.from({ length: 50 }, () => fetch('/secrets')));
      expect(responses.every((response) => response.status === 200)).toBe(true);
    }
    expect(f.deps.trustIdentity).toHaveBeenCalledTimes(2);
    expect(
      (await fetch('/secrets/key', { method: 'PUT', body: '{"value":"after-renewal"}' })).status,
    ).toBe(200);
    expect(f.stored.get('/secrets/key')).toContain('after-renewal');
  });
  it('does not renew and replay a write after its response is lost', async () => {
    const f = fixture(),
      { fetch } = await f.open();
    const original = f.deps.invoke;
    f.deps.invoke = async (device, channel, args) => {
      const response = await original(device, channel, args);
      if (channel === PLUGIN_OAUTH_CHANNEL) throw new Error('Response lost');
      return response;
    };
    expect(
      (await fetch('/secrets/key', { method: 'PUT', body: '{"value":"submitted-once"}' })).status,
    ).toBe(503);
    expect(f.settingsFetch).toHaveBeenCalledTimes(1);
    expect(f.stored.get('/secrets/key')).toContain('submitted-once');
    expect(f.deps.trustIdentity).toHaveBeenCalledTimes(1);
  });
  it('renews while a save awaits confirmation, then returns the original save result', async () => {
    const f = fixture(),
      { fetch } = await f.open();
    const html = await (await fetch('/settings.html')).text();
    const internal = /src="([^"]+\.js)"/.exec(html)![1].slice(0, -3);
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    let poll: Promise<Response> | undefined;
    let writing: Promise<Response> | undefined;
    try {
      for (const elapsed of [100_000, 200_000, 239_000]) {
        clock.mockReturnValue(now + elapsed);
        expect((await fetch('/secrets')).status).toBe(200);
      }
      f.settingsFetch.mockImplementationOnce(
        async (_ghost, path, _method, body, current, confirmConnection) => {
          if (!(await confirmConnection!('New connection', 'example.invalid')) || !current())
            throw new Error('CLOSED');
          f.stored.set(path, body!);
          return { status: 200, mime: 'application/json', base64: '' };
        },
      );
      mock.dialog.mockResolvedValueOnce({ response: 0 });
      writing = fetch('/connections/account', { method: 'PUT', body: '{"label":"new"}' });
      await vi.waitFor(() => expect(f.settingsFetch).toHaveBeenCalledTimes(4));
      clock.mockReturnValue(now + 241_000);
      poll = fetch(internal, { method: 'POST', body: '{"kind":"poll","after":0}' });
      await vi.waitFor(() => expect(mock.dialog).toHaveBeenCalledTimes(1));
      expect((await poll).status).toBe(200);
      expect((await writing).status).toBe(200);
      expect(f.stored.get('/connections/account')).toBe('{"label":"new"}');
      expect(f.deps.trustIdentity).toHaveBeenCalledTimes(2);
      expect(f.settingsFetch).toHaveBeenCalledTimes(4);
    } finally {
      const pageId = [...(f.service as unknown as { pages: Map<string, unknown> }).pages.keys()][0];
      await f.service.settingsRequest('controller-a', {
        op: 'settings',
        id: pageId,
        command: { kind: 'close' },
      });
      await Promise.allSettled([poll, writing]);
      clock.mockRestore();
    }
  });
  it('renews all four open settings pages without closing any page or consuming another slot', async () => {
    const f = fixture();
    const pages = await Promise.all(Array.from({ length: 4 }, () => f.open()));
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      for (const elapsed of [100_000, 200_000, 241_000]) {
        clock.mockReturnValue(now + elapsed);
        const responses = await Promise.all(pages.map(({ fetch }) => fetch('/secrets')));
        expect(responses.map((response) => response.status)).toEqual([200, 200, 200, 200]);
      }
      expect(f.deps.trustIdentity).toHaveBeenCalledTimes(8);
      expect(f.disconnect).not.toHaveBeenCalled();
      expect(
        (await pages[0].fetch('/secrets/key', { method: 'PUT', body: '{"value":"renewed"}' }))
          .status,
      ).toBe(200);
      expect(f.stored.get('/secrets/key')).toContain('renewed');
    } finally {
      clock.mockRestore();
    }
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
  // New native request/result across the existing sealed settings channel. Unlike catalog GET,
  // this must bind the answering host and withhold native requests from author HTML. Tier: unit.
  it('returns model configuration from the originating remote settings view and strips native picker requests from author polling', async () => {
    let picker!: GhostModelPicker;
    const f = fixture(null, (page, id, route) => picker.resolve(page, id, route));
    picker = new GhostModelPicker({ getGhost: () => f.ghost, installation: () => 'installed-1',
      target: (id, page) => page ? f.service.modelPickerTarget(page, id) : null,
      available: async () => true });
    cleanup.push(() => picker.cancel());
    const { view, fetch } = await f.open();
    const pageId = [...(f.service as unknown as { pages: Map<string, unknown> }).pages.keys()][0];
    const selected = picker.request(f.ghost.instanceKey!, { mobilePageId: pageId });
    const html = await (await fetch('/settings.html')).text();
    const internal = /src="([^"]+\.js)"/.exec(html)![1].slice(0, -3);
    const poll = await fetch(internal, { method: 'POST', body: JSON.stringify({ kind: 'poll', after: 0 }) });
    expect((await poll.json()).modelPickers).toBeUndefined();
    const notice = vi.mocked(f.host.send).mock.calls.find(call => call[0] === 'ghosts:model-picker:request')![1];
    expect(notice).toMatchObject({ deviceId: 'target-b', remoteViewId: view.id, ghostId: f.ghost.instanceKey });
    const route = { agentKind: 'codex', providerId: 'target-provider', model: 'model', effort: 'high', fastMode: true };
    const answer = { viewId: view.id, requestId: notice.requestId, route };
    await expect(answerRemotePluginSettingsModelPicker({} as WebContents, answer)).rejects.toThrow();
    expect(await answerRemotePluginSettingsModelPicker(f.host, answer)).toEqual({ handled: true, accepted: true });
    expect(await selected).toEqual({ ok: true, route });
    expect(f.host.send).toHaveBeenCalledWith('ghosts:model-picker:dismissed', { requestId: notice.requestId }, expect.anything());
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
  // Production settingsRequest/binding must survive a phone backgrounding during OAuth.
  // Existing happy-path coverage never advances time; 121s idle is the minimal failure.
  // Unit tier: in-memory endpoint/context, no provider tokens or external OAuth involved.
  it.each([['page', true], ['sweep', false]] as const)('retains only an in-flight OAuth lease through %s after 120s idle (success=%s)', async (entry, success) => {
    const f = fixture();
    await f.open();
    const pageId = [...(f.service as unknown as { pages: Map<string, unknown> }).pages.keys()][0];
    const action = await f.service.settingsRequest('controller-a', {
      op: 'settings', id: pageId, command: {kind: 'authorize', path: '/oauth/login/connect'},
    }) as {requestId: string; actionId: string; expectedRevision: number};
    let resolve!: (result: {status: number; mime: string; base64: string}) => void;
    f.settingsFetch.mockImplementationOnce(() => new Promise(done => {resolve = done;}));
    const finish = vi.fn();
    const cancelled = new AbortController();
    withRemoteOauthContext({scope: 'fixture', peer: 'controller-a', expiresAt: f.now() + 300_000,
      cancelled: cancelled.signal, assertCurrent() {}, authorize: vi.fn(), finish},
      () => expect(f.service.runSettingsAuthorization(action)).toBe(true));
    f.advance(121_000);
    if (entry === 'sweep') f.service.notify(pageId, 'example', 'fixture notification');
    expect(f.service.settingsAuthorizationBinding(action)?.current()).toBe(true);
    resolve({status: 200, mime: 'application/json', base64: Buffer.from(JSON.stringify({ok: success})).toString('base64')});
    await Promise.resolve();
    expect(finish).toHaveBeenCalledWith(success);
    // A terminal authorization stays single-use until its result is consumed.
    withRemoteOauthContext({scope: 'replay', peer: 'controller-a', expiresAt: f.now() + 300_000,
      assertCurrent() {}, authorize: vi.fn(), finish},
      () => expect(f.service.runSettingsAuthorization(action)).toBe(false));
    expect(f.settingsFetch).toHaveBeenCalledTimes(1);
    f.advance(121_000);
    await expect(f.service.settingsRequest('controller-a', {op: 'settings', id: pageId,
      command: {kind: 'poll', after: 0}})).rejects.toThrow();
  });
  it.each(['deadline', 'cancel', 'close', 'owner', 'controller', 'approval', 'no-deadline', 'not-started'] as const)(
    'does not retain an OAuth page after %s', async (reason) => {
      const f = fixture();
      await f.open();
      const pageId = [...(f.service as unknown as {pages: Map<string, unknown>}).pages.keys()][0];
      const action = await f.service.settingsRequest('controller-a', {op: 'settings', id: pageId,
        command: {kind: 'authorize', path: '/oauth/login/connect'}}) as {requestId: string; actionId: string; expectedRevision: number};
      let resolve!: (result: {status: number; mime: string; base64: string}) => void;
      const cancelled = new AbortController();
      const finish = vi.fn();
      if (reason !== 'not-started') {
        f.settingsFetch.mockImplementationOnce(() => new Promise(done => {resolve = done;}));
        withRemoteOauthContext({scope: 'fixture', peer: 'controller-a',
          expiresAt: reason === 'no-deadline' ? undefined : f.now() + 300_000,
          cancelled: cancelled.signal, assertCurrent() {}, authorize: vi.fn(), finish},
          () => expect(f.service.runSettingsAuthorization(action)).toBe(true));
      }
      f.advance(reason === 'deadline' ? 300_000 : 121_000);
      if (reason === 'cancel') cancelled.abort();
      if (reason === 'close') await f.service.settingsRequest('controller-a', {op: 'settings', id: pageId, command: {kind: 'close'}});
      if (reason === 'owner') f.owner('replacement');
      if (reason === 'controller') f.revoke();
      if (reason === 'approval') f.revision();
      f.service.notify(pageId, 'example', 'fixture notification');
      expect(f.service.settingsAuthorizationBinding(action)?.current() ?? false).toBe(false);
      await expect(f.service.settingsRequest('controller-a', {op: 'settings', id: pageId,
        command: {kind: 'poll', after: 0}})).rejects.toThrow();
      resolve?.({status: 200, mime: 'application/json', base64: Buffer.from('{"ok":true}').toString('base64')});
      await Promise.resolve();
      if (reason !== 'not-started') expect(finish).toHaveBeenCalledWith(false);
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

// #6680 post-merge P1: unseen confirmations and directory replies survive package navigation.
// Real Host entry, in-memory transport. Existing tests only covered lease close/revocation.
// Minimal input: A creates a prompt, document advances before poll/answer, then B queries.
it.each([false, true])('invalidates document prompts while retaining Host notices and another page (polled=%s)', async (polled) => {
  const f = fixture();
  const opened = await f.service.provider().invoke!({ controllerDeviceId: 'controller-a' }, {
    collectionId: 'plugins', actionId: 'settings:open', resourceRef: { collectionId: 'plugins', kind: 'plugin', id: f.ghost.instanceKey },
    input: { expectedInstalledApproval: ghostInstallApprovalToken(f.ghost.approval) },
  } as never);
  const pageId = (opened.result as any).pageId;
  const send = (command: any) => f.service.settingsRequest('controller-a', { op: 'settings', id: pageId, command });
  cleanup.push(() => { void send({ kind: 'close' }).catch(() => {}); });
  const advance = (epoch: number) => send({ kind: 'document', epoch });
  const origin = async () => {
    await send({ kind: 'subscribe', channels: ['test'] });
    await send({ kind: 'post', channel: 'test', data: { op: 'action' } });
    return f.post.mock.calls.at(-1)![4] as string;
  };
  await advance(1);
  const a = await origin();
  const params = { ghostId: f.ghost.instanceKey!, ghostName: 'Original plugin', body: 'A action', confirmText: null, cancelText: null, danger: false };
  await f.open();
  const otherPageId = [...(f.service as unknown as { pages: Map<string, unknown> }).pages.keys()].find(id => id !== pageId)!;
  const otherAnswer = f.service.confirm(otherPageId, params);
  const confirm = f.service.confirm(a, params);
  const directory = f.service.chooseDirectory(a, f.ghost.instanceKey!, 'A folder');
  const pending = polled ? await send({ kind: 'poll', after: 0 }) as any : null;
  const currentA = f.service.captureSource(a, f.ghost.instanceKey!);
  expect(currentA()).toBe(true);
  expect(f.service.notify(a, f.ghost.instanceKey!, 'Saved on Host')).toBe(true);
  await advance(2);
  expect(await confirm).toBe(false);
  expect(await directory).toBeNull();
  const otherPoll = await f.service.settingsRequest('controller-a', { op: 'settings', id: otherPageId, command: { kind: 'poll', after: 0 } }) as any;
  expect(otherPoll.confirms).toHaveLength(1);
  await f.service.settingsRequest('controller-a', { op: 'settings', id: otherPageId, command: { kind: 'confirm', requestId: otherPoll.confirms[0].id, accepted: true } });
  expect(await otherAnswer).toBe(true);
  expect(currentA()).toBe(false);
  expect(await send({ kind: 'poll', after: 0 })).toMatchObject({ confirms: [], directories: [], notifications: [{ text: 'Saved on Host' }] });
  if (pending) {
    await expect(send({ kind: 'confirm', requestId: pending.confirms[0].id, accepted: true })).rejects.toThrow();
    await expect(send({ kind: 'answer-directory', requestId: pending.directories[0].id, path: '/target/folder' })).rejects.toThrow();
  }
  await expect(f.service.confirm(a, params)).rejects.toThrow();
  await expect(f.service.chooseDirectory(a, f.ghost.instanceKey!, 'Late A')).rejects.toThrow();
  expect(f.service.notify(a, f.ghost.instanceKey!, 'A finished saving')).toBe(true);
  const b = await origin();
  expect(b).not.toBe(a);
  const bDirectory = f.service.chooseDirectory(b, f.ghost.instanceKey!, 'B folder');
  const bAnswer = f.service.confirm(b, params);
  await advance(2); // Duplicate acknowledgement must not cancel B.
  const bPoll = await send({ kind: 'poll', after: 0 }) as any;
  await send({ kind: 'confirm', requestId: bPoll.confirms[0].id, accepted: true });
  expect(await bAnswer).toBe(true);
  await send({ kind: 'answer-directory', requestId: bPoll.directories[0].id, path: '/target/folder' });
  expect(await bDirectory).toBe('/target/resolved');
  expect(bPoll.notifications).toEqual([expect.objectContaining({ text: 'A finished saving' })]);
  await expect(advance(1)).rejects.toThrow();
  await send({ kind: 'close' });
  expect(f.service.notify(a, f.ghost.instanceKey!, 'closed')).toBe(false);
});

it('rejects a directory answer and a delayed fetch confirmation after document replacement', async () => {
  const f = fixture();
  await f.open();
  const pageId = [...(f.service as unknown as { pages: Map<string, unknown> }).pages.keys()][0];
  const send = (command: any) => f.service.settingsRequest('controller-a', { op: 'settings', id: pageId, command });
  await send({ kind: 'document', epoch: 1 });
  await send({ kind: 'subscribe', channels: ['test'] });
  await send({ kind: 'post', channel: 'test', data: {} });
  const source = f.post.mock.calls.at(-1)![4] as string;
  const chosen = f.service.chooseDirectory(source, f.ghost.instanceKey!, 'A');
  const poll = await send({ kind: 'poll', after: 0 }) as any;
  let resolvePath!: (path: string) => void;
  f.validateDirectory.mockImplementationOnce(() => new Promise(resolve => { resolvePath = resolve; }));
  const answering = send({ kind: 'answer-directory', requestId: poll.directories[0].id, path: '/target/folder' });
  let delayedConfirm!: () => Promise<boolean>;
  let fetchCurrent!: () => boolean;
  f.settingsFetch.mockImplementationOnce(async (_ghost, _path, _method, _body, current, confirmConnection) => {
    fetchCurrent = current;
    delayedConfirm = () => confirmConnection!('Service', 'example.com');
    return { status: 200, mime: 'application/json', base64: '' };
  });
  await send({ kind: 'fetch', path: '/connections/service', method: 'POST' });
  await send({ kind: 'document', epoch: 2 });
  resolvePath('/target/folder');
  await expect(answering).rejects.toThrow();
  expect(await chosen).toBeNull();
  expect(fetchCurrent()).toBe(false);
  await expect(delayedConfirm()).rejects.toThrow();
});

it('does not return B prompts or events in a poll started by document A', async () => {
  const f = fixture();
  await f.open();
  const pageId = [...(f.service as unknown as { pages: Map<string, unknown> }).pages.keys()][0];
  const send = (command: any) => f.service.settingsRequest('controller-a', { op: 'settings', id: pageId, command });
  await send({ kind: 'document', epoch: 1 });
  await send({ kind: 'subscribe', channels: ['test'] });
  let finish!: (events: any[]) => void;
  f.poll.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const aPoll = send({ kind: 'poll', after: 0 });
  await send({ kind: 'document', epoch: 2 });
  await send({ kind: 'post', channel: 'test', data: {} });
  const b = f.post.mock.calls.at(-1)![4]!;
  const answer = f.service.confirm(b, { ghostId: f.ghost.instanceKey!, ghostName: 'B', body: 'B action', confirmText: null, cancelText: null, danger: false });
  finish([{ sequence: 1, channel: 'test', data: 'B event' }]);
  expect(await aPoll).toMatchObject({ events: [], confirms: [], directories: [] });
  const bPoll = await send({ kind: 'poll', after: 0 }) as any;
  expect(bPoll.confirms).toHaveLength(1);
  await send({ kind: 'confirm', requestId: bPoll.confirms[0].id, accepted: true });
  expect(await answer).toBe(true);
});
