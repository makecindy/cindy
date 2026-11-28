// Local PCM16 sound evidence shared by every voice host. Neither check is a
// speech classifier: both keep plausible sound rather than risk quiet words,
// while adapting to steady ambient noise and gating brief start-cue echoes.

// Conservative silence check for "the whole recording was silent" decisions.
// PCM16 RMS 32 is about -60 dBFS; a short peak also keeps a very brief sound.
export function hasPcmSound(pcm: ArrayBuffer): boolean {
  if (pcm.byteLength % 2 !== 0) return true; // Unknown data must not be discarded.
  const samples = new Int16Array(pcm);
  let energy = 0;
  for (const sample of samples) {
    if (Math.abs(sample) >= 128) return true;
    energy += sample * sample;
  }
  return samples.length > 0 && energy >= samples.length * 32 * 32;
}

function measurePcm16Stats(pcm: ArrayBuffer): { rms: number; peak: number; sampleCount: number } | null {
  if (pcm.byteLength % 2 !== 0) return null;
  const sampleCount = pcm.byteLength / 2;
  if (sampleCount === 0) return { rms: 0, peak: 0, sampleCount: 0 };
  const samples = new Int16Array(pcm);
  let sumSquares = 0;
  let peak = 0;
  for (let i = 0; i < sampleCount; i += 1) {
    const s = samples[i];
    const abs = s < 0 ? -s : s;
    if (abs > peak) peak = abs;
    sumSquares += s * s;
  }
  return { rms: Math.sqrt(sumSquares / sampleCount), peak, sampleCount };
}

/**
 * Stateful recording-level sound detector for "was the whole recording silent?"
 * decisions across renderer capture and mobile hosts.
 *
 * - In quiet rooms, preserves the conservative `-60 dBFS` sensitivity of
 *   `hasPcmSound` so quiet single words are never dropped.
 * - In steady ambient noise (fan / AC / cafe hum), calibrates an online noise
 *   floor so pure room noise does not false-trigger "speech detected but no
 *   transcript" errors.
 * - During `startCueEchoWindow`, ignores brief (< 300 ms) speaker-to-mic start
 *   cue echoes while immediately confirming continuous speech (>= 300 ms).
 */
export class RecordingSoundDetector {
  static readonly defaults = {
    quietRmsFloor: 32,
    quietPeakFloor: 128,
    elevatedNoiseFloorRms: 24,
    noiseRmsMultiplier: 2.0,
    noisePeakMultiplier: 6.0,
    noisePeakMinRmsMultiplier: 1.25,
    initialHoldPeakFloor: 1_200,
    initialHoldPeakMultiplier: 6.0,
    maxNoiseFloorRms: 500,
    cueEchoHoldMs: 300,
    stationaryWindowChunks: 6,
    stationaryRatioCap: 1.75,
  };

  private confirmed = false;
  private noiseFloorRms = 0;
  private hasNoiseFloor = false;
  private cueWindowActiveMs = 0;
  private elevatedPeakStreak = 0;
  private recentChunkRms: number[] = [];
  private pendingFirstChunk = false;
  private pendingFirstRms = 0;
  private pendingFirstPeak = 0;

