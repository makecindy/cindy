/**
 * One live screen lease's connection to the plugin that provides the screen.
 *
 * Frames: the plugin serves a one-time loopback stream of
 * `[u32 length][type][payload]` messages (H.264 avcC / key / delta, a still
 * image fallback, or a `screen` JSON describing size and rotation). The
 * capture page pulls them in order and decodes them; it never sees the URL.
 * A backlog the page cannot drain is dropped up to the next keyframe, so the
 * picture recovers instead of falling further behind.
 *
 * Input: viewer events are mapped to the plugin's event shapes and sent one
 * batch at a time, in order; whatever arrives meanwhile is merged into the next
 * batch, and typing the device cannot keep up with is dropped.
 */
import http from 'node:http';
import {
  isLiveScreenOnlyInput,
  type DesktopInput,
  type RemoteDesktopLeaseScreen,
  type RemoteLiveScreen,
} from '@cindy/device-link';
import { createLogger } from '../logger';
import type { LiveScreenEvent, LiveScreenOpened } from '../cindy-brain/liveScreenHost';

const log = createLogger('remote-desktop:live-screen');

export interface LiveScreenSource {
  open(plugin: string, id: string, identity?: string): Promise<LiveScreenOpened>;
  input(plugin: string, id: string, events: LiveScreenEvent[], identity?: string): Promise<void>;
  control(
    plugin: string,
    id: string,
    options: { fps?: number; keyframe?: boolean },
    identity?: string,
  ): Promise<void>;
  close(plugin: string, id: string, identity?: string): Promise<void>;
}

/** The plugin host that lists live screens; injected at registration, never imported here. */
export interface LiveScreenProvider extends LiveScreenSource {
  list(): Promise<RemoteLiveScreen[]>;
}

export const LIVE_SCREEN_MESSAGE = {
  description: 0x01,
  key: 0x02,
  delta: 0x03,
  jpeg: 0x04,
  png: 0x06,
  screen: 0x10,
} as const;
const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;
const MAX_QUEUED_BYTES = 16 * 1024 * 1024;
const KEEPALIVE_MS = 20_000;
/** Events queued behind the batch in flight; touches and buttons beyond this refuse the input. */
const MAX_WAITING_INPUT = 512;
/** Keys and text queued behind the batch in flight; more are dropped rather than typed late. */
const MAX_WAITING_TYPING = 32;
/** The plugin protocol's largest input batch. */
const MAX_BATCH_EVENTS = 64;
const isTyping = (event: LiveScreenEvent) => event.kind === 'key' || event.kind === 'text';
const MODIFIERS: Record<string, string> = {
  ShiftLeft: 'shift',
  ControlLeft: 'control',
  AltLeft: 'option',
  MetaLeft: 'command',
};

/** Splits a byte stream into whole messages; throws on a message no plugin may send. */
export class LiveScreenFramer {
  private buffer: Buffer = Buffer.alloc(0);
  push(chunk: Buffer): Uint8Array[] {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    const messages: Uint8Array[] = [];
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32BE(0);
      if (length < 1 || length > MAX_MESSAGE_BYTES) throw new Error('DESKTOP_SCREEN_FRAME_INVALID');
      if (this.buffer.length < 4 + length) break;
      // Own copy (never Node's shared pool): IPC serializes the whole backing buffer.
      messages.push(new Uint8Array(this.buffer.subarray(4, 4 + length)));
      this.buffer = this.buffer.subarray(4 + length);
    }
    return messages;
  }
}

/** Viewer input for a live screen; desktop pointer kinds have no meaning there. */
export class LiveScreenInputMapper {
  private held = new Set<string>();
  /** Forgets held modifiers, as a release does. */
  reset(): void {
    this.held.clear();
  }
  map(events: DesktopInput[]): LiveScreenEvent[] {
    const mapped: LiveScreenEvent[] = [];
    for (const event of events) {
      if (isLiveScreenOnlyInput(event)) mapped.push(event as LiveScreenEvent);
      else if (event.kind === 'text') mapped.push({ kind: 'text', text: event.text });
      else if (event.kind === 'release') {
        this.held.clear();
        mapped.push({ kind: 'release' });
      } else if (event.kind === 'key') {
        const modifier = MODIFIERS[event.code];
        if (modifier) {
          if (event.down) this.held.add(modifier);
          else this.held.delete(modifier);
        } else if (event.down)
          mapped.push({
            kind: 'key',
            code: event.code,
            ...(this.held.size ? { modifiers: [...this.held] } : {}),
          });
      } else throw new Error('INVALID_REQUEST');
    }
    return mapped;
  }
}

