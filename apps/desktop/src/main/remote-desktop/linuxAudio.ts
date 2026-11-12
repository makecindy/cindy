import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { accessSync, constants } from 'node:fs';

const executable = '/usr/bin/pw-record';
const bytesPerFrame = 8; // Stereo float32, 48 kHz.
const maxBytes = 4800 * bytesPerFrame; // Never retain more than 100 ms.

export function supportsLinuxAudio(): boolean {
  if (process.platform !== 'linux') return false;
  try {
    accessSync(executable, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Ephemeral output-monitor capture owned by the authorized video lease.
 * PipeWire's sink capture policy follows the default output, never the microphone.
 * Bytes remain in memory and stale samples are dropped instead of building latency.
 */
export class LinuxDesktopAudio {
  private child: ChildProcessWithoutNullStreams | null = null;
  private samples: Buffer = Buffer.alloc(0);
  private failed = false;
  private lastRead = 0;
  private lastData = 0;
  private watchdog: ReturnType<typeof setInterval> | undefined;
  constructor(
    private readonly launch = () =>
      spawn(
        executable,
        [
          '--raw',
          '--format',
          'f32',
          '--rate',
          '48000',
          '--channels',
          '2',
          '--latency',
          '20ms',
          '--properties',
          '{ stream.capture.sink=true node.name=cindy-desktop-audio media.role=Screen }',
          '-',
        ],
        { stdio: 'pipe' },
      ),
  ) {}

  start(): void {
    this.stop();
    this.failed = false;
    let child: ChildProcessWithoutNullStreams;
    try {
      child = this.launch();
    } catch {
      // Audio is optional: surface failure through read(), never abort the video offer.
      this.failed = true;
      return;
    }
    this.child = child;
    this.lastRead = Date.now();
    this.lastData = this.lastRead;
    child.stderr.resume(); // Never expose native diagnostics or sampled content.
    child.stdin.on('error', () => {});
    child.stdout.on('data', (chunk: Buffer) => {
      if (this.child !== child) return;
      if (chunk.length) this.lastData = Date.now();
      const joined = Buffer.concat([this.samples, chunk]);
      const discard = Math.max(
        0,
        Math.ceil((joined.length - maxBytes) / bytesPerFrame) * bytesPerFrame,
      );
      this.samples = Buffer.from(joined.subarray(discard));
    });
    const failed = () => {
      if (this.child !== child) return;
      this.stop();
      this.failed = true;
    };
    child.once('error', failed);
    child.once('exit', failed);
    this.watchdog = setInterval(() => {
      if (Date.now() - this.lastRead > 3000 || Date.now() - this.lastData > 5000) failed();
    }, 1000);
    this.watchdog.unref();
  }

  read(): Uint8Array {
    if (!this.child || this.failed) throw new Error('DESKTOP_AUDIO_UNAVAILABLE');
    this.lastRead = Date.now();
    const size = this.samples.length - (this.samples.length % bytesPerFrame);
    const result = Uint8Array.from(this.samples.subarray(0, size));
    this.samples = Buffer.from(this.samples.subarray(size));
    return result;
  }

  stop(): void {
    const child = this.child;
    this.child = null;
    this.samples = Buffer.alloc(0);
    clearInterval(this.watchdog);
    this.watchdog = undefined;
    if (child) {
      child.stdin.destroy();
      child.kill('SIGKILL');
    }
  }
}
