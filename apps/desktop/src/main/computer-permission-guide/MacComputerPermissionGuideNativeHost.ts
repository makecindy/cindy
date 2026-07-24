import { execFile, spawn, type ChildProcessByStdio } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { app } from 'electron';

import { createLogger } from '../logger.js';
import type { SupportedLocale } from '../../shared/locale.js';

const log = createLogger('computer-permission-guide/native');
const HELPER_RESOURCE = path.join(
  'tools',
  'computer-permission-guide',
  'xdt-macos-computer-permission-guide-helper',
);
const HELPER_SOURCE_RELATIVE = path.join(
  'native',
  'computer-permission-guide',
  'macos-computer-permission-guide-helper.swift',
);
const HELPER_START_TIMEOUT_MS = 3_000;
const HELPER_BUILD_TIMEOUT_MS = 30_000;
let helperBinaryPromise: Promise<string> | null = null;

type NativeProcess = ChildProcessByStdio<Writable, Readable, Readable>;

/** State that affects the native coach without moving permission logic into Swift. */
export interface ComputerPermissionGuideNativeState {
  accessibilityGranted: boolean;
  screenRecordingGranted: boolean;
  draggedAccessibility: boolean;
  draggedScreenRecording: boolean;
  switchTargetX?: number;
  switchTargetY?: number;
  /** CuaDriver's coordinate-space size, used to normalize Retina bounds. */
  switchWindowWidth?: number;
  switchWindowHeight?: number;
}

/** Events emitted by the AppKit panel and its native dragging session. */
export interface MacComputerPermissionGuideNativeHostOptions {
  onCloseRequested: () => void;
  onCompleted: () => void;
  onAttached?: () => void;
  onExited?: () => void;
  onAuthSheetDismissed?: () => void;
  onDragBegan: (permission: 'accessibility' | 'screenRecording') => void;
  onDragEnded: (
    permission: 'accessibility' | 'screenRecording',
    operation: number,
  ) => void;
}

interface NativePayload {
  type?: unknown;
  message?: unknown;
  permission?: unknown;
  operation?: unknown;
  systemX?: unknown;
  systemY?: unknown;
  systemWidth?: unknown;
  systemHeight?: unknown;
  panelX?: unknown;
  panelY?: unknown;
}

/**
 * Owns the one-shot AppKit helper used by the macOS permission flow.
 *
 * Electron retains permission state and cancellation. The helper exclusively
 * owns the non-activating NSPanel and NSDraggingSession, so clicking the coach
 * never makes the Electron application frontmost.
 */
export class MacComputerPermissionGuideNativeHost {
  private child: NativeProcess | null = null;
  private stdoutBuffer = '';
  private ready = false;
  private starting: Promise<boolean> | null = null;
  private pendingState: ComputerPermissionGuideNativeState | null = null;
  private closeTimer: ReturnType<typeof setTimeout> | null = null;
  private dismissed = false;

  constructor(private readonly options: MacComputerPermissionGuideNativeHostOptions) {}

  async show(
    appBundlePath: string,
    state: ComputerPermissionGuideNativeState,
    locale: SupportedLocale = 'en',
  ): Promise<boolean> {
    if (this.dismissed) return false;
    this.pendingState = state;
    if (this.ready && this.child) {
      this.flushState();
      return true;
    }
    if (!this.starting) {
      this.starting = this.start(appBundlePath, locale).finally(() => {
        this.starting = null;
      });
    }
    return this.starting;
  }

  update(state: ComputerPermissionGuideNativeState): void {
    if (this.dismissed) return;
    this.pendingState = state;
    this.flushState();
  }

  dismiss(): void {
    this.dismissed = true;
    this.pendingState = null;
    this.ready = false;
    const child = this.child;
    this.child = null;
    if (!child || child.killed) return;
    try {
      child.stdin.write(`${JSON.stringify({ type: 'dismiss' })}\n`);
    } catch {
      // The helper may have already closed itself.
    }
    this.clearCloseTimer();
    this.closeTimer = setTimeout(() => {
      this.closeTimer = null;
      if (!child.killed) child.kill();
    }, 350);
  }

  private async start(appBundlePath: string, locale: SupportedLocale): Promise<boolean> {
    let binary: string;
    try {
      binary = await resolveMacComputerPermissionGuideHelperBinary();
    } catch (error) {
      log.warn('native permission guide helper could not be prepared', {
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
    if (this.dismissed) return false;

    return new Promise<boolean>((resolve) => {
      let settled = false;
      const child = spawn(binary, [appBundlePath, locale], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      this.child = child;
      this.ready = false;
      this.stdoutBuffer = '';

      const settle = (ok: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(startTimer);
        resolve(ok);
      };
      const startTimer = setTimeout(() => {
        log.warn('native permission guide helper did not become ready in time');
        settle(false);
        if (this.child === child) this.child = null;
        if (!child.killed) child.kill();
      }, HELPER_START_TIMEOUT_MS);

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        this.stdoutBuffer += chunk;
        let newline = this.stdoutBuffer.indexOf('\n');
        while (newline >= 0) {
          const line = this.stdoutBuffer.slice(0, newline).trim();
          this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
          if (line) this.handlePayloadLine(line, child, settle);
          newline = this.stdoutBuffer.indexOf('\n');
        }
      });

      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        const text = chunk.trim();
        if (text) log.debug('native permission guide helper stderr', { text });
      });

      child.stdin.on('error', (error) => {
        log.debug('native permission guide helper stdin closed', { error: error.message });
      });

      child.on('error', (error) => {
        log.warn('native permission guide helper process error', { error: error.message });
        if (this.child === child) {
          this.child = null;
          this.ready = false;
        }
        settle(false);
      });

      child.on('exit', (code, signal) => {
        this.clearCloseTimer();
        if (this.child === child) {
          this.child = null;
          this.ready = false;
        }
        settle(false);
        log.debug('native permission guide helper exited', { code, signal });
        if (!this.dismissed) {
          this.options.onExited?.();
        }
      });
    });
  }

