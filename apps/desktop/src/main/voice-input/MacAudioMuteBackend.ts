import { app } from 'electron';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

export type NativeAudioSnapshot = {
  outputMuted: boolean;
  deviceId: number;
  deviceUID: string;
};

type CommandResult = { stdout: string; error: Error | null };
type RunCommand = (file: string, args: string[], timeout: number) => Promise<CommandResult>;
const runCommand: RunCommand = (file, args, timeout) =>
  new Promise((resolve) => {
    execFile(file, args, { timeout, maxBuffer: 16_384 }, (error, stdout) => {
      // stdout contains the original state even if a later OS write failed.
      resolve({ stdout, error });
    });
  });

function parseSnapshot(stdout: string): NativeAudioSnapshot | undefined {
  try {
    const value = JSON.parse(stdout.trim());
    if (
      typeof value.outputMuted === 'boolean' &&
      Number.isInteger(value.deviceId) &&
      value.deviceId > 0 &&
      value.deviceId <= 0xffffffff &&
      typeof value.deviceUID === 'string' &&
      value.deviceUID.length > 0
    )
      return value;
  } catch {
    /* Missing snapshot means the helper has not reached a write. */
  }
  return undefined;
}

async function prepareBinary(): Promise<string> {
  const name = 'cindy-macos-audio-mute-helper';
  if (app.isPackaged) return path.join(process.resourcesPath, 'tools', 'voice-input', name);
  const relative = path.join('native', 'voice-input', 'macos-audio-mute-helper.swift');
  let source = path.join(app.getAppPath(), relative);
  try {
    await fs.access(source);
  } catch {
    source = path.join(__dirname, '..', '..', relative);
  }
  const binary = path.join(app.getPath('userData'), 'voice-input', name);
  const sourceStat = await fs.stat(source);
  const binaryStat = await fs.stat(binary).catch(() => null);
  if (!binaryStat || binaryStat.mtimeMs < sourceStat.mtimeMs) {
    await fs.mkdir(path.dirname(binary), { recursive: true });
    // Compile away from the live binary, so an existing instance never runs
    // a partially written executable. Compilation only happens during warmup.
    const temporary = await fs.mkdtemp(path.join(path.dirname(binary), 'audio-build-'));
    try {
      const output = path.join(temporary, name);
      const result = await runCommand('/usr/bin/xcrun', ['swiftc', source, '-o', output], 30_000);
      if (result.error) throw result.error;
      await fs.rename(output, binary);
    } finally {
      await fs.rm(temporary, { recursive: true, force: true });
    }
  }
  return binary;
}

export class MacAudioMuteBackend {
  private binary: string | undefined;
  private warmup: Promise<void> | undefined;

  constructor(
    private readonly prepare: () => Promise<string> = prepareBinary,
    private readonly run: RunCommand = runCommand,
  ) {}

  prewarm(): Promise<void> {
    if (process.platform !== 'darwin') return Promise.resolve();
    this.warmup ??= (async () => {
      try {
        const binary = await this.prepare();
        const result = await this.run(binary, ['read'], 2_000);
        // Unsupported current devices can fall back per operation later. A
        // successful probe is required before we put native on the click path.
        if (!result.error && parseSnapshot(result.stdout)) this.binary = binary;
      } catch {
        /* AppleScript remains available; warmup cannot block input. */
      }
    })();
    return this.warmup;
  }

  async mute(onSnapshot: (snapshot: NativeAudioSnapshot) => void): Promise<boolean> {
    if (!this.binary) return false;
    const result = await this.run(this.binary, ['mute'], 2_000);
    const snapshot = parseSnapshot(result.stdout);
    if (!snapshot) return false; // No write occurred; safe to use AppleScript.
    onSnapshot(snapshot);
    if (result.error) throw result.error; // Keep original snapshot for restore.
    return true;
  }

  async setMuted(snapshot: NativeAudioSnapshot, muted: boolean): Promise<void> {
    if (!this.binary) throw new Error('Native audio helper unavailable');
    const result = await this.run(
      this.binary,
      ['set', String(snapshot.deviceId), snapshot.deviceUID, String(muted)],
      2_000,
    );
    if (result.error) throw result.error;
    if (!parseSnapshot(result.stdout)) throw new Error('Invalid native audio helper response');
  }
}

export const macAudioMuteBackend = new MacAudioMuteBackend();