  append(
    pcm: ArrayBuffer,
    options: { durationMs?: number; sampleRate?: number; startCueEchoWindow?: boolean } = {},
  ): boolean {
    if (this.confirmed) return true;
    const stats = measurePcm16Stats(pcm);
    if (!stats) {
      // Malformed PCM must never be discarded as silence.
      this.confirmed = true;
      return true;
    }
    if (stats.sampleCount === 0) return false;

    const d = RecordingSoundDetector.defaults;
    const sampleRate = options.sampleRate ?? 16_000;
    const durationMs = options.durationMs ?? (stats.sampleCount * 1000) / Math.max(1, sampleRate);
    const inCueWindow = options.startCueEchoWindow === true;

    // Update online noise floor only outside the start-cue echo window so a loud
    // beep never inflates the ambient baseline.
    let stationaryWindowConfirmed = false;
    if (!inCueWindow) {
      stationaryWindowConfirmed = this.updateNoiseFloor(stats.rms);
    }

    const activeFloor = this.hasNoiseFloor ? this.noiseFloorRms : 0;
    const isElevatedNoise = this.hasNoiseFloor && activeFloor >= d.elevatedNoiseFloorRms;
    const rmsThreshold = isElevatedNoise
      ? Math.max(d.quietRmsFloor, activeFloor * d.noiseRmsMultiplier)
      : d.quietRmsFloor;
    const peakThreshold = isElevatedNoise
      ? Math.max(d.quietPeakFloor, activeFloor * d.noisePeakMultiplier)
      : d.quietPeakFloor;

    let chunkAboveFloor: boolean;
    if (isElevatedNoise) {
      // Broadband Gaussian room noise (AC/fan/cafe) naturally produces 3.6σ–4.8σ
      // single-sample peaks in 40 ms chunks while chunk RMS remains flat near
      // 1.0× floor. Require either a clear RMS rise or a strong peak (>= 6× floor)
      // backed by modest RMS elevation or two consecutive chunks.
      const rmsAbove = stats.rms >= rmsThreshold;
      const peakAbove = stats.peak >= peakThreshold;
      this.elevatedPeakStreak = peakAbove ? this.elevatedPeakStreak + 1 : 0;
      const peakTriggered = peakAbove
        && (stats.rms >= activeFloor * d.noisePeakMinRmsMultiplier || this.elevatedPeakStreak >= 2);
      chunkAboveFloor = rmsAbove || peakTriggered;
    } else {
      this.elevatedPeakStreak = 0;
      chunkAboveFloor = stats.rms >= rmsThreshold || stats.peak >= peakThreshold;
    }

    if (inCueWindow) {
      if (chunkAboveFloor) {
        this.cueWindowActiveMs += durationMs;
        if (this.cueWindowActiveMs >= d.cueEchoHoldMs) {
          this.confirmed = true;
        }
      } else {
        this.cueWindowActiveMs = 0;
      }
      return this.confirmed;
    }

    this.cueWindowActiveMs = 0;

    // Very quiet room (confirmed floor < 24): immediately confirm on any speech-like sound.
    if (this.hasNoiseFloor && !isElevatedNoise) {
      if (chunkAboveFloor) {
        this.confirmed = true;
      } else if (
        this.pendingFirstChunk
        && (this.pendingFirstRms >= d.quietRmsFloor || this.pendingFirstPeak >= d.quietPeakFloor)
      ) {
        this.confirmed = true;
      }
      return this.confirmed;
    }

    // Elevated background (e.g. steady cafe/AC at RMS 80-350): wait until a
    // chunk rises meaningfully above the estimated floor, OR exceeds the max
    // ambient noise ceiling (RMS > maxNoiseFloorRms).
    if (stats.rms > d.maxNoiseFloorRms || chunkAboveFloor) {
      // Guard chunks <= maxNoiseFloorRms before stationarity is established:
      // steady broadband noise from t=0 has not yet established a floor, and
      // RMS 250–450 Gaussian noise naturally produces 4σ peaks > 1200 in its
      // opening frames. Hold moderate chunks until either a louder jump occurs
      // or a quieter floor later reveals it really was speech.
      const initialPeakLimit = Math.max(
        d.initialHoldPeakFloor,
        stats.rms * d.initialHoldPeakMultiplier,
      );
      if (!this.hasNoiseFloor && stats.rms <= d.maxNoiseFloorRms && stats.peak < initialPeakLimit) {
        this.pendingFirstChunk = true;
        this.pendingFirstRms = Math.max(this.pendingFirstRms, stats.rms);
        this.pendingFirstPeak = Math.max(this.pendingFirstPeak, stats.peak);
        return false;
      }
      this.confirmed = true;
      return true;
    }

    // If an earlier moderate chunk was held and ambient RMS later dropped much
    // lower, that earlier chunk really was quiet speech.
    if (this.pendingFirstChunk) {
      const pendingTriggered = isElevatedNoise
        ? this.pendingFirstRms >= rmsThreshold
          || (this.pendingFirstPeak >= peakThreshold && this.pendingFirstRms >= activeFloor * d.noisePeakMinRmsMultiplier)
        : this.pendingFirstRms >= d.quietRmsFloor || this.pendingFirstPeak >= d.quietPeakFloor;
      if (pendingTriggered) {
        this.confirmed = true;
        return true;
      }
      if (stationaryWindowConfirmed) {
        this.pendingFirstChunk = false;
        this.pendingFirstRms = 0;
        this.pendingFirstPeak = 0;
      }
    }
    return this.confirmed;
  }

