import { isDesktopInput, type DesktopInput } from '@cindy/device-link';
import type {
  LiveScreenRelayBridge,
  LiveScreenRelayStart,
  LiveScreenRelayState,
} from '../../../shared/liveScreenView';
import type { LiveScreenEmbedBridge } from '../../../shared/remoteDesktopViewer';
import { createLiveScreenEmbedApi } from './liveScreenEmbedApi';
import { DesktopViewerController, type ViewerSnapshot } from './viewerController';

/** A plugin's live screen stream message types. */
const DESCRIPTION = 0x01;
const KEY = 0x02;
const DELTA = 0x03;
/** A keyframe at least this often, so a reader that fell behind recovers. */
const KEYFRAME_INTERVAL_MS = 4_000;
const BITS_PER_PIXEL_SECOND = 2.4;

interface TrackProcessor {
  readable: ReadableStream<VideoFrame>;
}
declare const MediaStreamTrackProcessor:
  (new (init: { track: MediaStreamTrack }) => TrackProcessor) | undefined;

/**
 * Re-encodes the received picture as H.264 access units in the form a plugin's
 * own live screen stream uses (description, keyframe, delta), so the plugin's
 * page decodes a remote device exactly as it decodes a local one. The last
 * picture is kept: a still screen produces no new frames, and a page that
 * starts reading then still needs one.
 */
class FramePump {
  private stopped = false;
  private encoder: VideoEncoder | null = null;
  private size = { width: 0, height: 0 };
  private last: VideoFrame | null = null;
  private wantKey = true;
  /** The newest picture was skipped while the encoder was busy and is still owed. */
  private owed = false;
  private keyAt = 0;
  private stamp = 0;
  private reader: ReadableStreamDefaultReader<VideoFrame> | null = null;
  constructor(
    readonly track: MediaStreamTrack,
    private readonly emit: (kind: number, bytes: Uint8Array) => void,
    private readonly failed: () => void,
  ) {
    if (typeof MediaStreamTrackProcessor === 'undefined' || typeof VideoEncoder === 'undefined') {
      queueMicrotask(failed);
      return;
    }
    this.reader = new MediaStreamTrackProcessor({ track }).readable.getReader();
    void this.run(this.reader);
  }
  private async run(reader: ReadableStreamDefaultReader<VideoFrame>): Promise<void> {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done || this.stopped) {
          value?.close();
          return;
        }
        this.last?.close();
        this.last = value;
        this.encode(value);
      }
    } catch {
      if (!this.stopped) this.failed();
    }
  }
  private encode(frame: VideoFrame): void {
    // H.264 takes even sizes only; the encoder scales the odd pixel away.
    const width = Math.max(2, frame.displayWidth - (frame.displayWidth % 2));
    const height = Math.max(2, frame.displayHeight - (frame.displayHeight % 2));
    if (!this.encoder || width !== this.size.width || height !== this.size.height) {
      this.encoder?.close();
      this.size = { width, height };
      this.wantKey = true;
      const encoder = new VideoEncoder({
        output: (chunk, metadata) => {
          if (this.stopped || this.encoder !== encoder) return;
          const description = metadata?.decoderConfig?.description;
          if (description)
            // Its own copy: the encoder may reuse the buffer it handed out.
            this.emit(
              DESCRIPTION,
              ArrayBuffer.isView(description)
                ? new Uint8Array(
                    description.buffer,
                    description.byteOffset,
                    description.byteLength,
                  ).slice()
                : new Uint8Array(description).slice(),
            );
          const bytes = new Uint8Array(chunk.byteLength);
          chunk.copyTo(bytes);
          this.emit(chunk.type === 'key' ? KEY : DELTA, bytes);
          // A burst may end on a skipped picture and nothing follows a still
          // screen: the last one must always get through.
          if (this.owed && this.last && encoder.encodeQueueSize <= 1) this.encode(this.last);
        },
        error: () => {
          if (!this.stopped && this.encoder === encoder) this.failed();
        },
      });
      encoder.configure({
        codec: 'avc1.640033',
        width,
        height,
        avc: { format: 'avc' },
        latencyMode: 'realtime',
        framerate: 60,
        bitrate: Math.round(
          Math.min(16_000_000, Math.max(2_000_000, width * height * BITS_PER_PIXEL_SECOND)),
        ),
      });
      this.encoder = encoder;
    }
    // A picture that cannot be encoded in time is skipped; the newest one is
    // encoded as soon as the encoder has room.
    if (this.encoder.encodeQueueSize > 2) {
      this.owed = true;
      return;
    }
    this.owed = false;
    const now = performance.now();
    const keyFrame = this.wantKey || now - this.keyAt > KEYFRAME_INTERVAL_MS;
    if (keyFrame) {
      this.wantKey = false;
      this.keyAt = now;
    }
    // Its own rising timestamps: the same picture may be encoded again later.
    this.stamp = Math.max(this.stamp + 1, Math.round(now * 1000));
    const copy = new VideoFrame(frame, { timestamp: this.stamp });
    try {
      this.encoder.encode(copy, { keyFrame });
    } catch {
      if (!this.stopped) this.failed();
    } finally {
      copy.close();
    }
  }
  /** A page started reading or fell behind: it needs a whole picture now. */
  keyframe(): void {
    this.wantKey = true;
    if (!this.stopped && this.last) this.encode(this.last);
  }
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    void this.reader?.cancel().catch(() => {});
    this.last?.close();
    this.last = null;
    if (this.encoder && this.encoder.state !== 'closed') this.encoder.close();
    this.encoder = null;
  }
}

