import workletUrl from './recordingAudioWorklet.js?worker&url';
import type { RecordingAudioApi, RecordingAudioError } from '../shared/recordingAudio';

/** No application content, network or files. Main destroys this process on stop. */
export function startRecordingAudioHost(api: RecordingAudioApi): () => void {
  const streams: MediaStream[] = [];
  let context: AudioContext | null = null;
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    streams.forEach(stream => stream.getTracks().forEach(track => track.stop()));
    void context?.close().catch(() => {});
  };
  let failure: RecordingAudioError = 'audioFailed';
  void (async () => {
    const options = await api.register();
    const acquire = async (request: Promise<MediaStream>) => {
      const stream = await request;
      streams.push(stream);
      if (stopped) { stream.getTracks().forEach(track => track.stop()); throw new Error('Stopped'); }
      const tracks = stream.getAudioTracks();
      // macOS can return an already-ended track when system audio is denied.
      if (!tracks.length || tracks.some(track => track.readyState !== 'live')) throw new Error('Audio unavailable');
      for (const track of tracks) track.onended = () => { if (!stopped) { api.state('audioFailed'); stop(); } };
      stream.getVideoTracks().forEach(track => { track.stop(); stream.removeTrack(track); });
    };
    if (options.system) {
      failure = 'systemAudioFailed';
      await acquire(navigator.mediaDevices.getDisplayMedia({ video: true, audio: true }));
    }
    if (options.microphone) {
      failure = 'microphoneFailed';
      await acquire(navigator.mediaDevices.getUserMedia({ video: false, audio: { echoCancellation: true, noiseSuppression: true } }));
    }
    failure = 'audioFailed';
    if (stopped) return;
    context = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
    await context.audioWorklet.addModule(workletUrl);
    if (stopped) return;
    const pcm = new AudioWorkletNode(context, 'recording-pcm', { channelCount: 2, channelCountMode: 'explicit' });
    pcm.port.onmessage = ({ data }: MessageEvent<ArrayBuffer>) => { if (!stopped) api.data(new Uint8Array(data)); };
    pcm.onprocessorerror = () => { if (!stopped) { api.state('audioFailed'); stop(); } };
    // The worklet's output stays zero. Connecting it keeps the audio graph running
    // without monitoring the microphone or feeding loopback audio into itself.
    pcm.connect(context.destination);
    const limiter = context.createDynamicsCompressor();
    // Preserve ordinary source volume; only limit peaks when both sources sum.
    limiter.threshold.value = -1;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.connect(pcm);
    for (const stream of streams) context.createMediaStreamSource(stream).connect(limiter);
    await context.resume();
    if (!stopped) api.state();
  })().catch(() => { if (!stopped) { api.state(failure); stop(); } });
  return stop;
}