  get hasSound(): boolean {
    if (this.confirmed) return true;
    // Short recording (or non-stationary opening burst) where a moderate sound
    // arrived before the noise-floor estimator confirmed a stationary ambient floor.
    if (
      this.pendingFirstChunk
      && (!this.hasNoiseFloor || this.recentChunkRms.length < RecordingSoundDetector.defaults.stationaryWindowChunks)
    ) {
      return this.pendingFirstRms >= RecordingSoundDetector.defaults.quietRmsFloor
        || this.pendingFirstPeak >= RecordingSoundDetector.defaults.quietPeakFloor;
    }
    return false;
  }

  get estimatedNoiseFloorRms(): number {
    return this.noiseFloorRms;
  }

  reset(): void {
    this.confirmed = false;
    this.noiseFloorRms = 0;
    this.hasNoiseFloor = false;
    this.cueWindowActiveMs = 0;
    this.elevatedPeakStreak = 0;
    this.recentChunkRms = [];
    this.pendingFirstChunk = false;
    this.pendingFirstRms = 0;
    this.pendingFirstPeak = 0;
  }

  private updateNoiseFloor(chunkRms: number): boolean {
    const d = RecordingSoundDetector.defaults;
    this.recentChunkRms.push(chunkRms);
    if (this.recentChunkRms.length > d.stationaryWindowChunks) {
      this.recentChunkRms.shift();
    }

    if (chunkRms < d.elevatedNoiseFloorRms) {
      this.noiseFloorRms = this.hasNoiseFloor ? this.noiseFloorRms * 0.5 + chunkRms * 0.5 : chunkRms;
      this.hasNoiseFloor = true;
      return false;
    }

    if (!this.hasNoiseFloor) {
      if (this.recentChunkRms.length >= 3) {
        let min = Infinity;
        let max = 0;
        let sum = 0;
        for (const v of this.recentChunkRms) {
          if (v < min) min = v;
          if (v > max) max = v;
          sum += v;
        }
        if (min > 0 && max <= min * d.stationaryRatioCap && min <= d.maxNoiseFloorRms) {
          this.noiseFloorRms = Math.min(d.maxNoiseFloorRms, sum / this.recentChunkRms.length);
          this.hasNoiseFloor = true;
          return this.recentChunkRms.length >= d.stationaryWindowChunks;
        }
      }
      return false;
    }

    let stationaryFullWindow = false;
    if (this.recentChunkRms.length >= d.stationaryWindowChunks) {
      let min = Infinity;
      let max = 0;
      for (const v of this.recentChunkRms) {
        if (v < min) min = v;
        if (v > max) max = v;
      }
      if (min > 0 && max <= min * d.stationaryRatioCap && min <= d.maxNoiseFloorRms) {
        stationaryFullWindow = true;
        if (chunkRms >= this.noiseFloorRms) {
          this.noiseFloorRms = Math.min(d.maxNoiseFloorRms, this.noiseFloorRms * 0.9 + min * 0.1);
        }
      }
    }

    if (chunkRms < this.noiseFloorRms) {
      // Fast downward tracking when room gets quieter.
      this.noiseFloorRms = this.noiseFloorRms * 0.7 + chunkRms * 0.3;
    }
    return stationaryFullWindow;
  }
}

