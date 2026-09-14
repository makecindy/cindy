import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { ChildProcess } from 'node:child_process';

import { createLogger } from '../logger.js';
import { ShortcutHoldPhaseController } from '../voice-input/ShortcutHoldPhaseController.js';
import {
  runMacTextInsertionHelperCommand,
  spawnMacTextInsertionHelper,
  triggerGlobalVoiceInputFromHardware,
} from '../voice-input/global.js';
import { joystickScrollSpeed } from '../../shared/workLouderCodexScroll.js';
import type { WorkLouderCodexRendererAction } from '../../shared/workLouderCodex.js';

const execFilePromise = promisify(execFile);
const log = createLogger('worklouder-codex-system-input');

export type SystemFrontmostInputRunner = {
  postKey(key: 'return'): Promise<void>;
  postScroll(deltaY: number): Promise<void>;
};

const DEFAULT_COMMAND_TIMEOUT_MS = 4_000;
const HOLD_SCROLL_TICK_MS = 16;
/** Windows wheel events are counted in 120-unit notches. */
export const WINDOWS_WHEEL_DELTA = 120;

export function accumulateScrollNotches(
  remainder: number,
  deltaY: number,
  notch = WINDOWS_WHEEL_DELTA,
): { remainder: number; deltaY: number } {
  if (notch <= 0) return { remainder: 0, deltaY };
  const total = remainder + deltaY;
  const notches = total < 0 ? Math.ceil(total / notch) : Math.floor(total / notch);
  const emitted = notches * notch;
  return { remainder: total - emitted, deltaY: emitted };
}

export type SystemFrontmostScrollPump = {
  setSpeed(pxPerSecond: number): void;
  stop(): void;
};

function defaultRunner(): SystemFrontmostInputRunner {
  return {
    async postKey(key) {
      if (process.platform === 'darwin') {
        await runMacTextInsertionHelperCommand(['--command', 'post-key', '--key', key]);
        return;
      }
      await postKeyFallback(key);
    },
    async postScroll(deltaY) {
      if (deltaY === 0) return;
      if (process.platform === 'darwin') {
        await runMacTextInsertionHelperCommand([
          '--command',
          'post-scroll',
          '--scroll-delta-y',
          String(deltaY),
        ]);
        return;
      }
      await postScrollFallback(deltaY);
    },
  };
}

async function postKeyFallback(key: 'return'): Promise<void> {
  switch (process.platform) {
    case 'win32':
      await execFilePromise(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          'Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait("{ENTER}")',
        ],
        { timeout: DEFAULT_COMMAND_TIMEOUT_MS, windowsHide: true },
      );
      return;
    case 'linux':
      await execFilePromise('xdotool', ['key', 'Return'], { timeout: DEFAULT_COMMAND_TIMEOUT_MS });
      return;
    default:
      throw new Error(`System frontmost ${key} is not supported on ${process.platform}.`);
  }
}

