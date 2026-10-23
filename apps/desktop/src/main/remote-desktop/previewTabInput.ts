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
  sendCommand(method: string, params?: object, sessionId?: string): Promise<unknown>;
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
  /**
   * The webview cannot be hit-tested in its host (`pointer-events: none`, which the casting
   * keep-alive layer uses to stay click-through): the browser then never looks for a
   * cross-process frame under a touch (see `FrameRoute`).
   */
  hitBlocked?: boolean;
}
export interface TabInputOptions {
  /**
   * Looks the origin up; asked once per gesture. Absent for a guest whose page is the window.
   * A null, a failure or an implausible answer refuses the gesture: a touch sent without
   * knowing where it lands would hit something else.
   */
  origin?: () => Promise<GuestOrigin | null>;
  /**
   * Whether the host window gives a touch at this point (host CSS px) to this webview, with
   * none of the host app's own overlays, menus or dialogs drawn over it there. Asked before a
   * tap is handed to the host's hit test (`Input.synthesizeTapGesture`); absent, false, or a
   * failure sends the tap to the frame's own session instead, which cannot reach host controls.
   */
  pointFree?: (point: { x: number; y: number }) => Promise<boolean>;
}
/** How much larger the page is drawn than its CSS viewport; 1 unless only the guest is zoomed. */
const MIN_SCALE = 0.1;
const MAX_SCALE = 10;
/** The viewport comes back rounded down to whole px; this close to 1 is exactly 1. */
const SCALE_SNAP = 0.01;
/**
 * The only way a casting tab is presented as a touch device: `(pointer: coarse)`,
 * `(hover: none)`, `(any-pointer: coarse)`, `(any-hover: none)` and `maxTouchPoints` follow, so
 * a page's own `@media` rules can lay itself out for a phone. Verified on Electron 42 /
 * Chromium 148: `setEmulatedMedia` pointer/hover features are accepted but ignored,
 * `setDeviceMetricsOverride` changes the viewport, `setEmitTouchEventsForMouse` turns the
 * desktop mouse into touch, `enableDeviceEmulation` changes neither pointer nor hover. Mouse
 * and wheel through `sendInputEvent` stay mouse events, and the emulation survives reloads and
 * cross-site navigations but lives and dies with the CDP session.
 */
const TOUCH_EMULATION = 'Emulation.setTouchEmulationEnabled';
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

/** One cross-process frame on the way down: its element's box, as seen from the frame above. */
interface FrameHop {
  /** Top-left corner and the two edge vectors of the element's content box (CSS px). */
  origin: [number, number];
  across: [number, number];
  down: [number, number];
  /** The content box's own (untransformed) size, which is the frame's viewport. */
  width: number;
  height: number;
}
/**
 * Where a gesture is delivered when the browser would not get it into a cross-process frame
 * (an iframe of another site, with a process of its own). Measured on Electron 42 / Chromium
 * 148, a touch is placed in the host window's space (see `GuestOrigin`) for the tab's main
 * frame, but the frame under it is looked up as if the same numbers were the tab's own, so with
 * a webview that is not at the host's (0, 0) the touch lands on the parent page, which then
 * answers with a click on the iframe element and the frame never hears of it; with a webview
 * the host cannot hit-test it is never looked up at all. A gesture that starts on such a frame
 * is therefore sent to the frame's own debugger session instead, in the frame's coordinates
 * (found from the page: the element under the finger and its box, transforms included): the
 * frame then gets exact touch and pointer events, multi-touch included. Sessions are attached
 * for one gesture and detached after it.
 *
 * The browser's compat click for a touch sent that way is placed by the tab from the same
 * numbers read as host coordinates, so it lands `origin + frame offset` away from the finger
 * (inside the frame or on the parent page, whatever is there) and never where the finger was.
 * A tap (one finger, no movement beyond `TAP_SLOP`) is therefore not sent as a touch: its
 * start is held until the finger lifts and the tap is delivered whole instead. A webview the
 * host can hit-test, with nothing of the host app drawn over that point (`pointFree`), takes
 * `Input.synthesizeTapGesture` at the host point: the frame gets
 * pointerdown / touchstart / pointerup / touchend / mousemove / mousedown / mouseup / click in
 * a phone's order, once each, at the finger. Measured on Electron 42 / Chromium 148 for flat,
 * turned and nested frames. A webview it cannot hit-test (`hitBlocked`) delivers nothing at
 * all that way, and one with host UI over the point would hand the tap to that UI, so those
 * taps go to the frame's session as a mouse click: a correctly placed
 * click, but with pointer / mouse events only (no touch events). A gesture that moves or gets
 * a second finger sends the held start first and continues as a touch.
 */