/**
 * Adaptive voiced-activity detector used by VoiceInputController for:
 * - speechActivitySeen (empty_transcript vs no_speech)
 * - pause-refinement / session-rotation quiet pause timing
 * - ASR stall watchdog voiced-audio accounting
 *
 * Adapts to steady ambient noise (raising the threshold above steady cafe/fan
 * hum so pause refinement and stall detection still work), lowers gently in
 * confirmed quiet rooms for soft speakers, and gates brief (< 300 ms) start-cue
 * echoes without ever dropping audio forwarded to ASR.
 */
export class AdaptiveVoicedDetector {
  static readonly defaults = {
    initialThresholdRms: 300,
    quietFloorThresholdRms: 180,
    noiseMultiplier: 2.2,
    maxNoiseFloorRms: 800,
    maxThresholdRms: 1_800,
    quietConfirmMs: 200,
    stationaryWindowChunks: 5,
    stationaryRatioCap: 1.65,
    cueEchoHoldMs: 300,
  };

  private noiseFloorRms = 0;
  private hasNoiseFloor = false;
  private quietFloorMs = 0;
  private cueWindowVoicedMs = 0;
  private recentChunkRms: number[] = [];

  observe(
    chunk: ArrayBuffer,
    options: { durationMs?: number; sampleRate?: number; startCueEchoWindow?: boolean } = {},
  ): { voiced: boolean; rms: number; thresholdRms: number } {
    const stats = measurePcm16Stats(chunk);
    if (!stats || stats.sampleCount === 0) {
      return { voiced: false, rms: 0, thresholdRms: this.currentThresholdRms() };
    }
    const d = AdaptiveVoicedDetector.defaults;
    const sampleRate = options.sampleRate ?? 16_000;
    const durationMs = options.durationMs ?? (stats.sampleCount * 1000) / Math.max(1, sampleRate);
    const inCueWindow = options.startCueEchoWindow === true;

    if (!inCueWindow) {
      this.updateNoiseFloor(stats.rms, durationMs);
    }

    const thresholdRms = this.currentThresholdRms();
    const aboveThreshold = stats.rms >= thresholdRms;

    if (inCueWindow) {
      if (aboveThreshold) {
        this.cueWindowVoicedMs += durationMs;
        return {
          voiced: this.cueWindowVoicedMs >= d.cueEchoHoldMs,
          rms: stats.rms,
          thresholdRms,
        };
      }
      this.cueWindowVoicedMs = 0;
      return { voiced: false, rms: stats.rms, thresholdRms };
    }

    this.cueWindowVoicedMs = 0;
    return { voiced: aboveThreshold, rms: stats.rms, thresholdRms };
  }

  currentThresholdRms(): number {
    const d = AdaptiveVoicedDetector.defaults;
    if (!this.hasNoiseFloor) return d.initialThresholdRms;
    if (this.noiseFloorRms < 30 && this.quietFloorMs >= d.quietConfirmMs) {
      return Math.max(d.quietFloorThresholdRms, this.noiseFloorRms * 2.5);
    }
    return Math.min(
      d.maxThresholdRms,
      Math.max(d.initialThresholdRms, this.noiseFloorRms * d.noiseMultiplier),
    );
  }

  get estimatedNoiseFloorRms(): number {
    return this.noiseFloorRms;
  }

  reset(): void {
    this.noiseFloorRms = 0;
    this.hasNoiseFloor = false;
    this.quietFloorMs = 0;
    this.cueWindowVoicedMs = 0;
    this.recentChunkRms = [];
  }