async function postScrollFallback(deltaY: number): Promise<void> {
  switch (process.platform) {
    case 'win32': {
      const clicks = Math.max(-20, Math.min(20, Math.round(deltaY / 120)));
      if (clicks === 0) return;
      await execFilePromise(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Cursor]::Position = [System.Windows.Forms.Cursor]::Position; $sig = '[DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, int dwData, UIntPtr dwExtraInfo);'; $t = Add-Type -MemberDefinition $sig -Name WlMouse -Namespace Win32 -PassThru; $t::mouse_event(0x0800, 0, 0, ${clicks * 120}, [UIntPtr]::Zero)`,
        ],
        { timeout: DEFAULT_COMMAND_TIMEOUT_MS, windowsHide: true },
      );
      return;
    }
    case 'linux':
      await execFilePromise(
        'xdotool',
        ['click', '--repeat', String(Math.max(1, Math.abs(Math.round(deltaY / 40)))), deltaY > 0 ? '4' : '5'],
        { timeout: DEFAULT_COMMAND_TIMEOUT_MS },
      );
      return;
    default:
      throw new Error(`System frontmost scroll is not supported on ${process.platform}.`);
  }
}

export function createIntervalScrollPump(
  runner: SystemFrontmostInputRunner,
  now: () => number,
  wheelNotch = process.platform === 'win32' ? WINDOWS_WHEEL_DELTA : 0,
): SystemFrontmostScrollPump {
  let speed = 0;
  let lastAt = 0;
  let remainder = 0;
  let inFlight = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  const tick = (): void => {
    if (speed === 0 || inFlight) return;
    const at = now();
    const elapsedMs = lastAt === 0 ? HOLD_SCROLL_TICK_MS : Math.max(1, at - lastAt);
    lastAt = at;
    let deltaY = Math.round((speed * Math.min(elapsedMs, 100)) / 1000);
    if (wheelNotch > 0) {
      const next = accumulateScrollNotches(remainder, deltaY, wheelNotch);
      remainder = next.remainder;
      deltaY = next.deltaY;
    }
    if (deltaY === 0) return;
    inFlight = true;
    void runner
      .postScroll(deltaY)
      .catch((error: unknown) => {
        log.warn('failed to scroll the frontmost app', {
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        inFlight = false;
      });
  };

  return {
    setSpeed(pxPerSecond) {
      speed = pxPerSecond;
      if (pxPerSecond === 0) return;
      if (timer) return;
      lastAt = 0;
      tick();
      timer = setInterval(tick, HOLD_SCROLL_TICK_MS);
      timer.unref?.();
    },
    stop() {
      speed = 0;
      lastAt = 0;
      remainder = 0;
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    },
  };
}

export type HoldScrollChild = Pick<ChildProcess, 'kill' | 'once'> & {
  stdin?: Pick<NonNullable<ChildProcess['stdin']>, 'write' | 'end' | 'destroyed' | 'on'> | null;
};

function ignoreHoldScrollStdinErrors(child: HoldScrollChild): void {
  child.stdin?.on('error', () => undefined);
}

function writeHoldScrollLine(child: HoldScrollChild, line: string): void {
  const stdin = child.stdin;
  if (!stdin || stdin.destroyed) return;
  try {
    stdin.write(line, () => undefined);
  } catch {
    // The helper may already have closed stdin.
  }
}

function discardHoldScrollChild(next: HoldScrollChild): void {
  ignoreHoldScrollStdinErrors(next);
  writeHoldScrollLine(next, 'stop\n');
  try {
    next.stdin?.end();
  } catch {
    // The helper may already have exited after the last wheel event.
  }
  next.kill();
}

export function createMacHoldScrollPump(
  fallback: SystemFrontmostScrollPump,
  spawn: () => Promise<HoldScrollChild> = () =>
    spawnMacTextInsertionHelper(['--command', 'hold-scroll']),
): SystemFrontmostScrollPump {
  let child: HoldScrollChild | null = null;
  let starting = false;
  let spawnGeneration = 0;
  let speed = 0;

  const writeSpeed = (): void => {
    if (!child) return;
    writeHoldScrollLine(child, `${Math.round(speed)}\n`);
  };

  const start = (): void => {
    if (starting || child) return;
    starting = true;
    const generation = ++spawnGeneration;
    void spawn()
      .then((next) => {
        if (generation !== spawnGeneration) {
          discardHoldScrollChild(next);
          return;
        }
        child = next;
        starting = false;
        ignoreHoldScrollStdinErrors(next);
        next.once('exit', () => {
          if (child === next) child = null;
        });
        writeSpeed();
        if (speed !== 0) fallback.stop();
      })
      .catch((error: unknown) => {
        if (generation !== spawnGeneration) return;
        starting = false;
        log.warn('failed to start frontmost scroll helper', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
  };

  return {
    setSpeed(pxPerSecond) {
      speed = pxPerSecond;
      if (child?.stdin && !child.stdin.destroyed) {
        writeSpeed();
        return;
      }
      fallback.setSpeed(pxPerSecond);
      if (pxPerSecond !== 0) start();
    },
    stop() {
      speed = 0;
      spawnGeneration += 1;
      starting = false;
      fallback.stop();
      if (child) {
        discardHoldScrollChild(child);
        child = null;
      }
    },
  };
}

function signedScrollSpeed(direction: 'up' | 'down', intensity: number): number {
  const speed = joystickScrollSpeed(intensity);
  return direction === 'up' ? speed : -speed;
}

export function createWorkLouderCodexSystemFrontmostInput(deps?: {
  runner?: SystemFrontmostInputRunner;
  triggerVoice?: (phase: 'start' | 'tap' | 'end') => void;
  now?: () => number;
  holdDelayMs?: number;
  createScrollPump?: (runner: SystemFrontmostInputRunner) => SystemFrontmostScrollPump;
  spawnHoldScroll?: () => Promise<HoldScrollChild>;
}) {
  const runner = deps?.runner ?? defaultRunner();
  const triggerVoice = deps?.triggerVoice ?? triggerGlobalVoiceInputFromHardware;
  const now = deps?.now ?? Date.now;
  const fallbackPump = createIntervalScrollPump(runner, now);
  const scrollPump =
    deps?.createScrollPump?.(runner) ??
    (process.platform === 'darwin'
      ? createMacHoldScrollPump(fallbackPump, deps?.spawnHoldScroll)
      : fallbackPump);
  let scrolling = false;
  // Outside Cindy the microphone key must feel like the system shortcut: a short
  // tap leaves the overlay recording (a second tap submits), and only a real
  // hold submits on release. Sending `end` on every release made the key look
  // broken unless it was held.
  //
  // No separate suspend/wake reset here: unlike the native shortcut listeners,
  // the keypad owner forces a `release` when the layout stops owning the key or
  // its task slots are suspended (`releaseHeldHardwareGestures`).
  const voicePhases = new ShortcutHoldPhaseController({
    holdDelayMs: deps?.holdDelayMs,
    onTrigger: triggerVoice,
  });

  return {
    handle(action: WorkLouderCodexRendererAction): boolean {
      if (action.type === 'voice') {
        voicePhases.setPressed(action.phase === 'press');
        return true;
      }
      if (action.type === 'command' && action.commandId === 'composer.submit') {
        void runner.postKey('return').catch((error: unknown) => {
          log.warn('failed to send Return to the frontmost app', {
            error: error instanceof Error ? error.message : String(error),
          });
        });
        return true;
      }
      if (action.type === 'scroll') {
        scrolling = true;
        scrollPump.setSpeed(signedScrollSpeed(action.direction, action.intensity));
        return true;
      }
      if (action.type === 'scroll-stop') {
        if (!scrolling) return true;
        scrolling = false;
        scrollPump.stop();
        return true;
      }
      return false;
    },
  };
}
