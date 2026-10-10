/**
 * Acoustic activity gate, not a semantic speech classifier. It commits manual
 * ASR buffers after silence; only provider-finalized nonempty text may be sent.
 * Hysteresis avoids clipping quiet syllables and transient clicks. Capture must
 * enable echo cancellation when this gate runs alongside speaker playback.
 */
export class ConversationActivity {
  private noise = 80;
  private attackMs = 0;
  private silenceMs = 0;
  private active = false;

  push(
    pcm: ArrayBuffer,
    sampleRate = 16_000,
  ): { level: number; started: boolean; ended: boolean; active: boolean } {
    const samples = new Int16Array(pcm);
    let energy = 0;
    for (const sample of samples) energy += sample * sample;
    const rms = Math.sqrt(energy / Math.max(1, samples.length));
    const duration = (samples.length / sampleRate) * 1_000;
    const threshold = Math.max(
      this.active ? 180 : 320,
      this.noise * (this.active ? 2 : 3.5),
    );
    const sound = rms > threshold;
    let started = false;
    let ended = false;
    if (!this.active && !sound)
      this.noise = this.noise * 0.98 + Math.min(rms, 250) * 0.02;
    if (sound) {
      this.attackMs += duration;
      this.silenceMs = 0;
      if (!this.active && this.attackMs >= 180) {
        this.active = true;
        started = true;
      }
    } else {
      this.attackMs = 0;
      this.silenceMs += duration;
      if (this.active && this.silenceMs >= 900) {
        this.active = false;
        ended = true;
      }
    }
    return {
      level: Math.min(1, rms / 5_000),
      started,
      ended,
      active: this.active,
    };
  }
}
