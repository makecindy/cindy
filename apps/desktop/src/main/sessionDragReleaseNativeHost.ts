import { execFile, spawn, type ChildProcessByStdio } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import type { Readable, Writable } from 'node:stream';

import { createLogger } from './logger.js';

const log = createLogger('session-drag-release/native');
const HELPER_RESOURCE = path.join(
  'tools',
  'session-drag-release',
  'xdt-macos-session-drag-release-helper',
);
const HELPER_SOURCE_RELATIVE = path.join(
  'native',
  'session-drag-release',
  'macos-session-drag-release-helper.swift',
);
const HELPER_START_TIMEOUT_MS = 1_500;
const HELPER_BUILD_TIMEOUT_MS = 15_000;
const DEV_BINARY_NAME = 'xdt-macos-session-drag-release-helper';
const DEV_BINARY_DIR = 'session-drag-release';

type NativeProcess = ChildProcessByStdio<Writable, Readable, Readable>;

export interface SessionDragReleaseNativeHostOptions {
  onMouseUp: (token: number) => void;
}

interface NativePayload {
  type?: unknown;
  token?: unknown;
}

export class SessionDragReleaseNativeHost {
  private child: NativeProcess | null = null;
  private stdoutBuffer = '';
  private ready = false;
  private starting: Promise<boolean> | null = null;
  private desiredToken: number | null = null;
  private disposed = false;

  constructor(private readonly options: SessionDragReleaseNativeHostOptions) {}

  async arm(token: number): Promise<boolean> {
    if (process.platform !== 'darwin' || this.disposed) return false;
    this.desiredToken = token;
    if (!(await this.ensureStarted()) || !this.child || !this.ready) return false;
    if (this.desiredToken !== token) return false;
    return this.writeCommand({ type: 'arm', token });
  }

  disarm(): void {
    if (process.platform !== 'darwin') return;
    this.desiredToken = null;
    if (this.ready && this.child) this.writeCommand({ type: 'disarm' });
  }

  async prewarm(): Promise<boolean> {
    if (process.platform !== 'darwin' || this.disposed) return false;
    return this.ensureStarted();
  }

  dispose(): void {
    this.disposed = true;
    this.desiredToken = null;
    const child = this.child;
    this.child = null;
    this.ready = false;
    if (child && !child.killed) child.kill();
  }

  private ensureStarted(): Promise<boolean> {
    if (this.ready && this.child && !this.child.killed) return Promise.resolve(true);
    if (this.starting) return this.starting;
    this.starting = this.start().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async start(): Promise<boolean> {
    let binary: string;
    try {
      binary = await resolveHelperBinary();
    } catch (error) {
      log.warn('session drag release helper could not be prepared', {
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
    if (this.disposed) return false;

    return new Promise<boolean>((resolve) => {
      let settled = false;
      const child = spawn(binary, [], { stdio: ['pipe', 'pipe', 'pipe'] });
      this.child = child;
      this.ready = false;
      this.stdoutBuffer = '';
      const timer = setTimeout(() => {
        settle(false);
        if (this.child === child) this.child = null;
        if (!child.killed) child.kill();
      }, HELPER_START_TIMEOUT_MS);
      const settle = (ok: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(ok);
      };

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        this.stdoutBuffer += chunk;
        let newline = this.stdoutBuffer.indexOf('\n');
        while (newline >= 0) {
          const line = this.stdoutBuffer.slice(0, newline).trim();
          this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
          if (line) this.handlePayload(line, child, settle);
          newline = this.stdoutBuffer.indexOf('\n');
        }
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        const text = chunk.trim();
        if (text) log.debug('session drag release helper stderr', { text });
      });
      child.stdin.on('error', (error) => {
        log.debug('session drag release helper stdin closed', { error: error.message });
      });
      child.on('error', (error) => {
        log.warn('session drag release helper process error', { error: error.message });
        if (this.child === child) {
          this.child = null;
          this.ready = false;
        }
        settle(false);
      });
      child.on('exit', (code, signal) => {
        if (this.child === child) {
          this.child = null;
          this.ready = false;
        }
        settle(false);
        log.debug('session drag release helper exited', { code, signal });
      });
    });
  }

  private handlePayload(line: string, child: NativeProcess, settle: (ok: boolean) => void): void {
    let payload: NativePayload;
    try {
      payload = JSON.parse(line) as NativePayload;
    } catch {
      return;
    }
    if (payload.type === 'ready' && this.child === child) {
      this.ready = true;
      settle(true);
      return;
    }
    if (payload.type === 'mouse-up' && typeof payload.token === 'number') {
      if (this.desiredToken !== payload.token) return;
      this.desiredToken = null;
      this.options.onMouseUp(payload.token);
      return;
    }
    if (payload.type === 'unavailable') {
      log.warn('session drag release helper could not install an event monitor');
    }
  }

  private writeCommand(command: { type: string; token?: number }): boolean {
    const line = `${JSON.stringify(command)}\n`;
    if (!this.child || !this.ready) return false;
    try {
      this.child.stdin.write(line);
      return true;
    } catch {
      return false;
    }
  }
}

let helperBinaryPromise: Promise<string> | null = null;

async function resolveHelperBinary(): Promise<string> {
  if (app.isPackaged) return path.join(process.resourcesPath, HELPER_RESOURCE);
  if (!helperBinaryPromise) {
    helperBinaryPromise = buildDevHelperBinary().finally(() => {
      helperBinaryPromise = null;
    });
  }
  return helperBinaryPromise;
}

async function buildDevHelperBinary(): Promise<string> {
  const source = resolveDevHelperSource();
  const binary = path.join(app.getPath('userData'), DEV_BINARY_DIR, DEV_BINARY_NAME);
  if (!fs.existsSync(source)) {
    throw new Error(`Session drag release helper source missing at ${source}`);
  }
  const hashPath = `${binary}.sha256`;
  const sourceHash = createHash('sha256').update(fs.readFileSync(source)).digest('hex');
  if (
    fs.existsSync(binary) &&
    fs.existsSync(hashPath) &&
    fs.readFileSync(hashPath, 'utf8').trim() === sourceHash
  ) {
    return binary;
  }
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  await execFilePromise('swiftc', [source, '-O', '-o', binary], HELPER_BUILD_TIMEOUT_MS);
  fs.chmodSync(binary, 0o755);
  fs.writeFileSync(hashPath, `${sourceHash}\n`, 'utf8');
  log.info('built dev macOS session drag release helper', { path: binary });
  return binary;
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