interface FrameRoute {
  sessionId: string;
  sessions: string[];
  hops: FrameHop[];
}
/** A touch that started in a routed frame and has not been sent: it may still turn out a tap. */
interface PendingTap {
  point: CssPoint;
}
/** A finger that stays this close (page CSS px) to where it landed is still a tap. */
const TAP_SLOP = 10;
/**
 * A held tap start waits at most this long for the finger to lift. Taps lift in 80-200 ms and
 * the browser shows a press at about 150 ms; a finger still down at 300 ms is a press-and-hold,
 * not a tap, so its start is sent then and the gesture continues as a touch (the frame hears
 * the press while it lasts). Long enough that a slow tap is not split, short enough that a
 * hold is not delayed past the point where pages react to it.
 *
 * A press sent this way that is then lifted without having moved ends in `touchCancel`, not
 * `touchEnd`. Measured on Electron 42: after any stationary hold (100 ms to 1.5 s) a lift
 * makes the browser place a compat click of its own away from the finger (see `FrameRoute`),
 * which can land on another control, and a 11 px nudge before the lift does not prevent it;
 * a cancel does. A phone's long press makes no click either, and engines treat `touchcancel`
 * like `touchend`, so the trade is a cancel event instead of an up for a hold, against a
 * click on the wrong element. A press that moved, a second finger, a same-origin page and a
 * tap that lifted in time are not affected.
 */
const TAP_HOLD_MS = 300;
/** Frames nested this deep are not followed any further. */
const MAX_FRAME_DEPTH = 4;
/** An element box whose edges are this close to parallel has no inverse. */
const DEGENERATE_BOX = 1e-6;

