import { spawn } from 'node:child_process';

import { createLogger } from '../logger.js';
import { macAudioMuteBackend, type NativeAudioSnapshot } from './MacAudioMuteBackend.js';

const log = createLogger('voice-input:system-audio');

// WebContents owners are numeric; the remote session has a separate identity.
type AudioMuteOwner = number | 'remote-desktop';

type AudioSnapshot = {
  outputMuted: boolean;
  native?: NativeAudioSnapshot;
};

type LoudnessModule = {
  getMuted(): Promise<boolean>;
  setMuted(muted: boolean): Promise<void>;
};

// loudness 在 Windows 上通过包内自带的 adjust_get_current_system_volume_vista_plus.exe
// 调 Core Audio API 读/写系统输出 mute 状态。Mac 优先使用预热完成的原生 helper，
// 未就绪或设备不支持时使用 osascript。Linux/其他平台静默 no-op。
//
// 使用 lazy 动态 import 而非 top-level import 的原因:
//   - packaged Mac 版本里我们刻意不打包 loudness（见 forge.config.ts 的
//     bundleNativeDeps），top-level import 会在 Mac 启动时直接 ENOENT。
//   - dev 模式下根 node_modules 里有 loudness/execa，所以三平台都能 require 通；
//     但 Mac 上根本不会进 win32 分支，也就永远不会真的 load 它。
let loudnessCache: LoudnessModule | null | undefined;
async function loadLoudness(): Promise<LoudnessModule | null> {
  if (process.platform !== 'win32') return null;
  if (loudnessCache !== undefined) return loudnessCache;
  try {
    const mod = await import('loudness');
    loudnessCache =
      (mod as { default?: LoudnessModule }).default ?? (mod as unknown as LoudnessModule);
  } catch (err) {
    log.warn('failed to load loudness on Windows', {
      error: err instanceof Error ? err.message : String(err),
    });
    loudnessCache = null;
  }
  return loudnessCache;
}

const SUPPORTS_MUTE = process.platform === 'darwin' || process.platform === 'win32';

/**
 * SystemAudioMuteGuard temporarily mutes system output while dictation is active.
 *
 * It preserves the user's prior muted state and uses owner ids so overlapping
 * voice-input sessions cannot restore audio until the last owner finishes.
 *
 * Platform support:
 *   - macOS:   native CoreAudio helper, with `osascript` fallback.
 *   - Windows: `loudness` npm package (ships a tiny native helper exe).
 *   - other:   no-op (graceful degradation).
 */
export class SystemAudioMuteGuard {
  private readonly owners = new Set<AudioMuteOwner>();
  private snapshot: AudioSnapshot | null = null;
  private tail: Promise<void> = Promise.resolve();

  prewarm(): Promise<void> {
    return macAudioMuteBackend.prewarm();
  }

  async mute(ownerId: AudioMuteOwner): Promise<void> {
    if (!SUPPORTS_MUTE) return;
    await this.enqueue(async () => {
      if (this.owners.has(ownerId)) return;
      if (this.snapshot === null) {
        this.snapshot = await muteOutputAndReadSnapshot((snapshot) => {
          this.snapshot = snapshot;
        });
        log.info('muted for voice input', { ownerId, wasMuted: this.snapshot.outputMuted });
      } else if (this.owners.size === 0) {
        // A rejected restore may still have reached the OS. Reassert mute for
        // the new owner without replacing the outstanding original snapshot.
        await setOutputMuted(true, this.snapshot);
      }
      this.owners.add(ownerId);
    });
  }

  async restore(ownerId: AudioMuteOwner): Promise<void> {
    if (!SUPPORTS_MUTE) return;
    await this.enqueue(async () => {
      this.owners.delete(ownerId);
      if (this.owners.size > 0) return;

      // A failed OS restore leaves the snapshot pending, even after its owner
      // has ended. A later restore or mute cycle must retain that original state.
      const snapshot = this.snapshot;
      if (!snapshot) return;
      await setOutputMuted(snapshot.outputMuted, snapshot);
      this.snapshot = null;
      log.info('restored after voice input', { ownerId, muted: snapshot.outputMuted });
    });
  }

  async restoreAll(): Promise<void> {
    if (!SUPPORTS_MUTE) return;
    await this.enqueue(async () => {
      this.owners.clear();
      const snapshot = this.snapshot;
      if (!snapshot) return;
      await setOutputMuted(snapshot.outputMuted, snapshot);
      this.snapshot = null;
      log.info('restored all voice input owners', { muted: snapshot.outputMuted });
    });
  }

  private enqueue(job: () => Promise<void>): Promise<void> {
    const next = this.tail.then(job, job);
    this.tail = next.catch((error) => {
      log.warn('system audio mute job failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
    return next;
  }
}

export const systemAudioMuteGuard = new SystemAudioMuteGuard();

async function muteOutputAndReadSnapshot(
  onSnapshot: (snapshot: AudioSnapshot) => void,
): Promise<AudioSnapshot> {
  if (process.platform === 'darwin') {
    let nativeSnapshot: AudioSnapshot | undefined;
    const usedNative = await macAudioMuteBackend.mute((native) => {
      nativeSnapshot = { outputMuted: native.outputMuted, native };
      onSnapshot(nativeSnapshot);
    });
    if (usedNative && nativeSnapshot) return nativeSnapshot;
    const out = await runOsascript([
      'set wasMuted to output muted of (get volume settings)',
      'if wasMuted is false then set volume with output muted',
      'return wasMuted',
    ]);
    return { outputMuted: out.trim() === 'true' };
  }

  const outputMuted = await readOutputMuted();
  if (!outputMuted) {
    await setOutputMuted(true);
  }
  return { outputMuted };
}

async function readOutputMuted(): Promise<boolean> {
  if (process.platform === 'darwin') {
    const out = await runOsascript(['output muted of (get volume settings)']);
    return out.trim() === 'true';
  }
  if (process.platform === 'win32') {
    const l = await loadLoudness();
    if (!l) throw new Error('SYSTEM_AUDIO_UNAVAILABLE');
    return l.getMuted();
  }
  return false;
}

async function setOutputMuted(muted: boolean, snapshot?: AudioSnapshot): Promise<void> {
  if (process.platform === 'darwin') {
    if (snapshot?.native) {
      await macAudioMuteBackend.setMuted(snapshot.native, muted);
      return;
    }
    await runOsascript([
      muted ? 'set volume with output muted' : 'set volume without output muted',
    ]);
    return;
  }
  if (process.platform === 'win32') {
    const l = await loadLoudness();
    if (!l) throw new Error('SYSTEM_AUDIO_UNAVAILABLE');
    await l.setMuted(muted);
    return;
  }
}

function runOsascript(commands: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = commands.flatMap((command) => ['-e', command]);
    const proc = spawn('osascript', args);
    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });
    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });
    proc.on('error', reject);
    proc.on('exit', (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(stderr.trim() || `osascript exited ${code}`));
      }
    });
  });
}
