import { execFile, spawn } from 'node:child_process';
import { nativeImage } from 'electron';
import { promisify } from 'node:util';
import {
  readDesktopInputPermission,
  resolveDesktopInputBinary,
} from '../remote-desktop/inputHost.js';
import type {
  FoundQr,
  NativeActRequest,
  NativeActResult,
  NativeAxSnapshot,
  NativeWindowList,
  NativeWindowRef,
  PointerRequest,
  WindowCapture,
  WindowCaptureError,
} from './types.js';
import { captureWindowArea, captureWindowQr, cutQrFromImage, type DetectedQr } from './windowCapture.js';

const exec = promisify(execFile);

/** Operating-system surface used by a handoff session; faked in tests. */
export interface HandoffDriver {
  permission(): Promise<'granted' | 'missing' | 'unknown'>;
  requestPermission(): Promise<void>;
  /** Apps with a window on screen; `background` also lists apps whose only windows are minimized (slower). */
  windows(options?: { background?: boolean }): Promise<NativeWindowList>;
  snapshot(pid: number, window?: NativeWindowRef): Promise<NativeAxSnapshot | { error: string }>;
  act(request: NativeActRequest): Promise<NativeActResult>;
  /** Command line of a process, for agent-controlled target detection only. */
  commandLine(pid: number): Promise<string>;
  /** Screenshot steps. Absent where the platform cannot photograph a single window. */
  capture?(target: { pid: number; window: NativeWindowRef }): Promise<WindowCapture | { error: WindowCaptureError }>;
  focusedField?(pid: number): Promise<{ editable: boolean; secure: boolean }>;
  pointer?(request: PointerRequest): Promise<NativeActResult>;
  /**
   * Scan-to-sign-in: the QR code in the window, cut out of it, or null when it
   * shows none. With `frame` the window is photographed where it is, without
   * bringing it forward (watching a code already shown); otherwise it is raised first.
   */
  qr?(target: { pid: number; window: NativeWindowRef }, frame: number[] | null): Promise<FoundQr | null | { error: WindowCaptureError }>;
  /** Bring the window to the front; its frame and window-server id, for a live view of just that window. */
  raise?(target: { pid: number; window: NativeWindowRef }): Promise<{ frame: number[]; windowId: number } | { error: WindowCaptureError }>;
}

/**
 * Runs the authenticated native helper once per request. Requests travel on
 * stdin so owner values never appear in argv, environment or logs; replies
 * never contain them.
 */
async function runHelper(request: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
  const binary = await resolveDesktopInputBinary();
  return new Promise((resolve, reject) => {
    // All three descriptors must be pipes: the helper authenticates its caller on each of them.
    const child = spawn(binary, ['--handoff'], { stdio: 'pipe' });
    child.stderr.resume();
    let output = '';
    let settled = false;
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      if (!settled) {
        settled = true;
        reject(new Error('INPUT_HANDOFF_HELPER_TIMEOUT'));
      }
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      output += chunk;
      if (output.length > 8_000_000) child.kill('SIGKILL');
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      child.stdin.destroy();
      if (settled) return;
      settled = true;
      const line = output.trim();
      if (line === 'permission') return resolve({ error: 'permission' });
      if (code === 77) return resolve({ error: 'unavailable' });
      try {
        resolve(JSON.parse(line));
      } catch {
        resolve({ error: code === 0 ? 'invalid' : 'unavailable' });
      }
    });
    // Stdin stays open until the helper exits: it checks who launched it on each descriptor,
    // and a closed one fails that check. The request ends at its newline.
    child.stdin.on('error', () => undefined);
    child.stdin.write(`${JSON.stringify(request)}\n`);
  });
}

/**
 * QR codes in one photographed window; null when the helper could not look (not "no code").
 * The picture travels on a pipe only; the reply carries no pixels.
 */
export async function detectHandoffQr(jpeg: Buffer): Promise<DetectedQr[] | null> {
  const binary = await resolveDesktopInputBinary();
  const reply = await new Promise<string>((resolve, reject) => {
    const child = spawn(binary, ['--handoff-qr'], { stdio: 'pipe' });
    child.stderr.resume();
    let output = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 8000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      output += chunk;
      if (output.length > 64_000) child.kill('SIGKILL');
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', () => {
      clearTimeout(timer);
      child.stdin.destroy();
      resolve(output.trim());
    });
    // Its length first, then the picture; stdin stays open (see runHelper).
    child.stdin.on('error', () => undefined);
    child.stdin.write(`${jpeg.length}\n`);
    child.stdin.write(jpeg);
  });
  let parsed: { codes?: unknown };
  try {
    parsed = JSON.parse(reply) as { codes?: unknown };
  } catch {
    return null;
  }
  if (!Array.isArray(parsed.codes)) return null;
  const codes: DetectedQr[] = [];
  for (const code of parsed.codes) {
    const entry = code as Partial<DetectedQr>;
    // Vision may place a code touching the edge slightly outside the picture.
    if (typeof entry?.text !== 'string' || !Array.isArray(entry.box) || entry.box.length !== 4 ||
      !entry.box.every((n) => typeof n === 'number' && Number.isFinite(n) && n >= -0.05 && n <= 1.05)) continue;
    codes.push({ text: entry.text, box: entry.box.map((n) => Math.min(1, Math.max(0, n))) });
  }
  return codes;
}

/**
 * The sign-in QR code in a picture the agent supplied (代输入 from a
 * screenshot): cut out like a window's code; null when the picture has none.
 */
