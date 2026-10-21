import type { DesktopKeyCode, PreviewInputEvent } from '@cindy/device-link';
import {
  acquireDebuggerLease,
  releaseDebuggerLease,
  type DebuggerLease,
} from '../rsb-browser-bridge/debuggerLease';

/** The slice of Electron's Debugger the injector uses. */
export interface GuestDebugger {
  isAttached(): boolean;
  attach(protocolVersion?: string): void;
  detach(): void;
  sendCommand(method: string, params?: object): Promise<unknown>;
  on?(event: 'detach', listener: (...args: unknown[]) => void): unknown;
  removeListener?(event: 'detach', listener: (...args: unknown[]) => void): unknown;
}
export interface InputGuest {
  isDestroyed(): boolean;
  debugger: GuestDebugger;
  sendInputEvent(event: {
    type: 'keyDown' | 'keyUp' | 'char';
    keyCode: string;
    modifiers?: string[];
  }): void;
  insertText(text: string): Promise<void>;
  setBackgroundThrottling(allowed: boolean): void;
}

/** One injected command that has not answered by now is abandoned; its result is unknown. */
export const PREVIEW_INPUT_TIMEOUT_MS = 2_000;
/** Release after a failure must not hang the lease teardown. */
const RELEASE_TIMEOUT_MS = 1_000;
/** A point this far outside the picture still counts as on it (rounding of the shared size). */
const EDGE_TOLERANCE = 0.01;
/** Aspect ratios this close are the same shape; no bars are assumed. */
const ASPECT_TOLERANCE = 0.005;

/**
 * Where the guest's `<webview>` sits in its host window, for `Input.dispatchTouchEvent`.
 * CDP reads a guest's touch coordinates in the embedding renderer's CSS px, not the page's:
 * a touch at page (x, y) must be sent at `(left, top) + (x, y) * scale`. Measured on a real
 * Desktop: the offset is exactly the webview's `getBoundingClientRect()`, unchanged by the
 * host app's zoom (90%, 100%, 110%) and by the tab sitting in the keep-alive layer.
 */
export interface GuestOrigin {
  /** The `<webview>` element's box in the host renderer's viewport, CSS px. */
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface TabInputOptions {
  /**
   * Looks the origin up; asked once per gesture. Absent for a guest whose page is the window.
   * A null, a failure or an implausible answer refuses the gesture: a touch sent without
   * knowing where it lands would hit something else.
   */
  origin?: () => Promise<GuestOrigin | null>;
}
/** How much larger the page is drawn than its CSS viewport; 1 unless only the guest is zoomed. */
const MIN_SCALE = 0.1;
const MAX_SCALE = 10;
/** The viewport comes back rounded down to whole px; this close to 1 is exactly 1. */
const SCALE_SNAP = 0.01;
const MAX_ORIGIN_COORDINATE = 100_000;

function validOrigin(origin: GuestOrigin | null): origin is GuestOrigin {
  return (
    origin !== null &&
    typeof origin === 'object' &&
    Number.isFinite(origin.x) &&
    Number.isFinite(origin.y) &&
    Math.abs(origin.x) <= MAX_ORIGIN_COORDINATE &&
    Math.abs(origin.y) <= MAX_ORIGIN_COORDINATE &&
    Number.isFinite(origin.width) &&
    Number.isFinite(origin.height) &&
    origin.width > 0 &&
    origin.height > 0 &&
    origin.width <= MAX_ORIGIN_COORDINATE &&
    origin.height <= MAX_ORIGIN_COORDINATE
  );
}

export interface TabViewport {
  /** CSS pixels. */
  width: number;
  height: number;
}

const MODIFIER_KEYS: Partial<Record<DesktopKeyCode, string>> = {
  ShiftLeft: 'shift',
  ControlLeft: 'control',
  AltLeft: 'alt',
  MetaLeft: 'meta',
};
const MODIFIER_KEY_CODE: Record<string, string> = {
  ShiftLeft: 'Shift',
  ControlLeft: 'Control',
  AltLeft: 'Alt',
  MetaLeft: 'Meta',
};
const NAMED_KEYS: Record<string, string> = {
  Enter: 'Enter',
  Escape: 'Escape',
  Tab: 'Tab',
  Space: 'Space',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Insert: 'Insert',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
};
/** Keys that also produce a character when pressed alone. */
const NAMED_CHARS: Record<string, string> = { Space: ' ', Enter: '\r' };
const PUNCTUATION: Record<string, string> = {
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Backquote: '`',
  Comma: ',',
  Period: '.',
  Slash: '/',
};

interface KeyStroke {
  /** Electron accelerator-style key code for `sendInputEvent`. */
  keyCode: string;
  /** The character a plain press types; absent for non-printing keys. */
  char?: string;
  upper?: string;
}
function strokeFor(code: DesktopKeyCode): KeyStroke | null {
  if (code in MODIFIER_KEY_CODE) return { keyCode: MODIFIER_KEY_CODE[code] };
  if (code in NAMED_KEYS) {
    const char = NAMED_CHARS[code];
    return { keyCode: NAMED_KEYS[code], ...(char ? { char } : {}) };
  }
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return { keyCode: letter[1], char: letter[1].toLowerCase(), upper: letter[1] };
  const digit = /^Digit([0-9])$/.exec(code);
  if (digit) return { keyCode: digit[1], char: digit[1] };
  if (/^F([1-9]|1[0-2])$/.test(code)) return { keyCode: code };
  const punctuation = PUNCTUATION[code];
  if (punctuation) return { keyCode: punctuation, char: punctuation };
  return null;
}

/** Failures the phone is told about as they are; anything else is a rejected input. */
const REPORTED_ERRORS = new Set([
  'PREVIEW_SOURCE_ENDED',
  'PREVIEW_CAPTURE_UNAVAILABLE',
  'PREVIEW_INPUT_INVALID',
]);

function failure(message = 'PREVIEW_INPUT_INVALID'): Error {
  return new Error(message);
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('PREVIEW_INPUT_TIMEOUT')), ms);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

