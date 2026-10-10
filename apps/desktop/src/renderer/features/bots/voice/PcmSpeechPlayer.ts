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
  play(read: () => Promise<{ pcm: ArrayBuffer; done: boolean }>, sampleRate: number): Promise<void>;
  cancel(): void;
  close(): void;
}

/** A short playback horizon bounds memory and makes an interruption stop immediately. */
export class PcmSpeechPlayer implements SpeechPlayer {
  private readonly context: AudioContext;
  private generation = 0;
  private sources = new Set<AudioBufferSourceNode>();
  private timers = new Set<ReturnType<typeof setTimeout>>();

  constructor(private readonly onLevel: (level: number) => void) {
    // Construct/resume in the explicit Start gesture, before any network await.
    this.context = new AudioContext();
    void this.context.resume().catch(() => undefined);
  }

  async play(
    read: () => Promise<{ pcm: ArrayBuffer; done: boolean }>,
    sampleRate: number,
  ): Promise<void> {
    this.cancel();
    const generation = this.generation;
    const decoder = new Pcm16Decoder();
    let nextAt = this.context.currentTime;
    const assertActive = () => {
      if (generation !== this.generation || this.context.state !== 'running')
        throw new Error('Playback interrupted');
    };
    await this.context.resume();
    for (;;) {
      assertActive();
      const chunk = await read();
      assertActive();
      const samples = decoder.decode(chunk.pcm);
      for (let offset = 0; offset < samples.length; offset += 2_400) {
        while (nextAt - this.context.currentTime > 0.3) {
          await new Promise((resolve) => setTimeout(resolve, 25));
          assertActive();
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
            if (generation === this.generation) this.onLevel(level);
          },
          Math.max(0, nextAt - this.context.currentTime) * 1000,
        );
        this.timers.add(timer);
        source.start(nextAt);
        nextAt += part.length / sampleRate;
      }
      if (chunk.done) break;
    }
    decoder.finish();
    while (nextAt > this.context.currentTime) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      assertActive();
    }
    this.onLevel(0);
  }

  cancel(): void {
    ++this.generation;
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
