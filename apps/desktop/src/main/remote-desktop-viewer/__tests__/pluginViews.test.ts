// 测试价值：保护「插件在自己的页面里查看另一台电脑上的设备画面」这条通道的边界——只有声明了设备画面
// 能力的插件能用、只能看到并打开那台电脑上同一个插件的设备、画面按插件自己的流格式送达（新读者先拿到
// 状态与解码配置并要一帧完整画面）、输入只接受触摸 / 设备按键 / 打字、插件停用后地址立即失效。此前
// 没有这条通道（设备画面由宿主自己画）。最小输入：一个假的转发窗口与一份设备列表；unit tier，真实本机
// 回环 HTTP，单独约 1 秒。
import { EventEmitter } from 'node:events';
import http from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';
import type { WebContents } from 'electron';
import { LIVE_SCREEN_RELAY } from '../../../shared/liveScreenView.js';
import {
  parsePluginStoragePart,
  pluginStoragePart,
  installedGhostLogicalIdentity,
} from '../../../shared/pluginIdentity.js';
import { PluginLiveScreenViews } from '../pluginViews.js';

function fakeHost() {
  const emitter = new EventEmitter();
  const sent: { channel: string; payload: Record<string, unknown> }[] = [];
  const host = Object.assign(emitter, {
    isDestroyed: () => false,
    send: (channel: string, payload: Record<string, unknown>) =>
      void sent.push({ channel, payload }),
  });
  return { host: host as unknown as WebContents, sent, emitter };
}
const listed = (plugin: string, id: string, taskIds: string[]) => ({
  plugin,
  pluginIdentity: pluginStoragePart(parsePluginStoragePart(plugin)!),
  pluginName: 'Device Simulator',
  id,
  name: `Device ${id}`,
  platform: 'ios',
  state: 'running',
  taskIds,
});
function setup(allowed = ['sim']) {
  const invoke = vi.fn(async (_deviceId: string, request: { op: string }) =>
    request.op === 'capabilities'
      ? { version: 1, enabled: true, liveScreens: true }
      : // That computer keeps the plugin under its newer install key.
        { screens: [listed('_root__sim', 'a', ['t1']), listed('other', 'b', ['t1'])] },
  );
  const allow = new Set(allowed);
  const views = new PluginLiveScreenViews({
    available: () => true,
    identity: (instance) =>
      allow.has(instance) ? pluginStoragePart(parsePluginStoragePart(instance)!) : null,
  });
  views.connect({ selfDeviceId: () => 'self', invoke });
  const relay = fakeHost();
  views.setHost(relay.host);
  return { views, invoke, relay, allow };
}
/** Reads the stream until `count` messages arrived, as [type, payload] pairs. */
function read(url: string, count: number): Promise<[number, Buffer][]> {
  return new Promise((resolve, reject) => {
    const request = http.get(`${url}/stream`, (response) => {
      let buffer = Buffer.alloc(0);
      const messages: [number, Buffer][] = [];
      response.on('data', (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        while (buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32BE(0)) {
          const length = buffer.readUInt32BE(0);
          messages.push([buffer[4], buffer.subarray(5, 4 + length)]);
          buffer = buffer.subarray(4 + length);
        }
        if (messages.length >= count) {
          request.destroy();
          resolve(messages);
        }
      });
      response.on('end', () => resolve(messages));
    });
    request.on('error', (error) => (request.destroyed ? undefined : reject(error)));
  });
}
function post(
  url: string,
  body: unknown,
): Promise<{ status: number; body: { ok?: boolean; errorCode?: string } }> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      `${url}/input`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' } },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
          }),
        );
      },
    );
    request.on('error', reject);
    request.end(JSON.stringify(body));
  });
}
const json = (payload: Buffer) => JSON.parse(payload.toString('utf8')) as Record<string, unknown>;
const until = async (check: () => boolean) => {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  expect(check()).toBe(true);
};

