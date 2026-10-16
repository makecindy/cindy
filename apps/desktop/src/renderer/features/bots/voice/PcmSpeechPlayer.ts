/** PCM may cross arbitrary HTTP chunk boundaries, including the middle of a 16-bit sample. */
export class Pcm16Decoder {
  private carry: number | undefined;
  decode(buffer: ArrayBuffer): Float32Array<ArrayBuffer> {
    const incoming = new Uint8Array(buffer);
    const bytes = new Uint8Array(incoming.length + (this.carry === undefined ? 0 : 1));
    if (this.carry !== undefined) bytes[0] = this.carry;
    bytes.set(incoming, this.carry === undefined ? 0 : 1);
    this.carry = bytes.length % 2 ? bytes[bytes.length - 1] : undefined;
    const view = new DataView(bytes.buffer);
    const samples = new Float32Array(Math.floor(bytes.length / 2));
    for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true) / 32768;
    return samples;
  }
  finish(): void {
    if (this.carry !== undefined) throw new Error('Incomplete PCM sample');
  }
}

export interface SpeechPlayer {
  play(
    read: () => Promise<{ pcm: ArrayBuffer; done: boolean }>,
    sampleRate: number,
    onStarted?: () => void,
  ): Promise<void>;
  pause(): void;
  resume(): void;
  cancel(): void;
  close(): void;
}

/** A short playback horizon bounds memory and makes an interruption stop immediately. */
export class PcmSpeechPlayer implements SpeechPlayer {
  private readonly context: AudioContext;
  private generation = 0;
  private sources = new Set<AudioBufferSourceNode>();
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private paused = false;
  private contextTransition: Promise<void>;
  private resumeWaiters = new Set<() => void>();

  constructor(private readonly onLevel: (level: number) => void) {
    // Construct/resume in the explicit Start gesture, before any network await.
    this.context = new AudioContext();
    this.contextTransition = this.context.resume();
    void this.contextTransition.catch(() => undefined);
  }

  async play(
    read: () => Promise<{ pcm: ArrayBuffer; done: boolean }>,
    sampleRate: number,
    onStarted?: () => void,
  ): Promise<void> {
    this.cancel();
    const generation = this.generation;
    const decoder = new Pcm16Decoder();
    let nextAt = this.context.currentTime;
    let started = false;
    this.updateContext();
    for (;;) {
      await this.waitUntilRunning(generation);
      const chunk = await read();
      await this.waitUntilRunning(generation);
      const samples = decoder.decode(chunk.pcm);
      for (let offset = 0; offset < samples.length; offset += 2_400) {
        while (nextAt - this.context.currentTime > 0.3) {
          await new Promise((resolve) => setTimeout(resolve, 25));
          await this.waitUntilRunning(generation);
        }
        const part = samples.subarray(offset, offset + 2_400);
        const buffer = this.context.createBuffer(1, part.length, sampleRate);
        buffer.copyToChannel(part, 0);
        const source = this.context.createBufferSource();
        source.buffer = buffer;
        source.connect(this.context.destination);
        this.sources.add(source);
        source.onended = () => {
          this.sources.delete(source);
          source.disconnect();
        };
        nextAt = Math.max(nextAt, this.context.currentTime + 0.015);
        const level = Math.min(
          1,
          Math.sqrt(part.reduce((sum, value) => sum + value * value, 0) / part.length) * 5,
        );
        const timer = setTimeout(
          () => {
            this.timers.delete(timer);
            if (generation === this.generation && !this.paused) this.onLevel(level);
          },
          Math.max(0, nextAt - this.context.currentTime) * 1000,
        );
        this.timers.add(timer);
        source.start(nextAt);
        if (!started) {
          started = true;
          onStarted?.();
        }
        nextAt += part.length / sampleRate;
      }
      if (chunk.done) break;
    }
    decoder.finish();
    while (nextAt > this.context.currentTime) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      await this.waitUntilRunning(generation);
    }
    this.onLevel(0);
  }

  // Suspend the audio clock as well as reads: queued samples resume from their
  // exact position after a false onset, without another paid synthesis request.
  pause(): void {
    if (this.paused) return;
    this.paused = true;
    this.onLevel(0);
    this.updateContext();
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.updateContext();
    this.wakePlayback();
  }

  private updateContext(): void {
    // Serialize native transitions, consulting current intent so a late suspend
    // cannot overtake Resume or reopen a context closed at an account boundary.
    this.contextTransition = this.contextTransition
      .catch(() => undefined)
      .then(async () => {
        if (this.context.state === 'closed') return;
        if (this.paused) await this.context.suspend();
        else await this.context.resume();
      });
    void this.contextTransition.catch(() => undefined);
  }

  private async waitUntilRunning(generation: number): Promise<void> {
    for (;;) {
      if (generation !== this.generation || this.context.state === 'closed')
        throw new Error('Playback interrupted');
      if (this.paused) {
        await new Promise<void>((resolve) => this.resumeWaiters.add(resolve));
        continue;
      }
      await this.contextTransition;
      if (generation !== this.generation) throw new Error('Playback interrupted');
      if (this.paused) continue;
      if (this.context.state !== 'running') throw new Error('Playback interrupted');
      return;
    }
  }

  private wakePlayback(): void {
    for (const resolve of this.resumeWaiters) resolve();
    this.resumeWaiters.clear();
  }

  cancel(): void {
    ++this.generation;
    this.wakePlayback();
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    for (const source of this.sources) {
      source.onended = null;
      try {
        source.stop();
      } catch {
        /* Already ended. */
      }
      source.disconnect();
    }
    this.sources.clear();
    this.onLevel(0);
  }

  close(): void {
    this.cancel();
    void this.context.close().catch(() => undefined);
  }
}
