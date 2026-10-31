import { app } from 'electron';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';

import { createLogger } from '../logger.js';

const execFilePromise = promisify(execFile);
const log = createLogger('desktop-companion:native');

const HELPER_NAME = 'cindy-macos-desktop-companion-helper';
const SOURCE_RELATIVE = path.join('native', 'desktop-companion', 'macos-desktop-companion-helper.swift');
const CHARACTER_RELATIVE = path.join('native', 'desktop-companion', 'cindy-character.jpg');

type Pending = {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
};

export class MacDesktopCompanionNativeHost {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private buffer = '';
  private nextId = 1;
  private pending = new Map<string, Pending>();
  private starting: Promise<void> | null = null;
  private generation = 0;
  private stopping = false;

  async ensureStarted(): Promise<void> {
    if (this.stopping) throw new Error('HOST_STOPPED');
    if (this.proc && !this.proc.killed) return;
    if (this.starting) return this.starting;
    const generation = this.generation;
    this.starting = this.start(generation);
    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
  }

  private async start(generation: number): Promise<void> {
    const binary = await resolveHelperBinary();
    if (generation !== this.generation) throw new Error('HOST_STOPPED');
    const child = spawn(binary, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc = child;
    this.buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.onStdout(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      log.warn('helper stderr', { chunk: chunk.slice(0, 400) });
    });
    child.on('exit', (code) => {
      log.info('helper exit', { code });
      if (this.proc !== child) return;
      this.failAll(new Error('desktop companion helper exited'));
      this.proc = null;
    });
  }

  async setWallpaper(filePath: string, assertStillValid: () => void): Promise<void> {
    const result = await this.request({ op: 'setWallpaper', path: filePath }, 8_000, assertStillValid);
    if (result.ok !== true) throw new Error(String(result.error ?? 'setWallpaper failed'));
  }

  async playVideo(filePath: string, assertStillValid: () => void): Promise<void> {
    const result = await this.request({ op: 'playVideo', path: filePath }, 8_000, assertStillValid);
    if (result.ok !== true) throw new Error(String(result.error ?? 'playVideo failed'));
  }

  async stopVideo(): Promise<void> {
    if (!this.proc) return;
    const result = await this.send(this.proc, { op: 'stopVideo' }, 8_000);
    if (result.ok !== true) throw new Error(String(result.error ?? 'stopVideo failed'));
  }

  async locateCity(): Promise<string | null> {
    const result = await this.request({ op: 'locate' }, 12_000);
    if (result.ok !== true) throw new Error(String(result.error ?? 'locate failed'));
    const city = typeof result.city === 'string' ? result.city.trim() : '';
    return city || null;
  }

  async stop(): Promise<void> {
    this.generation += 1;
    this.stopping = true;
    try {
      try {
        await this.starting;
      } catch (error) {
        if (!(error instanceof Error) || error.message !== 'HOST_STOPPED') throw error;
      }
      const child = this.proc;
      if (!child) return;
      // The helper exits when stdin closes. Await exit before a new owner can start it.
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('desktop companion helper stop timeout')), 8_000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
        child.stdin.end();
      });
    } finally {
      this.stopping = false;
    }
  }

  private async request(payload: Record<string, unknown>, timeoutMs = 8_000, assertStillValid?: () => void): Promise<Record<string, unknown>> {
    const generation = this.generation;
    await this.ensureStarted();
    if (generation !== this.generation || !this.proc) throw new Error('HOST_STOPPED');
    assertStillValid?.();
    return this.send(this.proc, payload, timeoutMs);
  }

  private send(child: ChildProcessWithoutNullStreams, payload: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>> {
    const id = String(this.nextId++);
    const line = JSON.stringify({ id, ...payload }) + '\n';
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('desktop companion helper timeout'));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      child.stdin.write(line);
    });
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    let index = this.buffer.indexOf('\n');
    while (index >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line) this.onLine(line);
      index = this.buffer.indexOf('\n');
    }
  }

  private onLine(line: string): void {
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      const id = typeof parsed.id === 'string' ? parsed.id : '';
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      pending.resolve(parsed);
    } catch (error) {
      log.warn('helper line parse failed', { line: line.slice(0, 200), error: String(error) });
    }
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

export function characterReferencePath(): string {
  const candidates = [
    path.join(process.resourcesPath ?? '', 'tools', 'desktop-companion', 'cindy-character.jpg'),
    path.join(app.getAppPath(), SOURCE_RELATIVE.replace('macos-desktop-companion-helper.swift', 'cindy-character.jpg')),
    path.join(__dirname, '..', '..', '..', CHARACTER_RELATIVE),
  ];
  const source = candidates.find((candidate) => fs.existsSync(candidate));
  if (!source) throw new Error('CHARACTER_REFERENCE_MISSING');
  return source;
}

async function resolveHelperBinary(): Promise<string> {
  const packaged = path.join(process.resourcesPath ?? '', 'tools', 'desktop-companion', HELPER_NAME);
  if (fs.existsSync(packaged)) return packaged;
  const source = [
    path.join(app.getAppPath(), SOURCE_RELATIVE),
    path.join(__dirname, '..', '..', '..', SOURCE_RELATIVE),
  ].find((candidate) => fs.existsSync(candidate));
  if (!source) throw new Error('desktop companion helper source missing');
  const outDir = path.join(app.getPath('userData'), 'desktop-companion');
  fs.mkdirSync(outDir, { recursive: true });
  const binary = path.join(outDir, HELPER_NAME);
  const sourceStat = fs.statSync(source);
  const binaryStat = fs.existsSync(binary) ? fs.statSync(binary) : null;
  if (binaryStat && binaryStat.mtimeMs >= sourceStat.mtimeMs) return binary;
  await execFilePromise('swiftc', ['-O', '-o', binary, source], { timeout: 120_000 });
  fs.chmodSync(binary, 0o755);
  return binary;
}