  private handlePayloadLine(
    line: string,
    child: NativeProcess,
    settle: (ok: boolean) => void,
  ): void {
    let payload: NativePayload;
    try {
      payload = JSON.parse(line) as NativePayload;
    } catch {
      log.debug('native permission guide helper emitted invalid JSON');
      return;
    }

    if (payload.type === 'auth-sheet-dismissed' && this.child === child) {
      log.info('System Settings auth sheet dismissed; triggering permission recheck');
      this.options.onAuthSheetDismissed?.();
      return;
    }
    if (payload.type === 'ready' && this.child === child) {
      this.ready = true;
      settle(true);
      this.flushState();
      log.info('native permission guide helper ready');
      return;
    }
    if (payload.type === 'error') {
      log.warn('native permission guide helper error', {
        message: typeof payload.message === 'string' ? payload.message : 'Unknown error',
      });
      if (this.child === child) {
        this.child = null;
        this.ready = false;
      }
      settle(false);
      if (!child.killed) child.kill();
      return;
    }
    if (payload.type === 'attached' && this.child === child) {
      this.options.onAttached?.();
      log.debug('native permission guide attached to System Settings', {
        systemBounds: {
          x: payload.systemX,
          y: payload.systemY,
          width: payload.systemWidth,
          height: payload.systemHeight,
        },
        panelOrigin: { x: payload.panelX, y: payload.panelY },
      });
      return;
    }
    if (payload.type === 'close-requested' && this.child === child) {
      this.options.onCloseRequested();
      return;
    }
    if (payload.type === 'completed' && this.child === child) {
      this.options.onCompleted();
      return;
    }
    if (
      payload.type === 'drag-began'
      && this.child === child
      && isPermission(payload.permission)
    ) {
      this.options.onDragBegan(payload.permission);
      return;
    }
    if (
      payload.type === 'drag-ended'
      && this.child === child
      && isPermission(payload.permission)
    ) {
      this.options.onDragEnded(
        payload.permission,
        typeof payload.operation === 'number' ? payload.operation : 0,
      );
    }
  }

  private flushState(): void {
    if (!this.ready || !this.child || !this.pendingState) return;
    try {
      this.child.stdin.write(`${JSON.stringify({ type: 'update', ...this.pendingState })}\n`);
    } catch (error) {
      log.warn('failed to update native permission guide helper', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private clearCloseTimer(): void {
    if (!this.closeTimer) return;
    clearTimeout(this.closeTimer);
    this.closeTimer = null;
  }
}

function isPermission(value: unknown): value is 'accessibility' | 'screenRecording' {
  return value === 'accessibility' || value === 'screenRecording';
}

function resolveMacComputerPermissionGuideHelperBinary(): Promise<string> {
  if (helperBinaryPromise) return helperBinaryPromise;
  helperBinaryPromise = buildMacComputerPermissionGuideHelperBinary().finally(() => {
    // 编译完成后释放 memo，避免缓存过期路径阻塞后续源码变更后的重试。
    helperBinaryPromise = null;
  });
  return helperBinaryPromise;
}

async function buildMacComputerPermissionGuideHelperBinary(): Promise<string> {
  if (app.isPackaged) return path.join(process.resourcesPath, HELPER_RESOURCE);
  const source = resolveDevHelperSource();
  const binary = path.join(
    app.getPath('userData'),
    'computer-permission-guide',
    'xdt-macos-computer-permission-guide-helper',
  );
  const hashFile = `${binary}.sha256`;
  if (!fs.existsSync(source)) {
    throw new Error(`Computer permission guide helper source missing at ${source}`);
  }
  const sourceHash = createHash('sha256').update(fs.readFileSync(source)).digest('hex');
  if (
    fs.existsSync(binary)
    && fs.existsSync(hashFile)
    && fs.readFileSync(hashFile, 'utf8').trim() === sourceHash
  ) {
    return binary;
  }

  fs.mkdirSync(path.dirname(binary), { recursive: true });
  await execFilePromise('swiftc', [source, '-O', '-o', binary], HELPER_BUILD_TIMEOUT_MS);
  fs.chmodSync(binary, 0o755);
  fs.writeFileSync(hashFile, `${sourceHash}\n`, 'utf8');
  log.info('built dev macOS computer permission guide helper', { path: binary });
  return binary;
}

/**
 * Starts preparing the dev helper without making startup depend on compilation.
 *
 * The packaged helper is already present in resources, so prewarming it is
 * intentionally limited to the dev macOS path.
 */
export function prewarmMacComputerPermissionGuideHelper(): void {
  if (process.platform !== 'darwin' || app.isPackaged) return;
  void resolveMacComputerPermissionGuideHelperBinary().catch((error) => {
    log.warn('failed to prewarm dev macOS computer permission guide helper', {
      error: error instanceof Error ? error.message : String(error),
    });
  });
}

function resolveDevHelperSource(): string {
  const fromAppPath = path.join(app.getAppPath(), HELPER_SOURCE_RELATIVE);
  if (fs.existsSync(fromAppPath)) return fromAppPath;
  return path.join(__dirname, '..', '..', HELPER_SOURCE_RELATIVE);
}

function execFilePromise(command: string, args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, { timeout: timeoutMs }, (error, _stdout, stderr) => {
      if (error) {
        reject(new Error(stderr?.trim() ? `${error.message}: ${stderr.trim()}` : error.message));
        return;
      }
      resolve();
    });
    child.on('error', reject);
  });
}
