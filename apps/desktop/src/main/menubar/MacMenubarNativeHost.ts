/**
 * Runs the macOS menu bar helper (SwiftUI status item + panel) and talks to it over
 * newline-delimited JSON on stdin/stdout.
 *
 * Same lifecycle as the Agent Island helper: a `ready` handshake, a bounded number of
 * restarts with backoff, and `suspend()` for when the user turns the menu bar item off.
 */

import { app } from 'electron';
import { execFile, spawn, type ChildProcessByStdio } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Readable, Writable } from 'node:stream';

import {
  MENUBAR_STATUS_TEXT_MODES,
  MENUBAR_USAGE_SCOPES,
  type MenubarHelperMessage,
  type MenubarSettingsPatch,
  type MenubarView,
} from '../../shared/menubarQuota.js';
import { createLogger } from '../logger.js';

const log = createLogger('menubar:native');

const HELPER_NAME = 'xdt-macos-menubar-helper';
const HELPER_RESOURCE = path.join('tools', 'menubar', HELPER_NAME);
const HELPER_SOURCE_RELATIVE = path.join('native', 'menubar', 'macos-menubar-helper.swift');
const HELPER_ASSETS = [
  'wordmark-light.png',
  'wordmark-dark.png',
  'BarlowCondensed-Light.ttf',
  'BarlowCondensed-Medium.ttf',
  'BarlowCondensed-SemiBold.ttf',
] as const;
const HELPER_DEPLOYMENT_TARGET = 'macos14.0';
const HELPER_START_TIMEOUT_MS = 2_500;
const HELPER_RESTART_MAX_ATTEMPTS = 3;
const HELPER_RESTART_BASE_DELAY_MS = 1_000;
const HELPER_RESTART_MAX_DELAY_MS = 5_000;
const HELPER_RESTART_HEALTHY_RESET_MS = 30_000;
const DEV_BUILD_TIMEOUT_MS = 180_000;

type NativeProcess = ChildProcessByStdio<Writable, Readable, Readable>;

export interface MacMenubarNativeHostOptions {
  onMessage: (message: MenubarHelperMessage) => void;
}

export class MacMenubarNativeHost {
  private child: NativeProcess | null = null;
  private starting: Promise<boolean> | null = null;
  private ready = false;
  private stdoutBuffer = '';
  private pendingView: MenubarView | null = null;
  private pendingOpen = false;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private restartHealthyTimer: ReturnType<typeof setTimeout> | null = null;
  private restartAttempts = 0;
  private permanentlyFailed = false;
  /** Set by stop(): the app is quitting and the helper must never come back. */
  private stopped = false;
  private lifecycleToken = 0;
  private helperBinaryPath: string | null = null;
  private helperBinaryPromise: Promise<string> | null = null;

  constructor(private readonly options: MacMenubarNativeHostOptions) {}

  get failed(): boolean {
    return this.permanentlyFailed;
  }

  get running(): boolean {
    return this.ready && this.child !== null;
  }

  /** Sends the latest view; the helper starts on first publish. */
  publish(view: MenubarView): boolean {
    if (this.permanentlyFailed) return false;
    this.pendingView = view;
    if (this.ready && this.child) {
      this.write({ type: 'update', view });
      return true;
    }
    if (!this.restartTimer) void this.ensureStarted();
    return true;
  }

  /** Opens the panel under the status item (used by the app menu and deep links). */
  open(): void {
    if (this.permanentlyFailed) return;
    if (this.ready && this.child) {
      this.write({ type: 'open' });
      return;
    }
    this.pendingOpen = true;
    if (!this.restartTimer) void this.ensureStarted();
  }

  prepare(): void {
    if (this.permanentlyFailed) return;
    void this.resolveHelperBinary().catch((error) => {
      log.warn('menu bar helper prewarm failed', { error: errorMessage(error) });
    });
  }

  stop(): void {
    this.stopped = true;
    this.permanentlyFailed = true;
    this.suspend();
  }

