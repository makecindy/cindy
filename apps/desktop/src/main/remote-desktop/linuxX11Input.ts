import type { DesktopInput } from '@cindy/device-link';

export interface LinuxInputText {
  windowId: number;
  pid: number;
  text: string;
  signal?: AbortSignal;
  validate(): Promise<void>;
}

export interface LinuxInputDeps {
  current(): Promise<boolean>;
  command(args: string[], signal?: AbortSignal): Promise<string>;
  insertText(request: LinuxInputText): Promise<void>;
  hold?(keys: string[], buttons: number[]): void;
  close?(): Promise<void>;
}

const keyNames: Record<string, string> = {
  Enter: 'Return',
  Escape: 'Escape',
  Backspace: 'BackSpace',
  Tab: 'Tab',
  Space: 'space',
  ShiftLeft: 'Shift_L',
  ShiftRight: 'Shift_R',
  ControlLeft: 'Control_L',
  ControlRight: 'Control_R',
  AltLeft: 'Alt_L',
  AltRight: 'Alt_R',
  MetaLeft: 'Super_L',
  MetaRight: 'Super_R',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  Home: 'Home',
  End: 'End',
  PageUp: 'Prior',
  PageDown: 'Next',
  Delete: 'Delete',
  Insert: 'Insert',
  Backquote: 'grave',
  Minus: 'minus',
  Equal: 'equal',
  BracketLeft: 'bracketleft',
  BracketRight: 'bracketright',
  Backslash: 'backslash',
  Semicolon: 'semicolon',
  Quote: 'apostrophe',
  Comma: 'comma',
  Period: 'period',
  Slash: 'slash',
  CapsLock: 'Caps_Lock',
  NumLock: 'Num_Lock',
  ScrollLock: 'Scroll_Lock',
  PrintScreen: 'Print',
  Pause: 'Pause',
  ContextMenu: 'Menu',
  NumpadEnter: 'KP_Enter',
  NumpadAdd: 'KP_Add',
  NumpadSubtract: 'KP_Subtract',
  NumpadMultiply: 'KP_Multiply',
  NumpadDivide: 'KP_Divide',
  NumpadDecimal: 'KP_Decimal',
};

