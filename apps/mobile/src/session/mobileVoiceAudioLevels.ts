/** Aggregate PCM levels only; never retain audio or use volume as proof of speech. */
export class MobileVoiceAudioLevels {
  private samples = 0;
  private energy = 0;
  private peak = 0;
  private durationMs = 0;

  append(pcm: ArrayBuffer, sampleRate: number): void {
    if (pcm.byteLength % 2 || !Number.isFinite(sampleRate) || sampleRate <= 0) return;
    const view = new DataView(pcm);
    for (let offset = 0; offset < pcm.byteLength; offset += 2) {
      const value = view.getInt16(offset, true);
      this.energy += value * value;
      this.peak = Math.max(this.peak, Math.abs(value));
    }
    this.samples += pcm.byteLength / 2;
    this.durationMs += pcm.byteLength / 2 / sampleRate * 1000;
  }

  summary(): { capturedAudioMs: number; rmsDbfs?: number; peakDbfs?: number } {
    // Undefined means no samples. Digital silence uses a finite -90 dBFS floor.
    const dbfs = (level: number): number => Math.round(20 * Math.log10(Math.max(1, level) / 32768));
    return {
      capturedAudioMs: Math.round(this.durationMs),
      rmsDbfs: this.samples ? dbfs(Math.sqrt(this.energy / this.samples)) : undefined,
      peakDbfs: this.samples ? dbfs(this.peak) : undefined,
    };
  }
}