interface Placement {
  x0: number;
  y0: number;
  width: number;
  height: number;
}

/**
 * Where the tab's picture sits inside the rectangle the phone laid out for the lease, as
 * fractions of that rectangle. The phone fits the video into its rectangle with `contain`,
 * so a tab whose shape changed since the lease began is pillar- or letterboxed there.
 */
export function pictureInLeaseRect(lease: TabViewport | null, view: TabViewport): Placement {
  const full = { x0: 0, y0: 0, width: 1, height: 1 };
  if (!lease || lease.width <= 0 || lease.height <= 0) return full;
  const leaseAspect = lease.width / lease.height;
  const viewAspect = view.width / view.height;
  if (Math.abs(viewAspect - leaseAspect) / leaseAspect <= ASPECT_TOLERANCE) return full;
  if (viewAspect > leaseAspect) {
    const height = leaseAspect / viewAspect;
    return { x0: 0, y0: (1 - height) / 2, width: 1, height };
  }
  const width = viewAspect / leaseAspect;
  return { x0: (1 - width) / 2, y0: 0, width, height: 1 };
}

interface CssPoint {
  id: number;
  x: number;
  y: number;
}

/**
 * Injects phone input into one preview tab: touch through the guest's debugger
 * (`Input.dispatchTouchEvent`), keys through `sendInputEvent`, committed text through
 * `insertText`. Never reaches the OS input stack. Every pressed touch and key is
 * accounted for so `release` / `dispose` can cancel them idempotently.
 *
 * CDP reads a guest's touch coordinates in the host window's space (see `GuestOrigin`), so
 * the origin is added here. This is positioning only: CDP delivers the event to the guest's
 * widget directly, without hit-testing the host UI (a guest under a `pointer-events: none`
 * keep-alive layer still receives it, and a wrong offset cannot land on the host's own
 * controls). Mapped points are always clamped into the tab's rectangle, so no coordinate
 * leaves `origin .. origin + viewport * scale`.
 *
 * Touch points arrive normalized to the rectangle the phone laid out for the lease
 * (`bindLease`); they are mapped back into the tab's picture and scaled by its CSS viewport.
 *
 * The debugger is shared by lease (see `debuggerLease`): this injector joins the browser
 * automation's ownership instead of racing it, and only the last lease out detaches. An
 * attachment nobody leased (DevTools) is left alone, and a session replaced underneath is
 * re-established on the next command with its focus emulation switched on again.
 */