let current: PluginLiveScreenViews | null = null;
afterEach(() => {
  current?.endAll();
  current = null;
});

it('lists and opens only the asking plugin’s own screens on another computer', async () => {
  const { views, relay } = setup();
  current = views;
  expect(await views.handle('other-plugin', { op: 'screens', deviceId: 'remote' })).toEqual({
    ok: false,
    errorCode: 'PERMISSION_DENIED',
  });
  expect(await views.handle('sim', { op: 'screens', deviceId: 'self' })).toMatchObject({
    ok: false,
    errorCode: 'INVALID_ARGUMENT',
  });
  expect(await views.handle('sim', { op: 'screens', deviceId: 'remote' })).toEqual({
    ok: true,
    screens: [{ id: 'a', name: 'Device a', platform: 'ios', taskIds: ['t1'] }],
  });
  const opened = (await views.handle('sim', { op: 'open', deviceId: 'remote', id: 'a' })) as {
    ok: boolean;
    view: string;
    url: string;
  };
  expect(opened.ok).toBe(true);
  expect(opened.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{64}$/);
  // The window is told which plugin's screen to connect: always the asking plugin's.
  expect(relay.sent).toEqual([
    {
      channel: LIVE_SCREEN_RELAY.START,
      payload: {
        relayId: expect.stringMatching(/^lr-/),
        deviceId: 'remote',
        screen: { plugin: '_root__sim', id: 'a', pluginIdentity: 'sim' },
      },
    },
  ]);
  // Another plugin's screen there, or one that is not listed, cannot be opened.
  expect(await views.handle('sim', { op: 'open', deviceId: 'remote', id: 'b' })).toEqual({
    ok: false,
    errorCode: 'SCREEN_NOT_FOUND',
  });
  // The same device again is the same view, not a second connection.
  expect(await views.handle('sim', { op: 'open', deviceId: 'remote', id: 'a' })).toEqual(opened);
  expect(relay.sent).toHaveLength(1);
});

it('serves the picture in the plugin stream format and takes only device input', async () => {
  const { views, relay } = setup();
  current = views;
  const { url } = (await views.handle('sim', { op: 'open', deviceId: 'remote', id: 'a' })) as {
    url: string;
  };
  const relayId = relay.sent[0].payload.relayId;
  const screen = {
    plugin: '_root__sim',
    id: 'a',
    name: 'Device a',
    platform: 'ios',
    cornerRadius: 0.1,
    maxTouches: 2,
    keyboard: true,
    buttons: [{ id: 'home', icon: 'home', label: 'Home' }],
  };
  // Not live yet: nothing may be typed into a device that is still connecting.
  expect((await post(url, { events: [{ kind: 'press', button: 'home' }] })).body).toEqual({
    ok: false,
    errorCode: 'VIEW_NOT_READY',
  });
  views.state(relay.host, relayId, { status: 'live', screen, width: 1170, height: 2532 });
  views.frame(relay.host, relayId, 1, new Uint8Array([1, 100, 0, 51]));
  const reading = read(url, 5);
  await until(() => relay.sent.some((item) => item.channel === LIVE_SCREEN_RELAY.KEYFRAME));
  // A delta before the reader's first keyframe is useless to it and is not sent.
  views.frame(relay.host, relayId, 3, new Uint8Array([9]));
  views.frame(relay.host, relayId, 2, new Uint8Array([7, 7]));
  const messages = await reading;
  expect(messages.map(([type]) => type)).toEqual([0x10, 0x10, 0x10, 0x01, 0x02]);
  expect(json(messages[0][1])).toMatchObject({ type: 'device', id: 'a', maxTouches: 2 });
  expect(json(messages[0][1])).not.toHaveProperty('plugin');
  expect(json(messages[1][1])).toEqual({ type: 'screen', width: 1170, height: 2532 });
  expect(json(messages[2][1])).toEqual({ type: 'state', state: 'live' });
  expect([...messages[4][1]]).toEqual([7, 7]);

  const touch = { kind: 'touch', touches: [{ id: 0, x: 0.5, y: 0.5, phase: 'began' }] };
  expect((await post(url, { events: [touch] })).body).toEqual({ ok: true });
  expect(relay.sent.at(-1)).toEqual({
    channel: LIVE_SCREEN_RELAY.INPUT,
    payload: { relayId, events: [touch] },
  });
  // A computer's mouse and scrolling are not device input.
  expect((await post(url, { events: [{ kind: 'move', x: 0.1, y: 0.1 }] })).status).toBe(400);
  expect(
    (await post(url.replace(/[0-9a-f]{64}$/, 'f'.repeat(64)), { events: [touch] })).status,
  ).toBe(404);
});

