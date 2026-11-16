import http from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { WebContents } from 'electron';
import {
  LIVE_SCREEN_ID,
  isDesktopInput,
  runningLiveScreens,
  type DesktopInput,
  type RemoteDesktopCapabilities,
  type RemoteDesktopLeaseScreen,
  type RemoteLiveScreen,
} from '@cindy/device-link';
import {
  LIVE_SCREEN_RELAY,
  type LiveScreenRelayStart,
  type LiveScreenRelayState,
  type LiveScreenViewMessage,
} from '../../shared/liveScreenView.js';

/** Same message types as a plugin's own live screen stream. */
const MESSAGE = { description: 0x01, key: 0x02, delta: 0x03, json: 0x10 } as const;
const MAX_FRAME_BYTES = 8 * 1024 * 1024;
/** A reader this far behind skips to the next keyframe instead of piling up. */
const MAX_PENDING_BYTES = 12 * 1024 * 1024;
const MAX_INPUT_BYTES = 16_384;
const MAX_INPUT_EVENTS = 64;
/** A view nobody reads is given back, so that computer's device is free again. */
const IDLE_MS = 20_000;
const MAX_VIEWS_PER_PLUGIN = 4;
/** Every read makes that computer ask its plugins; pages polling together share one. */
const SCREENS_CACHE_MS = 3_000;
const DEVICE_ID = /^[A-Za-z0-9._:-]{1,256}$/;
/** What a plugin page may send: touches, the device's own buttons and typing. */
const INPUT_KINDS = new Set(['touch', 'press', 'text', 'key', 'release']);

type Reader = { response: http.ServerResponse; awaitingKey: boolean };
type View = {
  id: string;
  token: string;
  instance: string;
  identity: string;
  /** The plugin's install key on that computer, as that computer lists it. */
  remotePlugin: string | null;
  deviceId: string;
  screenId: string;
  relayId: string;
  host: WebContents;
  readers: Set<Reader>;
  description: Uint8Array | null;
  state: LiveScreenRelayState;
  idle: ReturnType<typeof setTimeout> | null;
};

export interface PluginLiveScreenLink {
  selfDeviceId(): string | null | undefined;
  invoke(deviceId: string, request: { op: 'capabilities' | 'screens' }): Promise<unknown>;
}

const fail = (errorCode: string) => ({ ok: false as const, errorCode });
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

function frame(type: number, payload: Uint8Array): Buffer {
  const out = Buffer.allocUnsafe(5 + payload.length);
  out.writeUInt32BE(1 + payload.length, 0);
  out[4] = type;
  out.set(payload, 5);
  return out;
}
const json = (message: LiveScreenViewMessage) =>
  frame(MESSAGE.json, Buffer.from(JSON.stringify(message)));

function stateMessages(state: LiveScreenRelayState): LiveScreenViewMessage[] {
  const messages: LiveScreenViewMessage[] = [];
  if (state.screen) {
    // The page is told about the device, never which install key that computer uses.
    const { id, name, platform, cornerRadius, maxTouches, keyboard, buttons } = state.screen;
    messages.push({
      type: 'device',
      id,
      name,
      platform,
      cornerRadius,
      maxTouches,
      keyboard,
      buttons,
    });
  }
  if (state.width && state.height)
    messages.push({ type: 'screen', width: state.width, height: state.height });
  messages.push({
    type: 'state',
    state: state.status,
    ...(state.error ? { error: state.error } : {}),
  });
  return messages;
}

/**
 * Lets a plugin that provides live screens (`liveScreen: true`) show and
 * operate its own screens on another of the account's computers, in its own
 * page. The plugin names a computer and one of its own screens there; it gets a
 * one-time loopback address serving the picture in the plugin's own stream
 * format and taking input in the remote desktop's device terms. The connection
 * itself is an ordinary device screen view held by an app window, with the
 * same authority rules (Main binds the target and checks every request); a
 * plugin can never name another plugin's screen or a whole desktop.
 */
export class PluginLiveScreenViews {
  private views = new Map<string, View>();
  private host: WebContents | null = null;
  private server: http.Server | null = null;
  private starting: Promise<number> | null = null;
  private port = 0;
  private lists = new Map<string, { at: number; value: Promise<RemoteLiveScreen[]> }>();
  private link: PluginLiveScreenLink | null = null;
  constructor(
    private readonly deps: {
      available(): boolean;
      /** Whether this enabled plugin instance may view its screens elsewhere. */
      identity(instance: string): string | null;
    },
  ) {}
  /** The way to the account's other computers, set once device link is up. */
  connect(link: PluginLiveScreenLink): void {
    this.link = link;
  }