/** The point in the frame an element hosts, from a point in the frame the element sits in. */
function intoFrame(hop: FrameHop, x: number, y: number): [number, number] | null {
  const det = hop.across[0] * hop.down[1] - hop.across[1] * hop.down[0];
  if (!Number.isFinite(det) || Math.abs(det) < DEGENERATE_BOX) return null;
  const dx = x - hop.origin[0];
  const dy = y - hop.origin[1];
  const along = (dx * hop.down[1] - dy * hop.down[0]) / det;
  const below = (hop.across[0] * dy - hop.across[1] * dx) / det;
  return [along * hop.width, below * hop.height];
}
function throughHops(hops: readonly FrameHop[], x: number, y: number): [number, number] | null {
  let point: [number, number] | null = [x, y];
  for (const hop of hops) {
    point = point && intoFrame(hop, point[0], point[1]);
    if (!point) return null;
  }
  return point;
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
  /** Frames of other sites cannot be reached by a plain touch (see `FrameRoute`). */
  private frameRouting = false;
  private route: FrameRoute | null = null;
  private pendingTap: PendingTap | null = null;
  private holdTimer: ReturnType<typeof setTimeout> | null = null;
  /** A press whose start went out because it was held past `TAP_HOLD_MS`; `moved` once it travels. */
  private timedHold: { point: CssPoint; moved: boolean } | null = null;
  /** Page CSS px to host CSS px for the current gesture. */
  private scale = { x: 1, y: 1 };
  private leases: DebuggerLease[] = [];
  private detachListener: ((...args: unknown[]) => void) | null = null;
  private focusEmulated = false;
  /** Wanted: the page presented as a touch device with this many touch points. */
  private touchPoints: number | null = null;
  /** Applied in the CDP session now in use (a replaced session starts without it). */
  private touchEmulated = false;
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

  /**
   * Present the page as a touch device for as long as this injector lives. Nothing is sent
   * here: the emulation goes out before the next command (so before the first measurement),
   * and again after any session replacement. `dispose` takes it back.
   */
  presentAsTouch(maxTouchPoints: number): void {
    this.touchPoints = maxTouchPoints;
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
      await this.releaseTouchPresentation();
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
      if (this.pendingTap) {
        // Nothing was sent for it, so there is nothing to cancel.
        this.dropPending();
        await this.endRoute();
        return;
      }
      try {
        await this.send(
          'Input.dispatchTouchEvent',
          { type: 'touchCancel', touchPoints: [] },
          this.route?.sessionId,
        );
      } finally {
        await this.endRoute();
      }
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
      this.frameRouting =
        origin.hitBlocked === true || Math.abs(origin.x) > 0.5 || Math.abs(origin.y) > 0.5;
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
      points.push({
        id: point.id,
        x: Math.min(1, Math.max(0, u)) * viewport.width,
        y: Math.min(1, Math.max(0, v)) * viewport.height,
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
      if (type === 'touchStart' && this.touches.size === 0 && this.frameRouting && !this.route) {
        this.route = await this.routeTo(points[0]);
        if (epoch !== this.epoch) throw failure();
        if (this.route && points.length === 1) {
          this.pendingTap = { point: points[0] };
          this.touches = new Map([[points[0].id, points[0]]]);
          this.holdTimer = setTimeout(() => this.holdElapsed(), TAP_HOLD_MS);
          return;
        }
      }
      const pending = this.pendingTap;
      if (pending) {
        if (type === 'touchEnd') {
          await this.tap(pending.point);
          this.dropPending();
          this.touches.clear();
          await this.endRoute();
          return;
        }
        const finger = points[0];
        if (
          type === 'touchMove' &&
          points.length === 1 &&
          finger.id === pending.point.id &&
          Math.hypot(finger.x - pending.point.x, finger.y - pending.point.y) <= TAP_SLOP
        )
          return;
        // Not a tap after all: the frame hears of the finger now, where it first landed.
        this.dropPending();
        await this.dispatchTouch('touchStart', [pending.point]);
      }
      const hold = this.timedHold;
      if (hold && type !== 'touchEnd') {
        const finger = points[0];
        if (
          type === 'touchStart' ||
          points.length !== 1 ||
          finger.id !== hold.point.id ||
          Math.hypot(finger.x - hold.point.x, finger.y - hold.point.y) > TAP_SLOP
        )
          hold.moved = true;
      }
      if (type === 'touchEnd' && hold && !hold.moved && this.route) {
        // Lifts as a cancel, so the browser has no stationary lift to place a click for.
        await this.send(
          'Input.dispatchTouchEvent',
          { type: 'touchCancel', touchPoints: [] },
          this.route.sessionId,
        );
      } else {
        await this.dispatchTouch(type, points);
      }
      if (type === 'touchEnd') await this.endRoute();
    } catch (error) {
      // A sequence the page never saw begin cannot be continued; start over.
      this.touches.clear();
      this.ignored.clear();
      this.dropPending();
      await this.endRoute();
      throw error;
    }
    this.touches = new Map(points.map((point) => [point.id, point] as const));
  }

  /** Where a page point is for the current gesture: in the routed frame, else in the host. */
  private wirePoints(points: readonly CssPoint[]): CssPoint[] {
    const route = this.route;
    return points.map((point) => {
      // Into a routed frame the point is in that frame's own CSS px; otherwise in the host's.
      const local = route ? throughHops(route.hops, point.x, point.y) : null;
      if (route && !local) throw failure();
      return local
        ? { id: point.id, x: local[0], y: local[1] }
        : {
            id: point.id,
            x: (this.origin?.x ?? 0) + point.x * this.scale.x,
            y: (this.origin?.y ?? 0) + point.y * this.scale.y,
          };
    });
  }

  private async dispatchTouch(
    type: 'touchStart' | 'touchMove' | 'touchEnd',
    points: readonly CssPoint[],
  ): Promise<void> {
    const wire = this.wirePoints(points);
    await this.send(
      'Input.dispatchTouchEvent',
      {
        type,
        touchPoints: wire.map((point) => ({ ...point, radiusX: 3, radiusY: 3, force: 1 })),
      },
      this.route?.sessionId,
    );
  }

  private dropPending(): void {
    this.pendingTap = null;
    if (this.holdTimer !== null) {
      clearTimeout(this.holdTimer);
      this.holdTimer = null;
    }
  }

  /** The finger is still down after `TAP_HOLD_MS`: it is a hold, so its start goes out now. */
  private holdElapsed(): void {
    this.holdTimer = null;
    const pending = this.pendingTap;
    if (!pending) return;
    const epoch = this.epoch;
    // In line with the batches, so it cannot overtake or interleave with an event being applied.
    this.queue = this.queue
      .then(async () => {
        if (epoch !== this.epoch || this.pendingTap !== pending || this.disposed) return;
        this.pendingTap = null;
        try {
          await this.dispatchTouch('touchStart', [pending.point]);
          this.timedHold = { point: pending.point, moved: false };
        } catch {
          // A start the page never saw cannot be continued; the next event starts over.
          this.epoch++;
          await this.releaseState();
        }
      })
      .catch(() => undefined);
  }

  private async pointIsFree(host: { x: number; y: number }): Promise<boolean> {
    if (!this.options.pointFree) return false;
    try {
      return (await withTimeout(this.options.pointFree(host), PREVIEW_INPUT_TIMEOUT_MS)) === true;
    } catch {
      return false;
    }
  }

  /** A whole tap on the routed frame at this page point (see `FrameRoute`). */
  private async tap(point: CssPoint): Promise<void> {
    // The host's own space, as for any touch sent to the tab (see `GuestOrigin`).
    const host = {
      x: (this.origin?.x ?? 0) + point.x * this.scale.x,
      y: (this.origin?.y ?? 0) + point.y * this.scale.y,
    };
    // The tap gesture goes through the host window's hit test, so it may only be used where the
    // webview itself is on top: a menu or dialog of the host app over it would take the tap.
    if (this.origin?.hitBlocked !== true && (await this.pointIsFree(host))) {
      await this.send('Input.synthesizeTapGesture', {
        x: host.x,
        y: host.y,
        gestureSourceType: 'touch',
      });
      return;
    }
    const [local] = this.wirePoints([point]);
    const sessionId = this.route?.sessionId;
    const at = { x: local.x, y: local.y };
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...at }, sessionId);
    await this.send(
      'Input.dispatchMouseEvent',
      { type: 'mousePressed', ...at, button: 'left', clickCount: 1 },
      sessionId,
    );
    await this.send(
      'Input.dispatchMouseEvent',
      { type: 'mouseReleased', ...at, button: 'left', clickCount: 1 },
      sessionId,
    );
  }
  /**
   * The frame a gesture starting at this page point has to be delivered to, or null when the
   * point is in the tab's own (or a same-process) frame: the element under the point, whether
   * it hosts a frame with its own target, and where its box lies (transforms included),
   * repeated for frames inside that frame. Any failure leaves the gesture on the tab itself,
   * which is what it did before.
   */
  private async routeTo(point: CssPoint): Promise<FrameRoute | null> {
    const sessions: string[] = [];
    const hops: FrameHop[] = [];
    let owner: string | undefined;
    let x = point.x;
    let y = point.y;
    let frames: Set<string> | null = null;
    const hopsFrames = new Set<string>();
    try {
      for (let depth = 0; depth < MAX_FRAME_DEPTH; depth++) {
        const hit = (await this.send(
          'DOM.getNodeForLocation',
          { x: Math.round(x), y: Math.round(y), ignorePointerEventsNone: true },
          owner,
        )) as { backendNodeId?: number };
        if (typeof hit?.backendNodeId !== 'number') break;
        const described = (await this.send(
          'DOM.describeNode',
          { backendNodeId: hit.backendNodeId },
          owner,
        )) as { node?: { frameId?: string } };
        const frameId = described?.node?.frameId;
        if (!frameId) break;
        if (!frames) {
          const targets = (await this.send('Target.getTargets')) as {
            targetInfos?: Array<{ targetId?: string; type?: string }>;
          };
          frames = new Set(
            (targets?.targetInfos ?? []).flatMap((t) =>
              t.type === 'iframe' && typeof t.targetId === 'string' ? [t.targetId] : [],
            ),
          );
        }
        if (!frames.has(frameId) || hopsFrames.has(frameId)) break;
        hopsFrames.add(frameId);
        const model = (
          (await this.send('DOM.getBoxModel', { backendNodeId: hit.backendNodeId }, owner)) as {
            model?: { content?: number[]; width?: number; height?: number };
          }
        )?.model;
        const quad = model?.content;
        if (!quad || quad.length < 8 || !quad.every(Number.isFinite)) break;
        const hop: FrameHop = {
          origin: [quad[0], quad[1]],
          across: [quad[2] - quad[0], quad[3] - quad[1]],
          down: [quad[6] - quad[0], quad[7] - quad[1]],
          width: Number(model?.width),
          height: Number(model?.height),
        };
        const inside = hop.width > 0 && hop.height > 0 ? intoFrame(hop, x, y) : null;
        if (!inside) break;
        const attached = (await this.send('Target.attachToTarget', {
          targetId: frameId,
          flatten: true,
        })) as { sessionId?: string };
        if (typeof attached?.sessionId !== 'string') break;
        sessions.push(attached.sessionId);
        hops.push(hop);
        owner = attached.sessionId;
        [x, y] = inside;
      }
    } catch {
      // A frame that does not answer is as good as none: the tab itself gets the gesture.
    }
    if (!owner) return null;
    return { sessionId: owner, sessions, hops };
  }

  /** The gesture is over: give the frame sessions back. */
  private async endRoute(): Promise<void> {
    const route = this.route;
    this.route = null;
    this.timedHold = null;
    if (!route || this.guest.isDestroyed() || !this.guest.debugger.isAttached()) return;
    for (const sessionId of [...route.sessions].reverse()) {
      try {
        await withTimeout(
          this.guest.debugger.sendCommand('Target.detachFromTarget', { sessionId }),
          RELEASE_TIMEOUT_MS,
        );
      } catch {
        // The frame is gone or the tab does not answer; its session went with it.
      }
    }
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
      // A session we did not just prove starts without either emulation.
      this.focusEmulated = false;
      this.touchEmulated = false;
    }
    return transport;
  }

  /** A replaced session takes its focus emulation with it. */
  private watchDetach(transport: GuestDebugger): void {
    if (!transport.on) return;
    this.detachListener = () => {
      this.focusEmulated = false;
      this.touchEmulated = false;
      // The frame sessions went with the debugger session.
      this.route = null;
      this.timedHold = null;
      this.dropPending();
    };
    transport.on('detach', this.detachListener);
  }

  private async send(method: string, params?: object, sessionId?: string): Promise<unknown> {
    const transport = this.ensureAttached();
    try {
      if (this.touchPoints !== null && !this.touchEmulated && method !== TOUCH_EMULATION) {
        // Before anything else the page is told it is a touch device, so what it lays out and
        // reports afterwards is the phone's layout.
        await withTimeout(
          transport.sendCommand(TOUCH_EMULATION, {
            enabled: true,
            maxTouchPoints: this.touchPoints,
          }),
          PREVIEW_INPUT_TIMEOUT_MS,
        );
        this.touchEmulated = true;
      }
      return await withTimeout(
        sessionId !== undefined
          ? transport.sendCommand(method, params, sessionId)
          : params === undefined
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

  /**
   * Give the page back as a mouse device. Done before any lease is released: when the browser
   * automation still holds the debugger nothing else would undo it, and it would leak into
   * the Agent's own use of the page. A session that has already ended took it with it.
   */
  private async releaseTouchPresentation(): Promise<void> {
    const wanted = this.touchPoints;
    this.touchPoints = null;
    if (wanted === null || this.guest.isDestroyed()) return;
    const transport = this.guest.debugger;
    if (!transport.isAttached()) return;
    try {
      // Also after a timed-out apply: that command may still have gone through.
      await withTimeout(
        transport.sendCommand(TOUCH_EMULATION, { enabled: false }),
        RELEASE_TIMEOUT_MS,
      );
    } catch {
      // Nothing more can be done for a page that does not answer; detaching clears it.
    }
    this.touchEmulated = false;
  }

  private async releaseState(): Promise<void> {
    // A held tap start was never sent, so there is nothing of it to cancel.
    const hadTouches = this.touches.size > 0 && !this.pendingTap;
    this.dropPending();
    const keys = [...this.keys].reverse();
    this.touches.clear();
    this.ignored.clear();
    this.keys = [];
    if (this.guest.isDestroyed()) {
      this.route = null;
      this.timedHold = null;
      return;
    }
    if (hadTouches) {
      try {
        // Without a started touch the page rejects a cancel; the held set makes that impossible.
        const transport = this.ensureAttached();
        const touchCancel = { type: 'touchCancel', touchPoints: [] };
        await withTimeout(
          this.route
            ? transport.sendCommand('Input.dispatchTouchEvent', touchCancel, this.route.sessionId)
            : transport.sendCommand('Input.dispatchTouchEvent', touchCancel),
          RELEASE_TIMEOUT_MS,
        );
      } catch {
        // Nothing more can be done for a tab that does not answer.
      }
    }
    await this.endRoute();
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