export class LiveScreenSession {
  private opened: LiveScreenOpened | null;
  private reopening: Promise<void> | null = null;
  private request: http.ClientRequest | null = null;
  private queue: Uint8Array[] = [];
  private queuedBytes = 0;
  private waiter: ((messages: Uint8Array[] | null) => void) | null = null;
  private streamEnded = false;
  /** Deltas are useless until the next keyframe after a drop or a decoder reset. */
  private awaitingKey = false;
  private connectGeneration = 0;
  private closed = false;
  /** Upright picture size from the plugin's last `screen` message. */
  private uprightShape: { width: number; height: number } | null = null;
  private readonly shapeListeners = new Set<(shape: { width: number; height: number }) => void>();
  private inputChain = Promise.resolve();
  private waiting: LiveScreenEvent[] = [];
  private waitingTyping = 0;
  private sending = false;
  private touching = false;
  private readonly mapper = new LiveScreenInputMapper();
  private closing: Promise<void> | null = null;
  private readonly keepalive: ReturnType<typeof setInterval>;
  private keepaliveFailures = 0;

  constructor(
    readonly plugin: string,
    readonly id: string,
    readonly screen: RemoteDesktopLeaseScreen,
    readonly size: { width: number; height: number },
    opened: LiveScreenOpened,
    private readonly source: LiveScreenSource,
    private readonly ended: () => void,
  ) {
    this.opened = opened;
    this.keepalive = setInterval(() => {
      void this.source.control(this.plugin, this.id, {}).then(
        () => {
          this.keepaliveFailures = 0;
        },
        () => {
          if (++this.keepaliveFailures >= 3) this.end();
        },
      );
    }, KEEPALIVE_MS);
    this.keepalive.unref?.();
  }