it('ends a view when its plugin is turned off or the connection ends', async () => {
  const { views, relay, allow } = setup();
  current = views;
  const first = (await views.handle('sim', { op: 'open', deviceId: 'remote', id: 'a' })) as {
    url: string;
  };
  const reading = read(first.url, 99);
  await until(() => relay.sent.some((item) => item.channel === LIVE_SCREEN_RELAY.KEYFRAME));
  allow.delete('sim');
  views.invalidate('sim');
  const messages = await reading;
  expect(json(messages.at(-1)![1])).toEqual({ type: 'state', state: 'ended', error: 'CLOSED' });
  expect(relay.sent.at(-1)?.channel).toBe(LIVE_SCREEN_RELAY.STOP);
  expect(await views.handle('sim', { op: 'open', deviceId: 'remote', id: 'a' })).toEqual({
    ok: false,
    errorCode: 'PERMISSION_DENIED',
  });
});

// Regression inputs for the public open API: deferred screen discovery creates
// interleavings not covered by the sequential open and settled-revocation tests.
// Unit tier: one in-process fake host and the existing loopback listener.
function deferredScreens(fixture: ReturnType<typeof setup>) {
  let resolve!: (value: unknown) => void;
  const pending = new Promise((done) => {
    resolve = done;
  });
  fixture.invoke.mockImplementation(async (_device, request) =>
    request.op === 'capabilities'
      ? { version: 1, enabled: true, liveScreens: true }
      : ((await pending) as never),
  );
  return { resolve, listed: [listed('_root__sim', 'a', ['t1'])] };
}

it('shares concurrent opens and counts pending different targets against capacity', async () => {
  const fixture = setup();
  current = fixture.views;
  const deferred = deferredScreens(fixture);
  const opens = ['a', 'a', 'b', 'c', 'd', 'e'].map((id) =>
    fixture.views.handle('sim', { op: 'open', deviceId: 'remote', id }),
  );
  await until(() => fixture.invoke.mock.calls.some(([, request]) => request.op === 'screens'));
  deferred.resolve({
    screens: ['a', 'b', 'c', 'd', 'e'].map((id) => listed('_root__sim', id, ['t1'])),
  });
  const result = await Promise.all(opens);
  expect(result[0]).toEqual(result[1]);
  expect(result.filter((item) => (item as { ok: boolean }).ok)).toHaveLength(5);
  expect(result[5]).toEqual({ ok: false, errorCode: 'TOO_MANY_VIEWS' });
  expect(
    fixture.relay.sent.filter((item) => item.channel === LIVE_SCREEN_RELAY.START),
  ).toHaveLength(4);
});

it.each(['plugin', 'all', 'host', 'navigation', 'crash'] as const)(
  'revokes a pending open across %s invalidation even if it becomes allowed again',
  async (boundary) => {
    const fixture = setup();
    current = fixture.views;
    const deferred = deferredScreens(fixture);
    const pending = fixture.views.handle('sim', { op: 'open', deviceId: 'remote', id: 'a' });
    await until(() => fixture.invoke.mock.calls.some(([, request]) => request.op === 'screens'));
    if (boundary === 'plugin') fixture.views.invalidate('sim');
    else if (boundary === 'all') fixture.views.endAll();
    else if (boundary === 'host') fixture.views.setHost(fakeHost().host);
    else if (boundary === 'navigation')
      fixture.relay.emitter.emit('did-start-navigation', {}, 'about:blank', false, true);
    else fixture.relay.emitter.emit('render-process-gone');
    deferred.resolve({ screens: deferred.listed });
    expect(await pending).toMatchObject({ ok: false });
    expect(fixture.relay.sent.some((item) => item.channel === LIVE_SCREEN_RELAY.START)).toBe(false);
  },
);