/**
 * One device screen on another computer, received here and handed on to the
 * plugin page that draws it. Nothing is shown in this window: the connection's
 * own picture lives in a holder that is never visible or reachable.
 */
class Relay {
  private readonly holder = document.createElement('div');
  private readonly api: ReturnType<typeof createLiveScreenEmbedApi>;
  private readonly controller: DesktopViewerController;
  private readonly watch: ReturnType<typeof setInterval>;
  private pump: FramePump | null = null;
  private snapshot: ViewerSnapshot | null = null;
  private reported = '';
  private pumpFailures = 0;
  private disposed = false;
  constructor(
    private readonly start: LiveScreenRelayStart,
    private readonly bridge: LiveScreenRelayBridge,
    embed: LiveScreenEmbedBridge,
    private readonly ended: () => void,
  ) {
    this.holder.setAttribute('aria-hidden', 'true');
    this.holder.inert = true;
    Object.assign(this.holder.style, {
      position: 'fixed',
      left: '0',
      top: '0',
      width: '32px',
      height: '32px',
      opacity: '0',
      overflow: 'hidden',
      pointerEvents: 'none',
      zIndex: '-1',
    });
    // The connection's picture surface: the parts it looks up by id, never shown.
    const part = (tag: string, id: string, parent: HTMLElement = this.holder) => {
      const element = document.createElement(tag);
      element.id = id;
      parent.appendChild(element);
      return element;
    };
    const stage = part('div', 'stage');
    part('canvas', 'bg-canvas', part('div', 'bg', stage));
    part('img', 'image', stage);
    const video = part('video', 'video', stage) as HTMLVideoElement;
    video.autoplay = true;
    video.muted = true;
    video.playsInline = true;
    part('img', 'cursor-image', part('div', 'cursor', stage));
    part('textarea', 'keyboard-input').tabIndex = -1;
    const buttons = part('div', 'mouse-buttons');
    buttons.hidden = true;
    part('button', 'mouse-left', buttons);
    part('button', 'mouse-right', buttons);
    part('span', 'mouse-wheel-grip', part('button', 'mouse-wheel', buttons));
    document.body.appendChild(this.holder);
    this.api = createLiveScreenEmbedApi(
      embed,
      { deviceId: start.deviceId, name: '', screen: start.screen },
      () => this.end('DESKTOP_STOPPED'),
    );
    try {
      this.controller = new DesktopViewerController(this.api, this.holder, (snapshot) => {
        this.snapshot = snapshot;
        this.report();
      });
    } catch (error) {
      this.api.dispose();
      this.holder.remove();
      throw error;
    }
    this.watch = setInterval(() => this.follow(), 500);
  }
  /** Keeps the pump on the track now playing; a reconnect brings a new one. */
  private follow(): void {
    if (this.disposed) return;
    const track =
      this.snapshot?.transport === 'video' || this.snapshot?.ready
        ? this.controller.videoTrack()
        : null;
    const live = track && track.readyState === 'live' ? track : null;
    if (this.pump && this.pump.track !== live) {
      this.pump.stop();
      this.pump = null;
    }
    if (live && !this.pump) {
      const pump: FramePump = new FramePump(
        live,
        (kind, bytes) => {
          if (this.pump === pump) this.bridge.frame(this.start.relayId, kind, bytes);
        },
        () => {
          if (this.pump !== pump) return;
          pump.stop();
          this.pump = null;
          // This computer cannot encode the picture: say so instead of looping.
          if (++this.pumpFailures >= 3) this.end('DESKTOP_VIDEO_UNSUPPORTED');
        },
      );
      this.pump = pump;
    }
    this.report();
  }
  private report(): void {
    const snapshot = this.snapshot;
    if (this.disposed || !snapshot) return;
    const live = snapshot.ready && snapshot.controlling && !!this.pump && !snapshot.error;
    const state: LiveScreenRelayState = {
      status: live ? 'live' : snapshot.status === 'reconnecting' ? 'reconnecting' : 'connecting',
      ...(snapshot.error ? { error: snapshot.error } : {}),
      ...(snapshot.screen ? { screen: snapshot.screen } : {}),
      ...(snapshot.screenSize
        ? {
            width: Math.round(snapshot.screenSize.width),
            height: Math.round(snapshot.screenSize.height),
          }
        : {}),
    };
    const key = JSON.stringify(state);
    if (key === this.reported) return;
    this.reported = key;
    this.bridge.state(this.start.relayId, state);
  }
  input(events: unknown[]): void {
    if (this.disposed || !events.every(isDesktopInput)) return;
    this.controller.deviceInput(events as DesktopInput[]);
  }
  keyframe(): void {
    this.pump?.keyframe();
  }
  /** The user's own request from the plugin page: connect again, taking over if busy. */
  retry(): void {
    if (!this.disposed) this.controller.retry();
  }
  private end(error: string): void {
    if (this.disposed) return;
    this.bridge.state(this.start.relayId, { status: 'ended', error });
    this.dispose();
    this.ended();
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    clearInterval(this.watch);
    this.pump?.stop();
    this.pump = null;
    this.controller.dispose();
    this.api.dispose();
    this.holder.remove();
  }
}