  /** Starts a fresh frame stream for a new offer, replacing any previous one. */
  async connect(): Promise<void> {
    if (this.closed) throw new Error('DESKTOP_SCREEN_ENDED');
    this.disconnect();
    const generation = ++this.connectGeneration;
    // One open at a time: a reopen after the plugin ended the stream is used here.
    await this.reopening;
    if (this.closed || generation !== this.connectGeneration)
      throw new Error('DESKTOP_SCREEN_ENDED');
    let opened: LiveScreenOpened;
    try {
      opened = this.opened ?? (await this.source.open(this.plugin, this.id));
    } catch (error) {
      // The device was shut down or removed: end now rather than after the
      // keepalive gives up, so the viewer can say so.
      if (error instanceof Error && /DESKTOP_SCREEN_NOT_(RUNNING|FOUND)/.test(error.message))
        this.end();
      throw error;
    }
    this.opened = null; // one GET per URL
    if (this.closed || generation !== this.connectGeneration)
      throw new Error('DESKTOP_SCREEN_ENDED');
    this.streamEnded = false;
    await new Promise<void>((resolve, reject) => {
      const framer = new LiveScreenFramer();
      const request = http.get(opened.url, { agent: false, timeout: 10_000 }, (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          reject(new Error('DESKTOP_SCREEN_UNAVAILABLE'));
          return;
        }
        // Frames arrive only when the screen changes; a still screen is silent.
        request.setTimeout(0);
        resolve();
        response.on('data', (chunk: Buffer) => {
          if (generation !== this.connectGeneration) return;
          try {
            for (const message of framer.push(chunk)) this.enqueue(message);
          } catch (error) {
            log.warn('Live screen stream rejected', error);
            request.destroy();
          }
        });
        response.on('close', () => {
          if (generation === this.connectGeneration) this.streamClosed();
        });
      });
      request.on('timeout', () => request.destroy(new Error('DESKTOP_SCREEN_TIMEOUT')));
      request.on('error', (error) => {
        reject(error);
        if (generation === this.connectGeneration) this.streamClosed();
      });
      this.request = request;
    });
  }

  /**
   * The picture's current upright size: the device as it shows now, turned by
   * the plugin's reported rotation. Null until the plugin has described it.
   */
  get shape(): { width: number; height: number } | null {
    return this.uprightShape;
  }

  /** Calls `listener` whenever the upright size changes; returns the unsubscribe. */
  onShape(listener: (shape: { width: number; height: number }) => void): () => void {
    this.shapeListeners.add(listener);
    return () => this.shapeListeners.delete(listener);
  }

  private enqueue(message: Uint8Array): void {
    const type = message[0];
    if (type === LIVE_SCREEN_MESSAGE.screen) {
      const shape = uprightShape(message);
      const previous = this.uprightShape;
      this.uprightShape = shape;
      if (shape && (shape.width !== previous?.width || shape.height !== previous?.height))
        for (const listener of [...this.shapeListeners]) listener(shape);
    }
    if (type === LIVE_SCREEN_MESSAGE.key) this.awaitingKey = false;
    if (type === LIVE_SCREEN_MESSAGE.delta && this.awaitingKey) return;
    if (this.queuedBytes + message.length > MAX_QUEUED_BYTES) {
      // Keep configuration and geometry; drop pictures until the next keyframe.
      this.queue = this.queue.filter(
        (item) =>
          item[0] === LIVE_SCREEN_MESSAGE.description || item[0] === LIVE_SCREEN_MESSAGE.screen,
      );
      this.queuedBytes = this.queue.reduce((sum, item) => sum + item.length, 0);
      this.requestKeyframe();
      if (type === LIVE_SCREEN_MESSAGE.delta) return;
    }
    this.queue.push(message);
    this.queuedBytes += message.length;
    this.flush();
  }

  private flush(): void {
    if (!this.waiter || (!this.queue.length && !this.streamEnded)) return;
    const waiter = this.waiter;
    this.waiter = null;
    const messages = this.queue;
    this.queue = [];
    this.queuedBytes = 0;
    waiter(messages.length || !this.streamEnded ? messages : null);
  }

  private streamClosed(): void {
    this.request = null;
    this.streamEnded = true;
    this.flush();
    this.reopening ??= this.reopen().finally(() => {
      this.reopening = null;
    });
  }

  /**
   * The plugin ended the stream: the device stopped, or the plugin restarted.
   * Open it again now (kept for the viewer's next offer) instead of waiting
   * for the viewer to notice the still picture, so a stopped device ends the
   * session at once.
   */
  private async reopen(): Promise<void> {
    if (this.closed || this.opened) return;
    try {
      const opened = await this.source.open(this.plugin, this.id);
      if (!this.closed) this.opened ??= opened;
    } catch (error) {
      if (error instanceof Error && /DESKTOP_SCREEN_NOT_(RUNNING|FOUND)/.test(error.message))
        this.end();
    }
  }

  private requestKeyframe(): void {
    this.awaitingKey = true;
    void this.source.control(this.plugin, this.id, { keyframe: true }).catch(() => {});
  }

  /**
   * The capture page's next messages, waiting up to `waitMs` for one; `[]`
   * when none arrived, null once the stream ended. `keyframe` means the page
   * lost its decoder state and needs a new keyframe before any delta.
   */
  pull(waitMs: number, keyframe = false): Promise<Uint8Array[] | null> {
    if (keyframe) {
      this.queue = this.queue.filter((item) => item[0] !== LIVE_SCREEN_MESSAGE.delta);
      this.queuedBytes = this.queue.reduce((sum, item) => sum + item.length, 0);
      this.requestKeyframe();
    }
    // Only one capture page pulls; a newer pull supersedes an older one.
    this.waiter?.([]);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.waiter === settle) {
          this.waiter = null;
          resolve([]);
        }
      }, waitMs);
      const settle = (messages: Uint8Array[] | null) => {
        clearTimeout(timer);
        resolve(messages);
      };
      this.waiter = settle;
      this.flush();
    });
  }

  /** Stops the current frame stream; the lease and the plugin's view stay. */
  disconnect(): void {
    this.connectGeneration++;
    this.request?.destroy();
    this.request = null;
    this.queue = [];
    this.queuedBytes = 0;
    this.awaitingKey = false;
    this.streamEnded = true;
    this.flush();
  }

  /** Queues events behind the batch in flight; throws only for malformed or excessive viewer input. */
  input(events: DesktopInput[]): void {
    const mapped = this.mapper.map(events);
    if (!mapped.length || this.closed) return;
    if (this.waiting.length + mapped.filter((e) => !isTyping(e)).length > MAX_WAITING_INPUT)
      throw new Error('DESKTOP_INPUT_BUSY');
    let dropped = 0;
    for (const event of mapped) {
      if (event.kind === 'touch')
        this.touching = event.touches.some((t) => t.phase !== 'ended' && t.phase !== 'cancelled');
      else if (event.kind === 'release') this.touching = false;
      // Typing faster than the device takes keys (or a held key repeating) drops the excess
      // instead of typing on long after the viewer stopped.
      if (isTyping(event)) {
        if (this.waitingTyping >= MAX_WAITING_TYPING) {
          dropped++;
          continue;
        }
        this.waitingTyping++;
      }
      // Only the latest position of a moving finger matters: a phone samples
      // touches at up to 120 Hz, faster than a device takes them, and queued
      // moves would replay seconds after the finger stopped.
      const last = this.waiting.at(-1);
      if (last && isTouchMove(event) && isTouchMove(last) && sameFingers(last, event)) {
        this.waiting[this.waiting.length - 1] = event;
        continue;
      }
      this.waiting.push(event);
    }
    if (dropped) log.debug('Live screen typing ahead of the device; dropped', dropped);
    if (this.sending) return;
    this.sending = true;
    this.inputChain = this.drain();
  }

  /** Everything that arrived while a batch was with the plugin goes together in the next one. */
  private async drain(): Promise<void> {
    // Accepted before close (including the final release): still delivered.
    while (this.waiting.length) {
      const batch = this.waiting.splice(0, MAX_BATCH_EVENTS);
      this.waitingTyping -= batch.filter(isTyping).length;
      try {
        await this.source.input(this.plugin, this.id, batch);
      } catch (error) {
        log.debug('Live screen input failed', error);
      }
    }
    this.sending = false;
  }

  /** Lifts held contacts when control ends, so nothing stays pressed on the device. */
  release(): void {
    // Whatever was held when control ended is not held when it resumes.
    this.mapper.reset();
    if (this.touching) this.input([{ kind: 'release' }]);
  }

  private end(): void {
    if (this.closed) return;
    void this.close();
    this.ended();
  }

  /**
   * Ends the session. The plugin closes a screen by device id alone, so the
   * returned promise (input in flight delivered, then the plugin's close)
   * must settle before the same device is opened again: a late close would
   * end the new screen.
   */
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.release();
    this.closed = true;
    clearInterval(this.keepalive);
    this.disconnect();
    const close = () => this.source.close(this.plugin, this.id).catch(() => {});
    this.closing = this.inputChain.then(close, close);
    return this.closing;
  }
}

