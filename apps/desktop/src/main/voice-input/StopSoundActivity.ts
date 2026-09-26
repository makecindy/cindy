/** Local evidence for stop-time ASR finalization, not a speech classifier.
 * Measure 1 ms RMS buckets across packet boundaries. A 20 ms window must
 * contain 16 ms of quiet sound or 6 ms of stronger sound. Isolated impulses
 * cannot pass just by being loud. Every PCM sample still goes to the ASR.
 */
export class StopSoundActivity {
  static readonly thresholds = {
    weakRms: 32,
    strongRms: 96,
    windowMs: 20,
    weakDurationMs: 16,
    strongDurationMs: 6,
  };
  private samples = 0;
  private bucketSamples = 0;
  private energy = 0;
  private readonly window: number[] = Array(20).fill(0);
  private cursor = 0;
  private weakCount = 0;
  private strongCount = 0;
  private acceptedEndMs = 0;
  private candidateEndMs = 0;
  private readonly samplesPerMs: number;

  constructor(private readonly sampleRate: number) {
    this.samplesPerMs = Math.max(1, Math.round(sampleRate / 1000));
  }

  append(pcm: Buffer): void {
    const t = StopSoundActivity.thresholds;
    for (let offset = 0; offset + 1 < pcm.length; offset += 2) {
      const value = pcm.readInt16LE(offset);
      this.samples++;
      this.bucketSamples++;
      this.energy += value * value;
      if (this.bucketSamples < this.samplesPerMs) continue;
      const meanSquare = this.energy / this.bucketSamples;
      const level = meanSquare >= t.strongRms ** 2 ? 2 : meanSquare >= t.weakRms ** 2 ? 1 : 0;
      const old = this.window[this.cursor];
      this.weakCount += Number(level > 0) - Number(old > 0);
      this.strongCount += Number(level === 2) - Number(old === 2);
      this.window[this.cursor] = level;
      this.cursor = (this.cursor + 1) % this.window.length;
      if (level > 0) {
        this.candidateEndMs = (this.samples * 1000) / this.sampleRate;
        if (this.weakCount >= t.weakDurationMs || this.strongCount >= t.strongDurationMs) {
          this.acceptedEndMs = this.candidateEndMs;
        }
      }
      this.bucketSamples = 0;
      this.energy = 0;
    }
  }

  get lastSoundEndMs(): number {
    const nowMs = (this.samples * 1000) / this.sampleRate;
    // An unfinished burst (including a final partial bucket) is uncertain:
    // protect it on immediate stop. After quiet audio fills the window, a
    // burst that never met either duration threshold no longer blocks stop.
    if (this.energy >= StopSoundActivity.thresholds.weakRms ** 2 * Math.max(1, this.bucketSamples))
      return nowMs;
    if (
      this.candidateEndMs > 0 &&
      nowMs - this.candidateEndMs < StopSoundActivity.thresholds.windowMs
    ) {
      return Math.max(this.acceptedEndMs, this.candidateEndMs);
    }
    return this.acceptedEndMs;
  }

  reset(): void {
    this.samples = this.bucketSamples = this.energy = this.cursor = 0;
    this.weakCount = this.strongCount = this.acceptedEndMs = this.candidateEndMs = 0;
    this.window.fill(0);
  }
}
