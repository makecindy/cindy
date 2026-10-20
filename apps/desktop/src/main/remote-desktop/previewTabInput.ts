import type { DesktopKeyCode, PreviewInputEvent, PreviewTouchPoint } from '@cindy/device-link';

/** The slice of Electron's Debugger the injector uses. */
export interface GuestDebugger {
  isAttached(): boolean;
  attach(protocolVersion?: string): void;
  detach(): void;
  sendCommand(method: string, params?: object): Promise<unknown>;
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
const CDP_VERSION = '1.3';

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
/** Printable keys that also produce a character when pressed alone. */
const PUNCTUATION: Record<string, string> = {
  Space: ' ',
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
    const char = PUNCTUATION[code];
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

/**
 * Injects phone input into one preview tab: touch through the guest's debugger
 * (`Input.dispatchTouchEvent`), keys through `sendInputEvent`, committed text through
 * `insertText`. Never reaches the OS input stack. Every pressed touch and key is
 * accounted for so `release` / `dispose` can cancel them idempotently.
 *
 * The debugger is only detached when this injector attached it; an attachment that was
 * already there (DevTools, the browser automation) is left alone, and an attachment lost
 * to someone else's detach is re-established on the next command.
 */
export class TabInputInjector {
  private touches = new Map<number, PreviewTouchPoint>();
  private keys: DesktopKeyCode[] = [];
  private viewport: TabViewport | null = null;
  private ownsAttachment = false;
  private focusEmulated = false;
  private throttlingLifted = false;
  private queue: Promise<unknown> = Promise.resolve();
  /** Bumped when pending work must not run any more (timeout, release, dispose). */
  private epoch = 0;
  private disposed = false;

  constructor(private readonly guest: InputGuest) {}

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
      if (this.touches.size === 0) return;
      this.touches.clear();
      await this.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
      return;
    }
    // Geometry may change between gestures (the side panel is resized); within one it holds.
    if (this.touches.size === 0 || !this.viewport) await this.measure();
    if (epoch !== this.epoch) throw failure();
    const viewport = this.viewport!;
    const touchPoints = event.points.map((point) => ({
      id: point.id,
      x: point.x * viewport.width,
      y: point.y * viewport.height,
      radiusX: 3,
      radiusY: 3,
      force: 1,
    }));
    // CDP releases the touches that are missing from a move; only a full release is an end.
    const type =
      event.phase === 'start'
        ? 'touchStart'
        : event.phase === 'move'
          ? 'touchMove'
          : touchPoints.length === 0
            ? 'touchEnd'
            : 'touchMove';
    const next = new Map(event.points.map((point) => [point.id, point] as const));
    try {
      await this.send('Input.dispatchTouchEvent', { type, touchPoints });
    } catch (error) {
      // A sequence the page never saw begin cannot be continued; start over.
      this.touches.clear();
      throw error;
    }
    this.touches = next;
  }

  private async key(code: DesktopKeyCode, down: boolean): Promise<void> {
    const stroke = strokeFor(code);
    if (!stroke) throw failure();
    const held = this.keys.includes(code);
    if (!down && !held) return;
    await this.focus();
    const modifiers = this.modifiers();
    if (down) {
      if (!held) this.keys.push(code);
      this.guest.sendInputEvent({
        type: 'keyDown',
        keyCode: stroke.keyCode,
        modifiers: this.modifiers(),
      });
      // A plain press types its character (and repeats while held); shortcuts do not.
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

  private ensureAttached(): GuestDebugger {
    if (this.guest.isDestroyed()) throw failure('PREVIEW_SOURCE_ENDED');
    const transport = this.guest.debugger;
    if (!transport.isAttached()) {
      transport.attach(CDP_VERSION);
      this.ownsAttachment = true;
      this.focusEmulated = false; // a fresh session starts without it
    }
    return transport;
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
    if (this.guest.isDestroyed()) return;
    const transport = this.guest.debugger;
    if (transport.isAttached()) {
      // A session this injector opened takes its emulation with it when it goes.
      if (this.focusEmulated && !this.ownsAttachment) {
        void transport
          .sendCommand('Emulation.setFocusEmulationEnabled', { enabled: false })
          .catch(() => undefined);
      }
      if (this.ownsAttachment) {
        try {
          transport.detach();
        } catch {
          // Already detached by the page closing.
        }
      }
    }
    this.focusEmulated = false;
    this.ownsAttachment = false;
    if (this.throttlingLifted) {
      this.throttlingLifted = false;
      this.guest.setBackgroundThrottling(true);
    }
  }
}