  /** The app window that receives pictures; it registers itself once mounted. */
  setHost(sender: WebContents): void {
    if (this.host === sender) return;
    if (this.host) this.endHost(this.host);
    this.host = sender;
    const gone = () => this.endHost(sender);
    sender.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
      if (isMainFrame && !isInPlace) gone();
    });
    sender.on('render-process-gone', gone);
    sender.once('destroyed', gone);
  }
  private endHost(sender: WebContents): void {
    for (const view of [...this.views.values()])
      if (view.host === sender) this.end(view, 'VIEW_UNAVAILABLE', false);
    if (this.host === sender) this.host = null;
  }

  async handle(instance: string, payload: unknown): Promise<unknown> {
    const identity = this.deps.identity(instance);
    if (!identity) return fail('PERMISSION_DENIED');
    if (!record(payload)) return fail('INVALID_ARGUMENT');
    if (payload.op === 'close') {
      const view = typeof payload.view === 'string' ? this.views.get(payload.view) : undefined;
      if (view?.instance === instance) this.end(view, 'CLOSED', true);
      return { ok: true };
    }
    const link = this.link;
    if (!link || !this.deps.available()) return fail('DEVICE_LINK_UNAVAILABLE');
    const deviceId = payload.deviceId;
    if (
      typeof deviceId !== 'string' ||
      !DEVICE_ID.test(deviceId) ||
      deviceId === link.selfDeviceId()
    )
      return fail('INVALID_ARGUMENT');
    if (payload.op === 'screens') {
      try {
        const screens = await this.screens(link, deviceId);
        return {
          ok: true,
          screens: !this.matchesIdentity(instance, identity)
            ? []
            : screens
                .filter((screen) => screen.pluginIdentity === identity)
                .map(({ id, name, platform, taskIds }) => ({ id, name, platform, taskIds })),
        };
      } catch (error) {
        return fail(error instanceof Error && error.message ? error.message : 'DEVICE_UNAVAILABLE');
      }
    }
    if (payload.op !== 'open') return fail('INVALID_ARGUMENT');
    const screenId = payload.id;
    if (typeof screenId !== 'string' || !LIVE_SCREEN_ID.test(screenId))
      return fail('INVALID_ARGUMENT');
    let view = [...this.views.values()].find(
      (item) =>
        item.instance === instance && item.deviceId === deviceId && item.screenId === screenId,
    );
    if (!view) {
      const host = this.host;
      if (!host || host.isDestroyed()) return fail('HOST_NOT_READY');
      // Reserve synchronously in the existing table. Revocation and capacity
      // apply to pending opens too; concurrent callers share this same entry.
      if (
        [...this.views.values()].filter((item) => item.instance === instance).length >=
        MAX_VIEWS_PER_PLUGIN
      )
        return fail('TOO_MANY_VIEWS');
      view = {
        id: `lv-${randomUUID()}`,
        token: randomBytes(32).toString('hex'),
        instance,
        identity,
        remotePlugin: null,
        deviceId,
        screenId,
        relayId: `lr-${randomUUID()}`,
        host,
        readers: new Set(),
        description: null,
        state: { status: 'connecting' },
        idle: null,
      };
      this.views.set(view.id, view);
    }
    const current = () =>
      this.views.get(view.id) === view &&
      this.host === view.host &&
      !view.host.isDestroyed() &&
      this.matchesIdentity(instance, view.identity) &&
      this.deps.available();
    if (view.remotePlugin === null) {
      try {
        await this.listen();
        if (!current()) return fail('HOST_NOT_READY');
        const remotePlugin = (await this.screens(link, deviceId)).find(
          (screen) => screen.id === screenId && screen.pluginIdentity === identity,
        )?.plugin;
        if (!current()) return fail('HOST_NOT_READY');
        if (!remotePlugin) {
          this.end(view, 'SCREEN_NOT_FOUND', false);
          return fail('SCREEN_NOT_FOUND');
        }
        // No await from the final identity check to START: one owner commits it.
        if (view.remotePlugin === null) {
          view.remotePlugin = remotePlugin;
          view.host.send(LIVE_SCREEN_RELAY.START, {
            relayId: view.relayId,
            deviceId,
            screen: { plugin: remotePlugin, id: screenId, pluginIdentity: identity },
          } satisfies LiveScreenRelayStart);
          this.idleSoon(view);
        }
      } catch {
        this.end(view, 'VIEW_UNAVAILABLE', false);
        return fail('VIEW_UNAVAILABLE');
      }
    }
    if (!current()) return fail('HOST_NOT_READY');
    return { ok: true, view: view.id, url: `http://127.0.0.1:${this.port}/${view.token}` };
  }

  private screens(link: PluginLiveScreenLink, deviceId: string): Promise<RemoteLiveScreen[]> {
    const cached = this.lists.get(deviceId);
    if (cached && Date.now() - cached.at < SCREENS_CACHE_MS) return cached.value;
    const value = (async () => {
      const caps = (await link.invoke(deviceId, {
        op: 'capabilities',
      })) as RemoteDesktopCapabilities | null;
      if (caps?.version !== 1 || !caps.enabled || caps.liveScreens !== true) return [];
      return runningLiveScreens(await link.invoke(deviceId, { op: 'screens' }));
    })();
    this.lists.set(deviceId, { at: Date.now(), value });
    value.catch(() => {
      if (this.lists.get(deviceId)?.value === value) this.lists.delete(deviceId);
    });
    return value;
  }

  /** The plugin was turned off, removed or replaced: nothing of it keeps a view. */
  invalidate(instance: string): void {
    for (const view of [...this.views.values()])
      if (view.instance === instance) this.end(view, 'CLOSED', true);
  }
  /** Account change, quit, or this computer locking. */
  endAll(): void {
    for (const view of [...this.views.values()]) this.end(view, 'CLOSED', true);
    this.lists.clear();
  }

  private matchesIdentity(instance: string, identity: string): boolean {
    return this.deps.identity(instance) === identity;
  }

  private byRelay(sender: WebContents, relayId: unknown): View | undefined {
    if (typeof relayId !== 'string') return undefined;
    for (const view of this.views.values())
      if (view.relayId === relayId && view.host === sender) {
        if (this.matchesIdentity(view.instance, view.identity)) return view;
        this.end(view, 'PERMISSION_DENIED', true);
        return undefined;
      }
    return undefined;
  }
  /** The relaying window reports what the connection is doing. */
  state(sender: WebContents, relayId: unknown, value: unknown): void {
    const view = this.byRelay(sender, relayId);
    if (!view || !record(value)) return;
    const status = value.status;
    if (
      status !== 'connecting' &&
      status !== 'live' &&
      status !== 'reconnecting' &&
      status !== 'ended'
    )
      return;
    const screen =
      record(value.screen) &&
      value.screen.plugin === view.remotePlugin &&
      value.screen.id === view.screenId &&
      typeof value.screen.name === 'string' &&
      typeof value.screen.platform === 'string' &&
      Array.isArray(value.screen.buttons)
        ? (value.screen as unknown as RemoteDesktopLeaseScreen)
        : null;
    const size = (n: unknown) => (Number.isInteger(n) && (n as number) > 0 ? (n as number) : 0);
    view.state = {
      status,
      ...(typeof value.error === 'string' && value.error.length <= 64
        ? { error: value.error }
        : {}),
      ...(screen ? { screen } : view.state.screen ? { screen: view.state.screen } : {}),
      ...(size(value.width) && size(value.height)
        ? { width: size(value.width), height: size(value.height) }
        : view.state.width
          ? { width: view.state.width, height: view.state.height }
          : {}),
    };
    if (status === 'ended') {
      this.end(view, view.state.error ?? 'DESKTOP_STOPPED', false);
      return;
    }
    for (const message of stateMessages(view.state)) {
      const bytes = json(message);
      for (const reader of view.readers) reader.response.write(bytes);
    }
  }
  /** One encoded picture message from the relaying window. */
  frame(sender: WebContents, relayId: unknown, kind: unknown, bytes: unknown): void {
    const view = this.byRelay(sender, relayId);
    if (
      !view ||
      (kind !== MESSAGE.description && kind !== MESSAGE.key && kind !== MESSAGE.delta) ||
      !(bytes instanceof Uint8Array) ||
      !bytes.length ||
      bytes.length > MAX_FRAME_BYTES
    )
      return;
    if (kind === MESSAGE.description) view.description = new Uint8Array(bytes);
    const message = frame(kind, bytes);
    for (const reader of view.readers) {
      if (kind === MESSAGE.key) reader.awaitingKey = false;
      else if (kind === MESSAGE.delta && reader.awaitingKey) continue;
      if (reader.response.writableLength > MAX_PENDING_BYTES) {
        reader.awaitingKey = true;
        this.keyframe(view);
        if (kind !== MESSAGE.description) continue;
      }
      reader.response.write(message);
    }
  }
  private keyframe(view: View): void {
    if (!view.host.isDestroyed())
      view.host.send(LIVE_SCREEN_RELAY.KEYFRAME, { relayId: view.relayId });
  }
  private idleSoon(view: View): void {
    if (view.idle) clearTimeout(view.idle);
    view.idle = view.readers.size
      ? null
      : setTimeout(() => {
          if (this.views.get(view.id) === view && !view.readers.size)
            this.end(view, 'CLOSED', true);
        }, IDLE_MS);
  }
  private end(view: View, error: string, stopRelay: boolean): void {
    if (this.views.get(view.id) !== view) return;
    this.views.delete(view.id);
    if (view.idle) clearTimeout(view.idle);
    const last = json({ type: 'state', state: 'ended', error });
    for (const reader of view.readers) reader.response.end(last);
    view.readers.clear();
    if (stopRelay && view.remotePlugin !== null && !view.host.isDestroyed())
      view.host.send(LIVE_SCREEN_RELAY.STOP, { relayId: view.relayId });
    if (!this.views.size) this.closeServer();
  }
  private closeServer(): void {
    const server = this.server;
    this.server = null;
    this.port = 0;
    if (!server) return;
    this.starting = null;
    server.close();
    server.closeAllConnections();
  }

  private listen(): Promise<number> {
    if (this.server && this.port) return Promise.resolve(this.port);
    this.starting ??= new Promise<number>((resolve, reject) => {
      const server = http.createServer((request, response) => this.serve(request, response));
      server.requestTimeout = 15_000;
      server.headersTimeout = 10_000;
      server.once('error', (error) => {
        this.starting = null;
        reject(error);
      });
      server.listen(0, '127.0.0.1', () => {
        this.starting = null;
        if (!this.views.size) {
          server.close();
          reject(new Error('VIEW_CLOSED'));
          return;
        }
        this.server = server;
        this.port = (server.address() as AddressInfo).port;
        resolve(this.port);
      });
    });
    return this.starting;
  }
  private serve(request: http.IncomingMessage, response: http.ServerResponse): void {
    const reply = (status: number, body: unknown) => {
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(body));
    };
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    // The address is the capability; a page that holds it may read it from any origin.
    response.setHeader('Access-Control-Allow-Origin', '*');
    if (request.headers.host !== `127.0.0.1:${this.port}`) return reply(403, fail('FORBIDDEN'));
    const match = /^\/([0-9a-f]{64})\/(stream|input|retry)$/.exec(
      (request.url ?? '').split('?', 1)[0],
    );
    const view = match
      ? [...this.views.values()].find((item) => item.token === match[1])
      : undefined;
    if (!match || !view || !this.matchesIdentity(view.instance, view.identity))
      return reply(404, fail('VIEW_CLOSED'));
    if (request.method === 'OPTIONS') {
      response.writeHead(204, {
        'Access-Control-Allow-Methods': 'GET, POST',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      response.end();
      return;
    }
    if (match[2] === 'stream' && request.method === 'GET') {
      response.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      // The response has no end of its own; the request timeout is for input posts.
      request.socket.setTimeout(0);
      const reader: Reader = { response, awaitingKey: true };
      for (const message of stateMessages(view.state)) response.write(json(message));
      if (view.description) response.write(frame(MESSAGE.description, view.description));
      view.readers.add(reader);
      this.idleSoon(view);
      this.keyframe(view);
      response.once('close', () => {
        view.readers.delete(reader);
        if (this.views.get(view.id) === view) this.idleSoon(view);
      });
      return;
    }
    if (request.method !== 'POST') return reply(405, fail('FORBIDDEN'));
    if (match[2] === 'retry') {
      // The user's own request on the plugin page: connect again now, taking
      // the view over when another of their devices holds it.
      request.resume();
      if (view.host.isDestroyed()) return reply(409, fail('VIEW_CLOSED'));
      if (view.state.status !== 'live')
        view.host.send(LIVE_SCREEN_RELAY.RETRY, { relayId: view.relayId });
      return reply(200, { ok: true });
    }
    if (match[2] !== 'input') return reply(405, fail('FORBIDDEN'));
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_INPUT_BYTES) {
        reply(413, fail('INPUT_TOO_LARGE'));
        request.destroy();
      } else chunks.push(chunk);
    });
    request.on('end', () => {
      if (response.writableEnded) return;
      let events: unknown;
      try {
        events = (JSON.parse(Buffer.concat(chunks).toString('utf8')) as { events?: unknown })
          ?.events;
      } catch {
        events = null;
      }
      if (
        !Array.isArray(events) ||
        !events.length ||
        events.length > MAX_INPUT_EVENTS ||
        !events.every(
          (event): event is DesktopInput => isDesktopInput(event) && INPUT_KINDS.has(event.kind),
        )
      )
        return reply(400, fail('INVALID_ARGUMENT'));
      if (this.views.get(view.id) !== view || view.host.isDestroyed())
        return reply(409, fail('VIEW_CLOSED'));
      if (view.state.status !== 'live') return reply(409, fail('VIEW_NOT_READY'));
      view.host.send(LIVE_SCREEN_RELAY.INPUT, { relayId: view.relayId, events });
      reply(200, { ok: true });
    });
  }
}