export async function readPictureQr(
  bytes: Buffer,
): Promise<{ text: string; jpeg: Buffer; width: number; height: number } | null | { error: 'not_image' | 'unreadable' }> {
  const image = nativeImage.createFromBuffer(bytes);
  if (image.isEmpty()) return { error: 'not_image' };
  const found = await cutQrFromImage(image, detectHandoffQr);
  if (!found) return null;
  if ('error' in found) return { error: 'unreadable' };
  return { text: found.text, jpeg: found.jpeg, width: found.width, height: found.height };
}

/**
 * Whether typing into this app would land in a password field: the element at
 * a screen point, or the focused element. Used to point the agent at 代输入
 * instead of typing a secret. Unknown (no permission, helper failure) is false.
 */
export async function isSecureInputTarget(target: { pid: number; point?: { x: number; y: number } }): Promise<boolean> {
  if (process.platform !== 'darwin' || !Number.isSafeInteger(target.pid) || target.pid <= 0) return false;
  const point = target.point && Number.isFinite(target.point.x) && Number.isFinite(target.point.y)
    ? [target.point.x, target.point.y] : undefined;
  try {
    const result = (await runHelper({ op: 'secure', pid: target.pid, ...(point ? { point } : {}) }, 3000)) as { secure?: unknown };
    return result?.secure === true;
  } catch {
    return false;
  }
}

function captureError(error: unknown): WindowCaptureError {
  return error === 'target_gone' || error === 'permission' || error === 'locked' ? error : 'unavailable';
}

/** The window-server id of the window at this frame, left where it is (watching a code already shown). */
async function windowIdAt(pid: number, frame: number[]): Promise<number | { error: WindowCaptureError }> {
  const found = (await runHelper({ op: 'windowid', pid, frame }, 3000)) as { windowId?: unknown; error?: string };
  const id = found.windowId;
  return typeof id === 'number' && Number.isSafeInteger(id) && id > 0 && id <= 0xffff_ffff ? id : { error: captureError(found.error) };
}

async function raiseWindow(target: { pid: number; window: NativeWindowRef }): Promise<
  { frame: number[]; windowId?: number } | { error: WindowCaptureError }
> {
  const raised = (await runHelper({ op: 'raise', pid: target.pid, window: target.window }, 6000)) as {
    frame?: unknown;
    windowId?: unknown;
    error?: string;
  };
  const frame = raised.frame;
  if (!Array.isArray(frame) || frame.length !== 4 || !frame.every((n) => typeof n === 'number' && Number.isFinite(n)))
    return { error: captureError(raised.error) };
  const windowId = raised.windowId;
  return {
    frame: frame as number[],
    ...(typeof windowId === 'number' && Number.isSafeInteger(windowId) && windowId > 0 && windowId <= 0xffff_ffff ? { windowId } : {}),
  };
}

export function createMacHandoffDriver(): HandoffDriver {
  return {
    async permission() {
      const status = await readDesktopInputPermission();
      return status === 'granted' ? 'granted' : status === 'missing' ? 'missing' : 'unknown';
    },
    async requestPermission() {
      const binary = await resolveDesktopInputBinary();
      await exec(binary, ['--request-permission'], { timeout: 5000, maxBuffer: 1024 }).catch(() => undefined);
    },
    async windows(options) {
      const result = (await runHelper({ op: 'windows', ...(options?.background ? { background: true } : {}) }, 8000)) as NativeWindowList & { error?: string };
      if (result.error || !Array.isArray(result.apps)) throw new Error(result.error ?? 'unavailable');
      return result;
    },
    async snapshot(pid, window) {
      const result = (await runHelper({ op: 'snapshot', pid, ...(window ? { window } : {}) }, 10_000)) as
        | NativeAxSnapshot
        | { error: string };
      return result;
    },
    async act(request) {
      return (await runHelper({ op: 'act', ...request }, 15_000)) as NativeActResult;
    },
    async capture(target) {
      const raised = await raiseWindow(target);
      if ('error' in raised) return raised;
      // Only the window's own pixels: without its id there is no picture.
      return raised.windowId ? captureWindowArea(raised.frame, raised.windowId) : { error: 'unavailable' };
    },
    async qr(target, frame) {
      if (frame) {
        const id = await windowIdAt(target.pid, frame);
        return typeof id === 'number' ? captureWindowQr(frame, id, detectHandoffQr) : id;
      }
      const raised = await raiseWindow(target);
      if ('error' in raised) return raised;
      return raised.windowId ? captureWindowQr(raised.frame, raised.windowId, detectHandoffQr) : { error: 'unavailable' };
    },
    async raise(target) {
      const raised = await raiseWindow(target);
      if ('error' in raised) return raised;
      return raised.windowId ? { frame: raised.frame, windowId: raised.windowId } : { error: 'unavailable' };
    },
    async focusedField(pid) {
      const result = (await runHelper({ op: 'focused', pid }, 3000)) as { editable?: unknown; secure?: unknown };
      return { editable: result.editable === true, secure: result.secure === true };
    },
    async pointer(request) {
      return (await runHelper({ op: 'pointer', ...request }, 10_000)) as NativeActResult;
    },
    async commandLine(pid) {
      try {
        const { stdout } = await exec('/bin/ps', ['-o', 'args=', '-p', String(pid)], {
          timeout: 3000,
          maxBuffer: 64 * 1024,
        });
        return stdout.trim();
      } catch {
        return '';
      }
    },
  };
}
