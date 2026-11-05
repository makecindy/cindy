/** Bounded PCM scheduling into a media stream; never plays locally. */
export async function nativeAudioStream(
  read: () => Promise<Uint8Array>,
  current: () => boolean,
  onError?: () => void,
): Promise<{ track: MediaStreamTrack; pause(): Promise<void>; resume(): Promise<void>; stop(): void }> {
  const context = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
  const destination = context.createMediaStreamDestination();
  const sources = new Set<AudioBufferSourceNode>();
  let stopped = false;
  let paused = false;
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let next = 0;
  const clearScheduled = () => {
    clearTimeout(timer);
    for (const source of sources) { source.stop(); source.disconnect(); }
    sources.clear();
    next = 0;
  };
  const stop = () => {
    if (stopped) return;
    stopped = true;
    generation++;
    clearScheduled();
    destination.stream.getTracks().forEach((track) => track.stop());
    void context.close().catch(() => {});
  };
  const live = (epoch: number) => !stopped && !paused && generation === epoch;
  const fail = () => { stop(); onError?.(); };
  const poll = async (epoch: number) => {
    if (!live(epoch)) return;
    if (!current()) return stop();
    try {
      const bytes = await read();
      // A stopped capture host can still complete or reject an old IPC read.
      // Neither result belongs to a resumed stream.
      if (!live(epoch)) return;
      if (!current()) return stop();
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
          clearScheduled();
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
      timer = setTimeout(() => void poll(epoch), 20);
    } catch {
      if (live(epoch)) fail();
    }
  };
  try {
    await context.resume();
    await poll(generation);
    if (stopped) throw new Error('DESKTOP_AUDIO_UNAVAILABLE');
    return {
      track: destination.stream.getAudioTracks()[0], stop,
      async pause() {
        if (stopped || paused) return;
        paused = true;
        generation++;
        clearScheduled();
        // Retain the destination track: changing the muxer's track set would
        // terminate MediaRecorder. Suspending stops the graph without ending it.
        try { await context.suspend(); }
        catch { if (!stopped) { fail(); throw new Error('DESKTOP_AUDIO_UNAVAILABLE'); } }
      },
      async resume() {
        if (stopped) throw new Error('DESKTOP_AUDIO_UNAVAILABLE');
        if (!paused) return;
        paused = false;
        const epoch = ++generation;
        try {
          await context.resume();
          await poll(epoch);
          if (!live(epoch)) throw new Error('DESKTOP_AUDIO_UNAVAILABLE');
        } catch {
          if (live(epoch)) fail();
          throw new Error('DESKTOP_AUDIO_UNAVAILABLE');
        }
      },
    };
  } catch {
    stop();
    throw new Error('DESKTOP_AUDIO_UNAVAILABLE');
  }
}
