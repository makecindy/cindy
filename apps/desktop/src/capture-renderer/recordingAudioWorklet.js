// Stereo float32 at the context's 48 kHz. Emit 20 ms at a time, without playback.
class RecordingPcm extends AudioWorkletProcessor {
  buffer = new Float32Array(1920);
  at = 0;
  process(inputs) {
    const channels = inputs[0];
    if (!channels?.length) return true;
    for (let i = 0; i < channels[0].length; i++) {
      this.buffer[this.at++] = channels[0][i];
      this.buffer[this.at++] = (channels[1] ?? channels[0])[i];
      if (this.at === this.buffer.length) {
        this.port.postMessage(this.buffer.buffer, [this.buffer.buffer]);
        this.buffer = new Float32Array(1920);
        this.at = 0;
      }
    }
    return true;
  }
}
registerProcessor('recording-pcm', RecordingPcm);
