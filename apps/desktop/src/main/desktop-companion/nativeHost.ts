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

  async ensureStarted(): Promise<void> {
    if (this.proc && !this.proc.killed) return;
    const binary = await resolveHelperBinary();
    const child = spawn(binary, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc = child;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.onStdout(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      log.warn('helper stderr', { chunk: chunk.slice(0, 400) });
    });
    child.on('exit', (code) => {
      log.info('helper exit', { code });
      this.failAll(new Error('desktop companion helper exited'));
      this.proc = null;
    });
  }

  async setWallpaper(filePath: string): Promise<void> {
    const result = await this.request({ op: 'setWallpaper', path: filePath });
    if (result.ok !== true) throw new Error(String(result.error ?? 'setWallpaper failed'));
  }

  async playVideo(filePath: string): Promise<void> {
    const result = await this.request({ op: 'playVideo', path: filePath });
    if (result.ok !== true) throw new Error(String(result.error ?? 'playVideo failed'));
  }

  async stopVideo(): Promise<void> {
    if (!this.proc) return;
    const result = await this.request({ op: 'stopVideo' });
    if (result.ok !== true) throw new Error(String(result.error ?? 'stopVideo failed'));
  }

  async locateCity(): Promise<string | null> {
    const result = await this.request({ op: 'locate' }, 12_000);
    if (result.ok !== true) return null;
    const city = typeof result.city === 'string' ? result.city.trim() : '';
    return city || null;
  }

  async stop(): Promise<void> {
    if (!this.proc) return;
    try {
      await this.request({ op: 'quit' }, 1_000);
    } catch {
      this.proc.kill();
    }
    this.proc = null;
    this.failAll(new Error('desktop companion helper stopped'));
  }

  private async request(payload: Record<string, unknown>, timeoutMs = 8_000): Promise<Record<string, unknown>> {
    await this.ensureStarted();
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
      this.proc?.stdin.write(line);
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

export function characterReferencePath(): string | null {
  const candidates = [
    path.join(process.resourcesPath ?? '', 'tools', 'desktop-companion', 'cindy-character.jpg'),
    path.join(app.getAppPath(), SOURCE_RELATIVE.replace('macos-desktop-companion-helper.swift', 'cindy-character.jpg')),
    path.join(__dirname, '..', '..', '..', CHARACTER_RELATIVE),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
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