it('revokes an open before its loopback listener is ready', async () => {
  const fixture = setup();
  current = fixture.views;
  const pending = fixture.views.handle('sim', { op: 'open', deviceId: 'remote', id: 'a' });
  fixture.views.endAll();
  expect(await pending).toMatchObject({ ok: false });
  expect(fixture.invoke).not.toHaveBeenCalled();
  expect(fixture.relay.sent).toEqual([]);
});

// The same physical key can belong to a root or stamped organization install.
// Source matching must use host-attested identity at both ends, not the key.
it.each([null, 'acme', 'local'])(
  'authorizes actual %s identity across legacy and new physical keys',
  async (namespace) => {
    const installed = {
      manifest: { id: 'helper' },
      namespace,
      instanceKey: 'helper',
      dir: '/plugins/helper',
    };
    const identity = pluginStoragePart(installedGhostLogicalIdentity(installed));
    const { host, sent } = fakeHost();
    let actualIdentity = identity;
    const views = new PluginLiveScreenViews({
      available: () => true,
      identity: () => actualIdentity,
    });
    views.setHost(host);
    views.connect({
      selfDeviceId: () => 'self',
      invoke: async (_device, request) =>
        request.op === 'capabilities'
          ? { version: 1, enabled: true, liveScreens: true }
          : {
              screens: [
                { ...listed('helper', 'same-old', []), pluginIdentity: identity },
                { ...listed('_ns__acme__helper', 'same-new', []), pluginIdentity: identity },
                {
                  ...listed('helper', 'other-source', []),
                  pluginIdentity: namespace === null ? '_ns__acme__helper' : 'helper',
                },
                { ...listed('helper', 'unknown-source', []), pluginIdentity: undefined },
              ],
            },
    });
    try {
      expect(await views.handle('helper', { op: 'screens', deviceId: 'remote' })).toMatchObject({
        ok: true,
        screens: [{ id: 'same-old' }, { id: 'same-new' }],
      });
      expect(
        await views.handle('helper', { op: 'open', deviceId: 'remote', id: 'other-source' }),
      ).toMatchObject({ ok: false });
      expect(
        await views.handle('helper', { op: 'open', deviceId: 'remote', id: 'unknown-source' }),
      ).toMatchObject({ ok: false });
      const opened = (await views.handle('helper', {
        op: 'open',
        deviceId: 'remote',
        id: 'same-old',
      })) as { ok: boolean; url: string };
      expect(opened).toMatchObject({ ok: true });
      expect(
        await views.handle('helper', { op: 'open', deviceId: 'remote', id: 'same-new' }),
      ).toMatchObject({ ok: true });
      expect(
        sent.filter((m) => m.channel === LIVE_SCREEN_RELAY.START).map((m) => m.payload.screen),
      ).toEqual([
        { plugin: 'helper', id: 'same-old', pluginIdentity: identity },
        { plugin: '_ns__acme__helper', id: 'same-new', pluginIdentity: identity },
      ]);
      actualIdentity = namespace === null ? '_ns__acme__helper' : 'helper';
      expect((await post(opened.url, { events: [{ kind: 'release' }] })).status).toBe(404);
      const relayId = sent.find((m) => m.channel === LIVE_SCREEN_RELAY.START)!.payload
        .relayId as string;
      views.state(host, relayId, { status: 'live' });
      expect((await post(opened.url, { events: [{ kind: 'release' }] })).status).toBe(404);
    } finally {
      views.endAll();
    }
  },
);