  private updateNoiseFloor(chunkRms: number, durationMs: number): void {
    const d = AdaptiveVoicedDetector.defaults;
    this.recentChunkRms.push(chunkRms);
    if (this.recentChunkRms.length > d.stationaryWindowChunks) {
      this.recentChunkRms.shift();
    }

    if (chunkRms < 30) {
      this.quietFloorMs += durationMs;
      this.noiseFloorRms = this.hasNoiseFloor ? this.noiseFloorRms * 0.6 + chunkRms * 0.4 : chunkRms;
      this.hasNoiseFloor = true;
      return;
    }

    if (!this.hasNoiseFloor) {
      if (this.recentChunkRms.length >= 4) {
        let min = Infinity;
        let max = 0;
        let sum = 0;
        for (const v of this.recentChunkRms) {
          if (v < min) min = v;
          if (v > max) max = v;
          sum += v;
        }
        if (min > 0 && max <= min * d.stationaryRatioCap && min <= d.maxNoiseFloorRms) {
          this.noiseFloorRms = Math.min(d.maxNoiseFloorRms, sum / this.recentChunkRms.length);
          this.hasNoiseFloor = true;
        }
      }
      return;
    }

    if (chunkRms < this.noiseFloorRms) {
      this.noiseFloorRms = this.noiseFloorRms * 0.75 + chunkRms * 0.25;
      return;
    }

    // Only adapt upward when a full window is genuinely stationary (e.g. ambient
    // fan turns on or room noise level shifts), never during speech bursts.
    if (this.recentChunkRms.length >= d.stationaryWindowChunks) {
      let min = Infinity;
      let max = 0;
      for (const v of this.recentChunkRms) {
        if (v < min) min = v;
        if (v > max) max = v;
      }
      if (
        min > 0
        && max <= min * d.stationaryRatioCap
        && min <= d.maxNoiseFloorRms
        && (this.quietFloorMs === 0 || min <= this.noiseFloorRms * 3)
      ) {
        this.noiseFloorRms = Math.min(d.maxNoiseFloorRms, this.noiseFloorRms * 0.9 + min * 0.1);
      }
    }
  }
}

/** Local evidence for stop-time ASR finalization, not a speech classifier.
 * Measure 1 ms RMS buckets across packet boundaries. A 20 ms window must
 * contain 16 ms of quiet sound or 6 ms of stronger sound. Isolated impulses
 * cannot pass just by being loud. Adapts its floor to steady ambient room noise
 * while keeping full quiet-room sensitivity. Every PCM sample still goes to the ASR.
 */