/**
 * Every live screen session that is closing, whichever path ended it. The
 * plugin closes a screen by device id, so no device may be opened again until
 * all of them are done: a late close would end the new screen.
 */
export class LiveScreenRetirement {
  private pending: Promise<unknown> = Promise.resolve();
  retire(session: LiveScreenSession | null): void {
    if (session) this.pending = Promise.all([this.pending, session.close()]);
  }
  /** Settles once every retired session has delivered its input and closed. */
  async settled(): Promise<void> {
    await this.pending;
  }
}

/** `{"type":"screen","width","height","rotation"}` as the upright size it shows. */
function uprightShape(message: Uint8Array): { width: number; height: number } | null {
  let value: { type?: unknown; width?: unknown; height?: unknown; rotation?: unknown };
  try {
    value = JSON.parse(Buffer.from(message.subarray(1)).toString('utf8'));
  } catch {
    return null;
  }
  const { width, height, rotation } = value;
  if (
    value?.type !== 'screen' ||
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    (width as number) <= 0 ||
    (height as number) <= 0
  )
    return null;
  const turned = Number.isInteger(rotation) && (rotation as number) % 2 === 1;
  return turned
    ? { width: height as number, height: width as number }
    : { width: width as number, height: height as number };
}

/** A touch event in which every finger only moves (or holds still). */
function isTouchMove(event: LiveScreenEvent): event is Extract<LiveScreenEvent, { kind: 'touch' }> {
  return (
    event.kind === 'touch' &&
    !event.edge &&
    event.touches.every((t) => t.phase === 'moved' || t.phase === 'stationary')
  );
}

function sameFingers(
  a: Extract<LiveScreenEvent, { kind: 'touch' }>,
  b: Extract<LiveScreenEvent, { kind: 'touch' }>,
): boolean {
  return (
    a.touches.length === b.touches.length &&
    a.touches.every((t) => b.touches.some((u) => u.id === t.id))
  );
}