/**
 * Makes this app window the one that holds plugin-drawn device screen
 * connections. Main decides which screens (a plugin's own, on the account's
 * other computers) and serves the plugin; this side only receives and re-encodes.
 */
export function installLiveScreenRelay(): () => void {
  const bridge = window.electronAPI?.liveScreenRelay;
  const embed = window.electronAPI?.liveScreenEmbed;
  if (!bridge || !embed) return () => {};
  const relays = new Map<string, Relay>();
  const drop = (relayId: string) => {
    relays.get(relayId)?.dispose();
    relays.delete(relayId);
  };
  const offs = [
    bridge.onStart((start) => {
      drop(start.relayId);
      try {
        relays.set(
          start.relayId,
          new Relay(start, bridge, embed, () => relays.delete(start.relayId)),
        );
      } catch {
        bridge.state(start.relayId, { status: 'ended', error: 'DESKTOP_STOPPED' });
      }
    }),
    bridge.onStop(({ relayId }) => drop(relayId)),
    bridge.onInput(({ relayId, events }) => relays.get(relayId)?.input(events)),
    bridge.onKeyframe(({ relayId }) => relays.get(relayId)?.keyframe()),
    bridge.onRetry(({ relayId }) => relays.get(relayId)?.retry()),
  ];
  void bridge.host().catch(() => {});
  return () => {
    for (const off of offs) off();
    for (const relayId of [...relays.keys()]) {
      bridge.state(relayId, { status: 'ended', error: 'DESKTOP_STOPPED' });
      drop(relayId);
    }
  };
}
