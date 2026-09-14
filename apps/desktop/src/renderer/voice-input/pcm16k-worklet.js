/* global AudioWorkletProcessor, currentTime, performance, registerProcessor, sampleRate */

class PCM16kWorklet extends AudioWorkletProcessor {
  constructor() {
    super();
    this.targetSampleRate = 16000;
    this.chunkSamples = 640;
    this.timeOriginMs = 0;
    this.pending = [];
    this.carry = 0;
    this.previousSample = 0;
    this.chunkIndex = 0;
    this.active = true;

    this.port.onmessage = (event) => {
      if (event.data?.type === 'config') {
        this.targetSampleRate = event.data.targetSampleRate || 16000;
        this.chunkSamples = Math.max(
          160,
          Math.round(this.targetSampleRate * (event.data.chunkMs / 1000)),
        );
        this.timeOriginMs = event.data.timeOriginMs || 0;
        return;
      }
      if (event.data?.type === 'flush') {
        if (this.active && this.pending.length > 0) {
          this.postFrameFromSamples(this.pending.splice(0), this.currentTimeMs());
        }
        this.port.postMessage({
          type: 'flushed',
          flushId: event.data.flushId,
        });
        return;
      }
      if (event.data?.type !== 'setActive') return;
      if (event.data.reset) {
        this.pending = [];
        this.carry = 0;
        this.previousSample = 0;
      }
      this.active = event.data.active;
    };
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input || input.length === 0) return true;
    if (!this.active) return true;

    const capturedAt = this.currentTimeMs();
    const resampled = this.resample(input, sampleRate, this.targetSampleRate);
    for (const sample of resampled) {
      this.pending.push(sample);
    }

    while (this.pending.length >= this.chunkSamples) {
      const frame = this.pending.splice(0, this.chunkSamples);
      this.postFrameFromSamples(frame, capturedAt);
    }

    return true;
  }

  postFrameFromSamples(frame, capturedAt) {
    const pcm = new Int16Array(frame.length);
    for (let i = 0; i < frame.length; i += 1) {
      const clamped = Math.max(-1, Math.min(1, frame[i]));
      pcm[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
    }
    this.postFrame({
      pcm,
      trace: {
        capturedAt,
        convertedAt: this.currentTimeMs(),
        chunkIndex: this.chunkIndex,
        sampleRate: this.targetSampleRate,
        durationMs: (pcm.length / this.targetSampleRate) * 1000,
      },
    });
    this.chunkIndex += 1;
  }

  postFrame(frame) {
    this.port.postMessage(
      {
        type: 'pcm16k',
        pcm16k: frame.pcm.buffer,
        trace: frame.trace,
      },
      [frame.pcm.buffer],
    );
  }

  resample(input, fromRate, toRate) {
    if (input.length === 0) return [];
    if (fromRate === toRate) return Array.from(input);

    const ratio = fromRate / toRate;
    const output = [];
    let sourceIndex = this.carry;

    while (sourceIndex < input.length - 1) {
      const left = Math.floor(sourceIndex);
      const right = Math.min(left + 1, input.length - 1);
      const fraction = sourceIndex - left;
      // carry can be in [-1, 0): this interpolation straddles two input blocks.
      // Keep the previous block's last sample instead of reading input[-1].
      const leftSample = left < 0 ? this.previousSample : input[left];
      output.push(leftSample + (input[right] - leftSample) * fraction);
      sourceIndex += ratio;
    }

    this.carry = sourceIndex - input.length;
    this.previousSample = input[input.length - 1];
    return output;
  }

  currentTimeMs() {
    return this.timeOriginMs + (typeof currentTime === 'number' ? currentTime * 1000 : performance.now());
  }
}

registerProcessor('pcm16k-worklet', PCM16kWorklet);
