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
    allowed: (instance) => allow.has(instance),
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
        screen: { plugin: '_root__sim', id: 'a' },
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