  /** Gives a helper that hit the restart limit another chance, e.g. when the user turns the item back on. */
  resetFailure(): void {
    if (this.stopped) return;
    this.permanentlyFailed = false;
    this.restartAttempts = 0;
  }

  /** Removes the status item but keeps the host reusable for a later publish. */
  suspend(): void {
    this.lifecycleToken += 1;
    this.clearRestartTimer();
    this.clearRestartHealthyTimer();
    this.restartAttempts = 0;
    this.pendingView = null;
    this.pendingOpen = false;
    this.stdoutBuffer = '';
    const child = this.child;
    this.child = null;
    this.ready = false;
    this.starting = null;
    if (!child || child.killed) return;
    try {
      child.stdin.write(`${JSON.stringify({ type: 'shutdown' })}\n`);
    } catch {
      // The process may already be gone.
    }
    child.kill();
  }

  private write(payload: Record<string, unknown>): void {
    if (!this.child) return;
    try {
      this.child.stdin.write(`${JSON.stringify(payload)}\n`);
    } catch (error) {
      log.warn('failed to write to menu bar helper', { type: payload.type, error: errorMessage(error) });
    }
  }

  private async ensureStarted(): Promise<boolean> {
    if (this.ready && this.child) return true;
    if (this.starting) return this.starting;
    const starting = this.startChildProcess().finally(() => {
      // A start abandoned by suspend() must not clear a newer one.
      if (this.starting === starting) this.starting = null;
    });
    this.starting = starting;
    return starting;
  }

