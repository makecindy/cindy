import { app } from 'electron';
import { execFile, spawn, type ChildProcessByStdio } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Readable } from 'node:stream';

import {
  isVoiceInputBareFunctionKeyShortcut,
  type VoiceInputShortcut,
} from '../../shared/voiceInputData.js';
import { createLogger } from '../logger.js';
import {
  ShortcutHoldPhaseController,
  type ShortcutHoldPhase,
} from './ShortcutHoldPhaseController.js';

const log = createLogger('voice-input:windows-function-key-shortcut');

const RESOURCE_PATH = path.join('tools', 'voice-input', 'cindy-windows-function-key-listener.exe');
const SOURCE_RELATIVE_PATH = path.join('native', 'voice-input', 'windows-function-key-listener');
const START_TIMEOUT_MS = 3_000;
const RESTART_MAX_ATTEMPTS = 3;
const RESTART_BASE_DELAY_MS = 1_000;
const RESTART_MAX_DELAY_MS = 5_000;
const RESTART_STABLE_MS = 10_000;

export type WindowsFunctionKeyListenerStartResult =
  { ok: true } | { ok: false; error: string; superseded?: true };

type ListenerPayload = {
  type?: unknown;
  pressed?: unknown;
  message?: unknown;
};

type ListenerProcess = ChildProcessByStdio<null, Readable, Readable>;

export interface WindowsFunctionKeyShortcutListenerOptions {
  onTrigger: (phase: ShortcutHoldPhase) => void;
  onRestartLimitReached?: () => void;
}

function supersededStart(): WindowsFunctionKeyListenerStartResult {
  return { ok: false, error: 'Function key listener start was superseded.', superseded: true };
}

/**
 * Owns the Windows low-level keyboard helper used for bare F1-F24 shortcuts.
 * The helper reports and suppresses only the configured key; tap/hold timing
 * stays in TypeScript so both desktop platforms share the same product semantics.
 */
export class WindowsFunctionKeyShortcutListener {
  private child: ListenerProcess | null = null;
  private ready = false;
  private shortcutCode: string | null = null;
  private startGeneration = 0;
  private restartAttempts = 0;
  private restartTimer: NodeJS.Timeout | null = null;
  private stableTimer: NodeJS.Timeout | null = null;
  private readonly phaseController: ShortcutHoldPhaseController;

  constructor(private readonly options: WindowsFunctionKeyShortcutListenerOptions) {
    this.phaseController = new ShortcutHoldPhaseController({ onTrigger: options.onTrigger });
  }

  isReady(): boolean {
    return this.ready && Boolean(this.child && !this.child.killed);
  }

  async setShortcut(shortcut: VoiceInputShortcut): Promise<WindowsFunctionKeyListenerStartResult> {
    if (!isVoiceInputBareFunctionKeyShortcut(shortcut)) {
      this.stop();
      return { ok: true };
    }
    if (this.shortcutCode === shortcut.code && this.isReady()) return { ok: true };

    this.shortcutCode = shortcut.code;
    this.restartAttempts = 0;
    this.clearRestartTimer();
    this.clearStableTimer();
    this.stopChildKeepingShortcut();
    return this.startChildProcess(shortcut.code);
  }

  releaseActiveTrigger(): void {
    const code = this.shortcutCode;
    const shouldRestart = this.isReady();
    this.phaseController.releaseIfPressed();
    this.phaseController.reset();
    if (!code || !shouldRestart) return;

    // Windows may drop the physical key-up while suspending or locking. The
    // helper also owns the physical-press state, so reset the process itself
    // rather than only clearing the TypeScript phase controller.
    this.restartAttempts = 0;
    this.clearRestartTimer();
    this.clearStableTimer();
    this.stopChildKeepingShortcut();
    void this.startChildProcess(code)
      .then((result) => {
        if (!result.ok && !result.superseded) {
          log.warn('Windows function key listener did not restart after system release', {
            code,
            error: result.error,
          });
          this.scheduleRestart(code, null, null);
        }
      })
      .catch((error: unknown) => {
        log.warn('Windows function key listener restart after system release crashed', {
          code,
          error: error instanceof Error ? error.message : String(error),
        });
        this.scheduleRestart(code, null, null);
      });
  }