export class TabInputInjector {
  private touches = new Map<number, CssPoint>();
  /** Fingers that landed outside the picture: they stay ignored until they lift. */
  private ignored = new Set<number>();
  private keys: DesktopKeyCode[] = [];
  private viewport: TabViewport | null = null;
  private leaseSize: TabViewport | null = null;
  private origin: GuestOrigin | null = null;
  /** Page CSS px to host CSS px for the current gesture. */
  private scale = { x: 1, y: 1 };
  private leases: DebuggerLease[] = [];
  private detachListener: ((...args: unknown[]) => void) | null = null;
  private focusEmulated = false;
  private throttlingLifted = false;
  private queue: Promise<unknown> = Promise.resolve();
  /** Bumped when pending work must not run any more (timeout, release, dispose). */
  private epoch = 0;
  private disposed = false;

  constructor(
    private readonly guest: InputGuest,
    private readonly options: TabInputOptions = {},
  ) {}

  /** The size the phone was told for this lease; touch coordinates are relative to it. */
  bindLease(size: TabViewport): void {
    this.leaseSize = { width: size.width, height: size.height };
  }

  /** The tab's current CSS viewport. */
  async measure(): Promise<TabViewport> {
    const metrics = (await this.send('Page.getLayoutMetrics')) as {
      cssVisualViewport?: { clientWidth?: number; clientHeight?: number };
      cssLayoutViewport?: { clientWidth?: number; clientHeight?: number };
    };
    const box = metrics?.cssVisualViewport ?? metrics?.cssLayoutViewport;
    const width = Number(box?.clientWidth);
    const height = Number(box?.clientHeight);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1)
      throw new Error('PREVIEW_CAPTURE_UNAVAILABLE');
    this.viewport = { width, height };
    return this.viewport;
  }

  /** Batches run strictly in order; resolves once the whole batch has been injected. */
  inject(events: readonly PreviewInputEvent[]): Promise<void> {
    const run = this.queue.then(() => this.apply(events));
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Cancel every pressed touch and key. Safe to call at any time, any number of times. */
  async release(): Promise<void> {
    this.epoch++;
    await this.releaseState();
  }

  /** The lease is over: release input, then give back everything borrowed from the guest. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.epoch++;
    try {
      await this.releaseState();
    } finally {
      this.restore();
    }
  }

  get pressed(): { touches: number; keys: number } {
    return { touches: this.touches.size, keys: this.keys.length };
  }

  private async apply(events: readonly PreviewInputEvent[]): Promise<void> {
    if (this.disposed) throw failure('PREVIEW_SOURCE_ENDED');
    const epoch = this.epoch;
    for (const event of events) {
      if (epoch !== this.epoch || this.guest.isDestroyed()) throw failure();
      try {
        await this.dispatch(event, epoch);
      } catch (error) {
        // The outcome of the interrupted command is unknown: drop the rest of the batch and
        // every pressed state, and let a late result of the old command find a new epoch.
        this.epoch++;
        await this.releaseState();
        throw error instanceof Error && REPORTED_ERRORS.has(error.message) ? error : failure();
      }
    }
  }

  private async dispatch(event: PreviewInputEvent, epoch: number): Promise<void> {
    switch (event.kind) {
      case 'release':
        await this.releaseState();
        return;
      case 'touch':
        await this.touch(event, epoch);
        return;
      case 'key':
        await this.key(event.code, event.down);
        return;
      case 'text':
        await this.text(event.text);
        return;
    }
  }

  private async touch(
    event: Extract<PreviewInputEvent, { kind: 'touch' }>,
    epoch: number,
  ): Promise<void> {
    if (event.phase === 'cancel') {
      this.ignored.clear();
      if (this.touches.size === 0) return;
      this.touches.clear();
      await this.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
      return;
    }
    // Geometry may change between gestures (the side panel is resized); within one it holds.
    const gestureStart = this.touches.size === 0 && this.ignored.size === 0;
    if (gestureStart || !this.viewport) await this.measure();
    if (gestureStart && this.options.origin) {
      let origin: GuestOrigin | null = null;
      try {
        origin = await this.options.origin();
      } catch {
        origin = null;
      }
      if (!validOrigin(origin) || !this.viewport) throw failure();
      const snap = (ratio: number) => (Math.abs(ratio - 1) <= SCALE_SNAP ? 1 : ratio);
      const scale = {
        x: snap(origin.width / this.viewport.width),
        y: snap(origin.height / this.viewport.height),
      };
      if (scale.x < MIN_SCALE || scale.x > MAX_SCALE || scale.y < MIN_SCALE || scale.y > MAX_SCALE)
        throw failure();
      this.origin = origin;
      this.scale = scale;
    }
    if (epoch !== this.epoch) throw failure();
    const viewport = this.viewport!;
    const picture = pictureInLeaseRect(this.leaseSize, viewport);
    const present = new Set(event.points.map((point) => point.id));
    for (const id of [...this.ignored]) if (!present.has(id)) this.ignored.delete(id);

    const points: CssPoint[] = [];
    for (const point of event.points) {
      if (this.ignored.has(point.id)) continue;
      const u = (point.x - picture.x0) / picture.width;
      const v = (point.y - picture.y0) / picture.height;
      const inside =
        u >= -EDGE_TOLERANCE &&
        u <= 1 + EDGE_TOLERANCE &&
        v >= -EDGE_TOLERANCE &&
        v <= 1 + EDGE_TOLERANCE;
      // A finger that lands on a black bar never was on the picture; one already down slides
      // along the edge instead of vanishing mid-gesture.
      if (!inside && !this.touches.has(point.id)) {
        this.ignored.add(point.id);
        continue;
      }
      const origin = this.origin;
      points.push({
        id: point.id,
        x: (origin?.x ?? 0) + Math.min(1, Math.max(0, u)) * viewport.width * this.scale.x,
        y: (origin?.y ?? 0) + Math.min(1, Math.max(0, v)) * viewport.height * this.scale.y,
      });
    }
    const unchanged =
      points.length === this.touches.size && points.every((point) => this.touches.has(point.id));
    if (points.length === 0 && this.touches.size === 0) return;
    // CDP releases the touches that are missing from a move; only a full release is an end.
    let type: 'touchStart' | 'touchMove' | 'touchEnd';
    if (event.phase === 'start') {
      if (unchanged) return; // the only new finger was on a bar
      type = 'touchStart';
    } else if (event.phase === 'move') {
      type = 'touchMove';
    } else if (points.length === 0) {
      type = 'touchEnd';
    } else {
      if (unchanged) return; // the finger that lifted was an ignored one
      type = 'touchMove';
    }
    try {
      await this.send('Input.dispatchTouchEvent', {
        type,
        touchPoints: points.map((point) => ({ ...point, radiusX: 3, radiusY: 3, force: 1 })),
      });
    } catch (error) {
      // A sequence the page never saw begin cannot be continued; start over.
      this.touches.clear();
      this.ignored.clear();
      throw error;
    }
    this.touches = new Map(points.map((point) => [point.id, point] as const));
  }

  private async key(code: DesktopKeyCode, down: boolean): Promise<void> {
    const stroke = strokeFor(code);
    if (!stroke) throw failure();
    const held = this.keys.includes(code);
    if (!down && !held) return;
    await this.focus();
    if (down) {
      if (!held) this.keys.push(code);
      const modifiers = this.modifiers();
      this.guest.sendInputEvent({ type: 'keyDown', keyCode: stroke.keyCode, modifiers });
      // A plain press types its character (and repeats while held); shortcuts do not. The
      // page sees the keydown first, and Chromium drops the char of a keydown it handled.
      if (stroke.char && !modifiers.some((m) => m === 'control' || m === 'meta' || m === 'alt'))
        this.guest.sendInputEvent({
          type: 'char',
          keyCode: modifiers.includes('shift') && stroke.upper ? stroke.upper : stroke.char,
          modifiers,
        });
    } else {
      this.keys = this.keys.filter((item) => item !== code);
      this.guest.sendInputEvent({
        type: 'keyUp',
        keyCode: stroke.keyCode,
        modifiers: this.modifiers(),
      });
    }
  }

  private async text(text: string): Promise<void> {
    await this.focus();
    await withTimeout(this.guest.insertText(text), PREVIEW_INPUT_TIMEOUT_MS);
  }

  private modifiers(): string[] {
    return this.keys.flatMap((code) => {
      const modifier = MODIFIER_KEYS[code];
      return modifier ? [modifier] : [];
    });
  }

  /** The guest must believe it has focus, or keys and text land in the host page instead. */
  private async focus(): Promise<void> {
    if (this.focusEmulated && this.guest.debugger.isAttached()) return;
    await this.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    this.focusEmulated = true;
  }

  /** Joins the debugger lease scheme; re-attaches (under a new lease) if the session was lost. */
  private ensureAttached(): GuestDebugger {
    if (this.guest.isDestroyed()) throw failure('PREVIEW_SOURCE_ENDED');
    const transport = this.guest.debugger;
    if (this.leases.length === 0 || !transport.isAttached()) {
      if (this.leases.length === 0) this.watchDetach(transport);
      this.leases.push(acquireDebuggerLease(transport));
      this.focusEmulated = false; // a session we did not just prove starts without it
    }
    return transport;
  }

  /** A replaced session takes its focus emulation with it. */
  private watchDetach(transport: GuestDebugger): void {
    if (!transport.on) return;
    this.detachListener = () => {
      this.focusEmulated = false;
    };
    transport.on('detach', this.detachListener);
  }

  private async send(method: string, params?: object): Promise<unknown> {
    const transport = this.ensureAttached();
    try {
      return await withTimeout(
        params === undefined
          ? transport.sendCommand(method)
          : transport.sendCommand(method, params),
        PREVIEW_INPUT_TIMEOUT_MS,
      );
    } catch (error) {
      if (error instanceof Error && error.message === 'PREVIEW_INPUT_TIMEOUT') {
        // Most likely a throttled hidden tab: stop waiting on it next time.
        this.guest.setBackgroundThrottling(false);
        this.throttlingLifted = true;
      }
      throw error;
    }
  }

  private async releaseState(): Promise<void> {
    const hadTouches = this.touches.size > 0;
    const keys = [...this.keys].reverse();
    this.touches.clear();
    this.ignored.clear();
    this.keys = [];
    if (this.guest.isDestroyed()) return;
    if (hadTouches) {
      try {
        // Without a started touch the page rejects a cancel; the held set makes that impossible.
        const transport = this.ensureAttached();
        await withTimeout(
          transport.sendCommand('Input.dispatchTouchEvent', {
            type: 'touchCancel',
            touchPoints: [],
          }),
          RELEASE_TIMEOUT_MS,
        );
      } catch {
        // Nothing more can be done for a tab that does not answer.
      }
    }
    // Modifiers go last (the reverse press order already puts them there for a normal chord).
    for (const code of keys) {
      const stroke = strokeFor(code);
      if (!stroke) continue;
      try {
        this.guest.sendInputEvent({ type: 'keyUp', keyCode: stroke.keyCode, modifiers: [] });
      } catch {
        // The guest went away; its keys went with it.
      }
    }
  }

  private restore(): void {
    const leases = this.leases;
    this.leases = [];
    if (this.guest.isDestroyed()) return;
    const transport = this.guest.debugger;
    if (this.detachListener) {
      try {
        transport.removeListener?.('detach', this.detachListener);
      } catch {
        // Already gone with the guest.
      }
      this.detachListener = null;
    }
    if (this.focusEmulated && transport.isAttached()) {
      void transport
        .sendCommand('Emulation.setFocusEmulationEnabled', { enabled: false })
        .catch(() => undefined);
    }
    this.focusEmulated = false;
    // Every lease is given back; the debugger goes only with the last one out of everyone.
    for (const lease of leases) {
      if (releaseDebuggerLease(transport, lease) && transport.isAttached()) {
        try {
          transport.detach();
        } catch {
          // Already detached by the page closing.
        }
      }
    }
    if (this.throttlingLifted) {
      this.throttlingLifted = false;
      this.guest.setBackgroundThrottling(true);
    }
  }
}