  private async startChildProcess(): Promise<boolean> {
    const lifecycleToken = this.lifecycleToken;
    let binary: string;
    try {
      binary = await this.resolveHelperBinary();
    } catch (error) {
      this.permanentlyFailed = true;
      log.warn('menu bar helper could not be prepared; the menu bar item stays hidden', {
        error: errorMessage(error),
      });
      return false;
    }
    if (this.lifecycleToken !== lifecycleToken || this.permanentlyFailed) return false;

    return new Promise<boolean>((resolve) => {
      let settled = false;
      const child = spawn(binary, [], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, CINDY_MENUBAR_ASSET_DIR: path.dirname(binary) },
      });
      if (this.lifecycleToken !== lifecycleToken || this.permanentlyFailed) {
        if (!child.killed) child.kill();
        resolve(false);
        return;
      }
      this.child = child;
      this.ready = false;
      this.stdoutBuffer = '';

      let startTimer: ReturnType<typeof setTimeout> | null = null;
      const settle = (ok: boolean): void => {
        if (settled) return;
        settled = true;
        if (startTimer) clearTimeout(startTimer);
        if (!ok) {
          if (this.child === child) {
            this.child = null;
            this.ready = false;
          }
          // Also covers a child from an abandoned start that is no longer current.
          if (!child.killed) child.kill();
        }
        resolve(ok);
      };

      startTimer = setTimeout(() => {
        if (this.lifecycleToken !== lifecycleToken || this.permanentlyFailed) {
          settle(false);
          return;
        }
        log.warn('menu bar helper did not become ready in time');
        settle(false);
        this.scheduleRestart(null, null);
      }, HELPER_START_TIMEOUT_MS);

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        this.stdoutBuffer += chunk;
        let newlineIndex = this.stdoutBuffer.indexOf('\n');
        while (newlineIndex >= 0) {
          const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
          this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
          if (line) this.handleLine(line, child, settle);
          newlineIndex = this.stdoutBuffer.indexOf('\n');
        }
      });

      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        const text = chunk.trim();
        if (text) log.debug('menu bar helper stderr', { text });
      });

      const onLost = (reason: string, code: number | null, signal: NodeJS.Signals | null): void => {
        const wasCurrent = this.child === child;
        if (wasCurrent) {
          this.child = null;
          this.ready = false;
          this.clearRestartHealthyTimer();
          if (!child.killed) child.kill();
        }
        if (!settled) settle(false);
        log.debug('menu bar helper lost', { reason, code, signal });
        if (wasCurrent && this.pendingView && !this.permanentlyFailed) this.scheduleRestart(code, signal);
      };
      child.stdin.on('error', (error) => onLost(`stdin: ${error.message}`, null, null));
      child.on('error', (error) => onLost(`process: ${error.message}`, null, null));
      child.on('exit', (code, signal) => onLost('exit', code, signal));
    });
  }

  private handleLine(line: string, child: NativeProcess, settle: (ok: boolean) => void): void {
    if (this.child !== child) return;
    let payload: unknown;
    try {
      payload = JSON.parse(line);
    } catch {
      log.debug('menu bar helper emitted non-json line', { line });
      return;
    }
    const message = parseHelperMessage(payload);
    if (!message) {
      log.debug('menu bar helper emitted unknown message', { line: line.slice(0, 200) });
      return;
    }
    if (message.type === 'ready') {
      this.ready = true;
      settle(true);
      this.armRestartHealthyReset(child);
      if (this.pendingView) this.write({ type: 'update', view: this.pendingView });
      if (this.pendingOpen) {
        this.pendingOpen = false;
        this.write({ type: 'open' });
      }
      return;
    }
    if (message.type === 'error') {
      log.warn('menu bar helper reported an error', { message: message.message });
      return;
    }
    this.options.onMessage(message);
  }

  private resolveHelperBinary(): Promise<string> {
    if (this.helperBinaryPath) return Promise.resolve(this.helperBinaryPath);
    if (this.helperBinaryPromise) return this.helperBinaryPromise;
    this.helperBinaryPromise = resolveHelperBinary()
      .then((binaryPath) => {
        this.helperBinaryPath = binaryPath;
        return binaryPath;
      })
      .finally(() => {
        this.helperBinaryPromise = null;
      });
    return this.helperBinaryPromise;
  }

  private scheduleRestart(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.restartTimer || this.permanentlyFailed) return;
    if (this.restartAttempts >= HELPER_RESTART_MAX_ATTEMPTS) {
      this.permanentlyFailed = true;
      log.warn('menu bar helper restart limit reached; the menu bar item stays hidden', { code, signal });
      return;
    }
    this.restartAttempts += 1;
    const delayMs = Math.min(HELPER_RESTART_BASE_DELAY_MS * 2 ** (this.restartAttempts - 1), HELPER_RESTART_MAX_DELAY_MS);
    log.warn('menu bar helper exited unexpectedly; scheduling restart', {
      attempt: this.restartAttempts,
      code,
      signal,
      delayMs,
    });
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.ready || this.child || this.permanentlyFailed) return;
      void this.ensureStarted();
    }, delayMs);
  }

  private clearRestartTimer(): void {
    if (!this.restartTimer) return;
    clearTimeout(this.restartTimer);
    this.restartTimer = null;
  }

  private armRestartHealthyReset(child: NativeProcess): void {
    this.clearRestartHealthyTimer();
    this.restartHealthyTimer = setTimeout(() => {
      this.restartHealthyTimer = null;
      if (this.child === child && this.ready) this.restartAttempts = 0;
    }, HELPER_RESTART_HEALTHY_RESET_MS);
  }

  private clearRestartHealthyTimer(): void {
    if (!this.restartHealthyTimer) return;
    clearTimeout(this.restartHealthyTimer);
    this.restartHealthyTimer = null;
  }
}

/** Validates helper output; the helper is ours, but main never trusts a child process blindly. */
export function parseHelperMessage(input: unknown): MenubarHelperMessage | null {
  if (!input || typeof input !== 'object') return null;
  const value = input as Record<string, unknown>;
  switch (value.type) {
    case 'ready':
    case 'refresh':
    case 'open-app':
    case 'open-provider-settings':
    case 'open-remote-control-settings':
      return { type: value.type };
    case 'error':
      return { type: 'error', message: typeof value.message === 'string' ? value.message.slice(0, 500) : '' };
    case 'panel':
      return typeof value.open === 'boolean' ? { type: 'panel', open: value.open } : null;
    case 'open-session':
      return typeof value.sessionId === 'string' && value.sessionId ? { type: 'open-session', sessionId: value.sessionId } : null;
    case 'detail-action':
      return typeof value.sourceId === 'string' && value.sourceId ? { type: 'detail-action', sourceId: value.sourceId } : null;
    case 'settings':
      return value.patch && typeof value.patch === 'object'
        ? { type: 'settings', patch: pickSettingsPatch(value.patch as Record<string, unknown>) }
        : null;
    default:
      return null;
  }
}