  stop(): void {
    this.shortcutCode = null;
    this.restartAttempts = 0;
    this.clearRestartTimer();
    this.clearStableTimer();
    this.stopChildKeepingShortcut();
  }

  private stopChildKeepingShortcut(): void {
    this.startGeneration += 1;
    const child = this.child;
    this.child = null;
    this.ready = false;
    this.phaseController.releaseIfPressed();
    this.phaseController.reset();
    if (child && !child.killed) child.kill();
  }

  private async startChildProcess(code: string): Promise<WindowsFunctionKeyListenerStartResult> {
    const generation = ++this.startGeneration;
    let binary: string;
    try {
      binary = await resolveWindowsFunctionKeyListenerBinary();
    } catch (error) {
      if (generation !== this.startGeneration) return supersededStart();
      throw error;
    }
    if (generation !== this.startGeneration || this.shortcutCode !== code) return supersededStart();

    return new Promise((resolve) => {
      let settled = false;
      let stdoutBuffer = '';
      const child = spawn(binary, [code], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      this.child = child;
      this.ready = false;

      let startTimer: NodeJS.Timeout | null = null;
      const settle = (result: WindowsFunctionKeyListenerStartResult): void => {
        if (settled) return;
        settled = true;
        if (startTimer) clearTimeout(startTimer);
        const stale =
          generation !== this.startGeneration || this.child !== child || this.shortcutCode !== code;
        const outcome = stale ? supersededStart() : result;
        if (result.ok && !stale) {
          this.ready = true;
          this.armStableTimer();
        }
        if (!result.ok && this.child === child) {
          this.child = null;
          this.ready = false;
          this.phaseController.releaseIfPressed();
          this.phaseController.reset();
          if (!child.killed) child.kill();
        }
        resolve(outcome);
      };

      startTimer = setTimeout(() => {
        settle({ ok: false, error: 'Windows function key listener did not start.' });
      }, START_TIMEOUT_MS);

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        stdoutBuffer += chunk;
        let newlineIndex = stdoutBuffer.indexOf('\n');
        while (newlineIndex >= 0) {
          const line = stdoutBuffer.slice(0, newlineIndex).trim();
          stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
          if (line) this.handlePayloadLine(line, child, settle);
          newlineIndex = stdoutBuffer.indexOf('\n');
        }
      });

      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        const text = chunk.trim();
        if (text) log.debug('Windows function key listener stderr', { text });
      });

      child.on('error', (error) => {
        if (settled) {
          log.warn('Windows function key listener process error', { error: error.message });
          return;
        }
        settle({ ok: false, error: error.message });
      });