export class StopSoundActivity {
  static readonly thresholds = {
    weakRms: 32,
    strongRms: 96,
    windowMs: 20,
    weakDurationMs: 16,
    strongDurationMs: 6,
    noiseWeakMultiplier: 1.8,
    noiseStrongMultiplier: 2.8,
    maxNoiseFloorRms: 600,
    stationaryFrames: 10,
    stationaryRatioCap: 1.6,
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

  // Online stationary noise-floor tracker (20 ms frame granularity).
  private frameMs = 0;
  private frameMeanSquareSum = 0;
  private readonly recentFrameRms: number[] = [];
  private noiseFloorRms = 0;
  private sawQuietFrame = false;
  private elevatedStationaryFrames = 0;

  constructor(private readonly sampleRate: number) {
    this.samplesPerMs = Math.max(1, Math.round(sampleRate / 1000));
  }

  /** Little-endian PCM16 on the clock the ASR receives. */
  append(pcm: Uint8Array): void {
    const t = StopSoundActivity.thresholds;
    const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    for (let offset = 0; offset + 1 < pcm.byteLength; offset += 2) {
      const value = view.getInt16(offset, true);
      this.samples++;
      this.bucketSamples++;
      this.energy += value * value;
      if (this.bucketSamples < this.samplesPerMs) continue;
      const meanSquare = this.energy / this.bucketSamples;
      this.frameMs += 1;
      this.frameMeanSquareSum += meanSquare;
      if (this.frameMs >= t.windowMs) {
        const frameRms = Math.sqrt(this.frameMeanSquareSum / this.frameMs);
        this.updateNoiseFloor(frameRms);
        this.frameMs = 0;
        this.frameMeanSquareSum = 0;
      }

      const weakRms = this.effectiveWeakRms();
      const strongRms = this.effectiveStrongRms();
      const level = meanSquare >= strongRms * strongRms ? 2 : meanSquare >= weakRms * weakRms ? 1 : 0;
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
    const weakRms = this.effectiveWeakRms();
    // An unfinished burst (including a final partial bucket) is uncertain:
    // protect it on immediate stop. After quiet audio fills the window, a
    // burst that never met either duration threshold no longer blocks stop.
    if (this.energy >= weakRms * weakRms * Math.max(1, this.bucketSamples))
      return nowMs;
    if (
      this.candidateEndMs > 0 &&
      nowMs - this.candidateEndMs < StopSoundActivity.thresholds.windowMs
    ) {
      return Math.max(this.acceptedEndMs, this.candidateEndMs);
    }
    return this.acceptedEndMs;
  }

  get estimatedNoiseFloorRms(): number {
    return this.noiseFloorRms;
  }

  reset(): void {
    this.samples = this.bucketSamples = this.energy = this.cursor = 0;
    this.weakCount = this.strongCount = this.acceptedEndMs = this.candidateEndMs = 0;
    this.window.fill(0);
    this.frameMs = 0;
    this.frameMeanSquareSum = 0;
    this.recentFrameRms.length = 0;
    this.noiseFloorRms = 0;
    this.sawQuietFrame = false;
    this.elevatedStationaryFrames = 0;
  }

  private effectiveWeakRms(): number {
    const t = StopSoundActivity.thresholds;
    return Math.max(t.weakRms, this.noiseFloorRms * t.noiseWeakMultiplier);
  }

  private effectiveStrongRms(): number {
    const t = StopSoundActivity.thresholds;
    return Math.max(t.strongRms, this.noiseFloorRms * t.noiseStrongMultiplier);
  }

  private updateNoiseFloor(frameRms: number): void {
    const t = StopSoundActivity.thresholds;
    this.recentFrameRms.push(frameRms);
    if (this.recentFrameRms.length > t.stationaryFrames) {
      this.recentFrameRms.shift();
    }

    if (frameRms < 20) {
      this.sawQuietFrame = true;
      this.elevatedStationaryFrames = 0;
      if (this.noiseFloorRms > 0) {
        this.noiseFloorRms = this.noiseFloorRms * 0.7 + frameRms * 0.3;
        if (this.noiseFloorRms < 20) this.noiseFloorRms = 0;
      }
      return;
    }

    if (this.recentFrameRms.length < t.stationaryFrames) return;

    let min = Infinity;
    let max = 0;
    let sum = 0;
    for (const v of this.recentFrameRms) {
      if (v < min) min = v;
      if (v > max) max = v;
      sum += v;
    }
    const isStationary = min >= 20 && max <= min * t.stationaryRatioCap && min <= t.maxNoiseFloorRms;
    if (!isStationary) {
      this.elevatedStationaryFrames = 0;
      return;
    }

    const avg = Math.min(t.maxNoiseFloorRms, sum / this.recentFrameRms.length);
    if (this.noiseFloorRms === 0) {
      if (!this.sawQuietFrame) {
        // Recording began directly inside steady ambient noise: calibrate quickly.
        this.noiseFloorRms = avg;
      } else {
        // Recording already observed a quiet baseline; require sustained
        // stationarity (~1.5 s) before raising the floor so continuous speech
        // or synthetic tones never erase themselves.
        this.elevatedStationaryFrames += 1;
        if (this.elevatedStationaryFrames >= 75) {
          this.noiseFloorRms = avg;
        }
      }
      return;
    }

    if (avg < this.noiseFloorRms) {
      this.noiseFloorRms = this.noiseFloorRms * 0.75 + avg * 0.25;
      this.elevatedStationaryFrames = 0;
    } else if (!this.sawQuietFrame) {
      this.noiseFloorRms = Math.min(t.maxNoiseFloorRms, this.noiseFloorRms * 0.92 + avg * 0.08);
    } else {
      this.elevatedStationaryFrames += 1;
      if (this.elevatedStationaryFrames >= 75) {
        this.noiseFloorRms = Math.min(t.maxNoiseFloorRms, this.noiseFloorRms * 0.92 + avg * 0.08);
      }
    }
  }
}