function pickSettingsPatch(raw: Record<string, unknown>): MenubarSettingsPatch {
  const patch: MenubarSettingsPatch = {};
  for (const key of ['order', 'hidden', 'shown'] as const) {
    if (Array.isArray(raw[key])) patch[key] = (raw[key] as unknown[]).filter((id): id is string => typeof id === 'string');
  }
  for (const key of ['lowAlert', 'privacy'] as const) {
    if (typeof raw[key] === 'boolean') patch[key] = raw[key] as boolean;
  }
  if (MENUBAR_STATUS_TEXT_MODES.includes(raw.statusText as never)) patch.statusText = raw.statusText as MenubarSettingsPatch['statusText'];
  if (MENUBAR_USAGE_SCOPES.includes(raw.scope as never)) patch.scope = raw.scope as MenubarSettingsPatch['scope'];
  return patch;
}

async function resolveHelperBinary(): Promise<string> {
  if (app.isPackaged) return path.join(process.resourcesPath, HELPER_RESOURCE);
  await buildDevHelper();
  return devBinaryPath();
}

/** Dev builds compile the single-file helper on demand, keyed by the source hash. */
async function buildDevHelper(): Promise<void> {
  const source = devSourcePath(HELPER_SOURCE_RELATIVE);
  const binary = devBinaryPath();
  if (!fs.existsSync(source)) throw new Error(`menu bar helper source missing at ${source}`);
  copyDevAssets(path.dirname(source), path.dirname(binary));
  const sourceHash = createHash('sha256').update(fs.readFileSync(source)).digest('hex');
  const hashFile = `${binary}.sha256`;
  if (fs.existsSync(binary) && fs.existsSync(hashFile) && fs.readFileSync(hashFile, 'utf8').trim() === sourceHash) {
    return;
  }
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  const arch = process.arch === 'arm64' ? 'arm64' : 'x86_64';
  await execFilePromise(
    'swiftc',
    [source, '-O', '-parse-as-library', '-target', `${arch}-apple-${HELPER_DEPLOYMENT_TARGET}`, '-o', binary],
    DEV_BUILD_TIMEOUT_MS,
  );
  fs.chmodSync(binary, 0o755);
  fs.writeFileSync(hashFile, `${sourceHash}\n`, 'utf8');
  log.info('built dev macOS menu bar helper', { path: binary });
}

function devSourcePath(relative: string): string {
  const fromAppPath = path.join(app.getAppPath(), relative);
  if (fs.existsSync(fromAppPath)) return fromAppPath;
  return path.join(__dirname, '..', '..', relative);
}

function devBinaryPath(): string {
  return path.join(app.getPath('userData'), 'menubar', HELPER_NAME);
}

function copyDevAssets(sourceDir: string, destDir: string): void {
  fs.mkdirSync(destDir, { recursive: true });
  for (const name of HELPER_ASSETS) {
    const source = path.join(sourceDir, name);
    if (!fs.existsSync(source)) throw new Error(`menu bar helper asset missing at ${source}`);
    const dest = path.join(destDir, name);
    const sourceStat = fs.statSync(source);
    if (fs.existsSync(dest)) {
      const destStat = fs.statSync(dest);
      if (destStat.mtimeMs >= sourceStat.mtimeMs && destStat.size === sourceStat.size) continue;
    }
    fs.copyFileSync(source, dest);
  }
}

function execFilePromise(file: string, args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, { timeout: timeoutMs }, (error, _stdout, stderr) => {
      if (error) {
        reject(new Error(stderr?.trim() ? `${error.message}: ${stderr.trim()}` : error.message));
        return;
      }
      resolve();
    });
    child.on('error', reject);
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