function keyName(code: string): string {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^Numpad[0-9]$/.test(code)) return `KP_${code.slice(6)}`;
  if (/^F(?:[1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
  const name = Object.hasOwn(keyNames, code) ? keyNames[code] : undefined;
  if (!name) throw new Error('DESKTOP_KEY_UNSUPPORTED');
  return name;
}

function positiveId(value: string): number {
  if (!/^[1-9][0-9]{0,15}$/.test(value.trim())) throw new Error('DESKTOP_INPUT_UNAVAILABLE');
  const identifier = Number(value);
  if (!Number.isSafeInteger(identifier)) throw new Error('DESKTOP_INPUT_UNAVAILABLE');
  return identifier;
}

export class LinuxDesktopInput {
  private readonly abort = new AbortController();
  private pending = Promise.resolve();
  private stopping: Promise<void> | null = null;
  private queuedBytes = 0;
  private keys = new Set<string>();
  private buttons = new Set<number>();
  private scrollX = 0;
  private scrollY = 0;

  constructor(
    private readonly deps: LinuxInputDeps,
    private readonly onFailure: () => void,
  ) {}

  private async validate(): Promise<void> {
    this.abort.signal.throwIfAborted();
    if (!(await this.deps.current())) throw new Error('DESKTOP_DISPLAY_CHANGED');
    this.abort.signal.throwIfAborted();
  }

  input(events: DesktopInput[]): void {
    if (this.abort.signal.aborted) throw new Error('DESKTOP_LEASE_EXPIRED');
    const snapshot = events.map((event) => ({ ...event }));
    const bytes = Buffer.byteLength(JSON.stringify(snapshot));
    if (snapshot.length > 128 || this.queuedBytes + bytes > 32_768) {
      this.onFailure();
      return;
    }
    this.queuedBytes += bytes;
    this.pending = this.pending
      .then(() => this.deliver(snapshot))
      .catch(() => {
        if (!this.abort.signal.aborted) this.onFailure();
      })
      .finally(() => {
        this.queuedBytes -= bytes;
      });
  }

  settled(): Promise<void> {
    return this.pending;
  }

  private releaseArgs(): string[] {
    return [
      ...[...this.keys].reverse().flatMap((key) => ['keyup', key]),
      ...[...this.buttons].map((button) => ['mouseup', String(button)]).flat(),
    ];
  }

  private async release(signal?: AbortSignal): Promise<void> {
    const args = this.releaseArgs();
    if (args.length) await this.deps.command(args, signal);
    this.keys.clear();
    this.buttons.clear();
    this.scrollX = this.scrollY = 0;
    this.deps.hold?.([], []);
  }

  private async deliver(events: DesktopInput[]): Promise<void> {
    await this.validate();
    this.deps.hold?.([...this.keys], [...this.buttons]);
    if (!events.length) {
      await this.deps.command(['getdisplaygeometry'], this.abort.signal);
      return;
    }
    let commands: string[] = [];
    let nextKeys = new Set(this.keys);
    let nextButtons = new Set(this.buttons);
    const flush = async () => {
      if (!commands.length) return;
      await this.validate();
      this.deps.hold?.([...this.keys], [...this.buttons]);
      await this.deps.command(commands, this.abort.signal);
      this.keys = nextKeys;
      this.buttons = nextButtons;
      this.deps.hold?.([...this.keys], [...this.buttons]);
      commands = [];
      nextKeys = new Set(this.keys);
      nextButtons = new Set(this.buttons);
    };
    for (const event of events) {
      if (event.kind === 'text' || event.kind === 'release') {
        await flush();
        await this.validate();
        if (event.kind === 'release') await this.release(this.abort.signal);
        else if (event.text) await this.text(event.text);
        nextKeys = new Set(this.keys);
        nextButtons = new Set(this.buttons);
      } else if (event.kind === 'move' || event.kind === 'button') {
        if (
          !Number.isSafeInteger(event.x) ||
          !Number.isSafeInteger(event.y) ||
          event.x < 0 ||
          event.y < 0 ||
          event.x > 65_535 ||
          event.y > 65_535
        )
          throw new Error('DESKTOP_INPUT_UNAVAILABLE');
        commands.push('mousemove', String(event.x), String(event.y));
        if (event.kind === 'button') {
          const button = [1, 2, 3][event.button];
          if (!button) throw new Error('DESKTOP_INPUT_UNAVAILABLE');
          if (event.down) {
            this.buttons.add(button);
            nextButtons.add(button);
          } else nextButtons.delete(button);
          commands.push(event.down ? 'mousedown' : 'mouseup', String(button));
        }
      } else if (event.kind === 'key') {
        const key = keyName(event.code);
        if (event.down) {
          this.keys.add(key);
          nextKeys.add(key);
        } else nextKeys.delete(key);
        commands.push(event.down ? 'keydown' : 'keyup', key);
      } else if (event.kind === 'scroll') {
        if (
          !Number.isFinite(event.dx) ||
          !Number.isFinite(event.dy) ||
          Math.abs(event.dx) > 10_000 ||
          Math.abs(event.dy) > 10_000
        )
          throw new Error('DESKTOP_INPUT_UNAVAILABLE');
        this.scrollX += event.dx;
        this.scrollY += event.dy;
        for (const axis of ['scrollX', 'scrollY'] as const) {
          const steps = Math.trunc(this[axis] / 40);
          if (steps) {
            const button = axis === 'scrollX' ? (steps < 0 ? 6 : 7) : steps < 0 ? 4 : 5;
            commands.push(
              'click',
              '--repeat',
              String(Math.min(Math.abs(steps), 16)),
              '--delay',
              '0',
              String(button),
            );
            this[axis] -= steps * 40;
          }
        }
      }
    }
    await flush();
    await this.validate();
  }

  private async text(text: string): Promise<void> {
    if (
      text.length > 4096 ||
      Array.from(text).some((character) => {
        const point = character.codePointAt(0)!;
        return (
          (point < 32 && point !== 9 && point !== 10) ||
          point === 127 ||
          (point >= 0xd800 && point <= 0xdfff)
        );
      })
    )
      throw new Error('DESKTOP_TEXT_UNSUPPORTED');
    const windowId = positiveId(await this.deps.command(['getactivewindow'], this.abort.signal));
    const pid = positiveId(
      await this.deps.command(['getwindowpid', String(windowId)], this.abort.signal),
    );
    const validate = async () => {
      await this.validate();
      if (
        positiveId(await this.deps.command(['getactivewindow'], this.abort.signal)) !== windowId ||
        positiveId(
          await this.deps.command(['getwindowpid', String(windowId)], this.abort.signal),
        ) !== pid
      )
        throw new Error('DESKTOP_FOCUS_CHANGED');
      await this.validate();
    };
    await validate();
    await this.deps.insertText({ windowId, pid, text, signal: this.abort.signal, validate });
    await validate();
  }

  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.abort.abort();
    this.stopping = this.pending
      .then(async () => {
        if (await this.deps.current()) await this.release();
      })
      .catch(() => undefined)
      .finally(() => this.deps.close?.());
    return this.stopping;
  }
}