      child.on('exit', (exitCode, signal) => {
        const wasCurrentChild = this.child === child;
        if (!settled) {
          settle({
            ok: false,
            error: `Windows function key listener exited before ready (${signal ?? exitCode ?? 'unknown'}).`,
          });
          return;
        }
        if (wasCurrentChild) {
          this.child = null;
          this.ready = false;
          this.clearStableTimer();
          this.phaseController.releaseIfPressed();
          this.phaseController.reset();
        }
        log.debug('Windows function key listener exited', { exitCode, signal });
        if (wasCurrentChild && this.shortcutCode === code)
          this.scheduleRestart(code, exitCode, signal);
      });
    });
  }

  private handlePayloadLine(
    line: string,
    child: ListenerProcess,
    settle: (result: WindowsFunctionKeyListenerStartResult) => void,
  ): void {
    let payload: ListenerPayload;
    try {
      payload = JSON.parse(line) as ListenerPayload;
    } catch {
      log.debug('Windows function key listener emitted non-json line', { line });
      return;
    }
    if (payload.type === 'ready') {
      settle({ ok: true });
      log.info('Windows function key listener ready', { code: this.shortcutCode });
      return;
    }
    if (payload.type === 'error') {
      settle({
        ok: false,
        error:
          typeof payload.message === 'string'
            ? payload.message
            : 'Windows function key listener failed.',
      });
      return;
    }
    if (payload.type === 'canceled' && this.child === child) {
      this.phaseController.setPressed(false, true);
      return;
    }
    if (
      payload.type === 'pressed' &&
      typeof payload.pressed === 'boolean' &&
      this.child === child
    ) {
      this.phaseController.setPressed(payload.pressed);
    }
  }

  private scheduleRestart(
    code: string,
    exitCode: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    if (!this.shortcutCode || this.restartTimer) return;
    if (this.restartAttempts >= RESTART_MAX_ATTEMPTS) {
      log.warn('Windows function key listener restart limit reached', { code, exitCode, signal });
      this.shortcutCode = null;
      this.options.onRestartLimitReached?.();
      return;
    }
    this.restartAttempts += 1;
    const delayMs = Math.min(
      RESTART_BASE_DELAY_MS * 2 ** (this.restartAttempts - 1),
      RESTART_MAX_DELAY_MS,
    );
    log.warn('Windows function key listener exited unexpectedly; scheduling restart', {
      code,
      exitCode,
      signal,
      attempt: this.restartAttempts,
      delayMs,
    });
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.shortcutCode !== code || this.child) return;
      void this.startChildProcess(code)
        .then((result) => {
          if (!result.ok) {
            this.scheduleRestart(code, null, null);
          }
        })
        .catch((error: unknown) => {
          log.warn('Windows function key listener restart crashed', {
            code,
            error: error instanceof Error ? error.message : String(error),
          });
          this.scheduleRestart(code, null, null);
        });
    }, delayMs);
  }

  private clearRestartTimer(): void {
    if (!this.restartTimer) return;
    clearTimeout(this.restartTimer);
    this.restartTimer = null;
  }

  private armStableTimer(): void {
    this.clearStableTimer();
    this.stableTimer = setTimeout(() => {
      this.stableTimer = null;
      this.restartAttempts = 0;
    }, RESTART_STABLE_MS);
  }

  private clearStableTimer(): void {
    if (!this.stableTimer) return;
    clearTimeout(this.stableTimer);
    this.stableTimer = null;
  }
}

async function resolveWindowsFunctionKeyListenerBinary(): Promise<string> {
  if (app.isPackaged) return path.join(process.resourcesPath, RESOURCE_PATH);
  if (process.platform !== 'win32') {
    throw new Error('The Windows function key listener can only run on Windows.');
  }
  const sourceRoot = resolveDevSourceRoot();
  const binary = path.join(
    sourceRoot,
    'target',
    'release',
    'cindy-windows-function-key-listener.exe',
  );
  if (isDevBinaryCurrent(sourceRoot, binary)) return binary;
  await execFilePromise(
    resolveCargoExecutable(),
    ['build', '--release', '--manifest-path', path.join(sourceRoot, 'Cargo.toml')],
    120_000,
  );
  return binary;
}

function resolveDevSourceRoot(): string {
  const appPathSource = path.join(app.getAppPath(), SOURCE_RELATIVE_PATH);
  if (fs.existsSync(appPathSource)) return appPathSource;
  return path.join(__dirname, '..', '..', SOURCE_RELATIVE_PATH);
}

export function listWindowsFunctionKeyListenerSourceFiles(sourceRoot: string): string[] {
  const files = [path.join(sourceRoot, 'Cargo.toml'), path.join(sourceRoot, 'Cargo.lock')];
  const srcRoot = path.join(sourceRoot, 'src');
  collectRustSources(srcRoot, files);
  return files;
}

function collectRustSources(dir: string, files: string[]): void {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectRustSources(fullPath, files);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.rs')) files.push(fullPath);
  }
}

export function isDevBinaryCurrent(sourceRoot: string, binary: string): boolean {
  if (!fs.existsSync(binary)) return false;
  const binaryMtimeMs = fs.statSync(binary).mtimeMs;
  return listWindowsFunctionKeyListenerSourceFiles(sourceRoot).every(
    (source) => !fs.existsSync(source) || fs.statSync(source).mtimeMs <= binaryMtimeMs,
  );
}

function resolveCargoExecutable(): string {
  const userProfileCargo = process.env.USERPROFILE
    ? path.join(process.env.USERPROFILE, '.cargo', 'bin', 'cargo.exe')
    : null;
  return userProfileCargo && fs.existsSync(userProfileCargo) ? userProfileCargo : 'cargo';
}

function execFilePromise(file: string, args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs, windowsHide: true }, (error, _stdout, stderr) => {
      if (error) {
        reject(new Error(stderr?.trim() || error.message));
        return;
      }
      resolve();
    });
  });
}
