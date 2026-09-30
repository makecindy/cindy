/** Bounded PCM scheduling into the existing WebRTC stream; never plays locally. */
export async function nativeAudioStream(
  read: () => Promise<Uint8Array>,
  current: () => boolean,
): Promise<{ track: MediaStreamTrack; stop(): void }> {
  const context = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
  const destination = context.createMediaStreamDestination();
  const sources = new Set<AudioBufferSourceNode>();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let next = 0;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    for (const source of sources) source.stop();
    sources.clear();
    destination.stream.getTracks().forEach((track) => track.stop());
    void context.close().catch(() => {});
  };
  const poll = async () => {
    if (stopped || !current()) return stop();
    try {
      const bytes = await read();
      if (stopped || !current()) return stop();
      if (!(bytes instanceof Uint8Array) || bytes.byteLength > 38400 || bytes.byteLength % 8)
        throw new Error('DESKTOP_AUDIO_UNAVAILABLE');
      if (bytes.length) {
        const frames = bytes.length / 8;
        const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const buffer = context.createBuffer(2, frames, 48000);
        for (let channel = 0; channel < 2; channel++) {
          const output = buffer.getChannelData(channel);
          for (let i = 0; i < frames; i++) {
            const value = data.getFloat32(i * 8 + channel * 4, true);
            output[i] = Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0;
          }
        }
        // Discard queued history after a renderer stall; preserve only live audio.
        if (next > context.currentTime + 0.15) {
          for (const source of sources) source.stop();
          sources.clear();
          next = 0;
        }
        next = Math.max(context.currentTime + 0.02, next);
        const source = context.createBufferSource();
        source.buffer = buffer;
        source.connect(destination);
        source.onended = () => {
          sources.delete(source);
          source.disconnect();
        };
        sources.add(source);
        source.start(next);
        next += frames / 48000;
      }
      timer = setTimeout(() => void poll(), 20);
    } catch {
      stop();
    }
  };
  try {
    await context.resume();
    await poll();
    if (stopped) throw new Error('DESKTOP_AUDIO_UNAVAILABLE');
    return { track: destination.stream.getAudioTracks()[0], stop };
  } catch {
    stop();
    throw new Error('DESKTOP_AUDIO_UNAVAILABLE');
  }
}
