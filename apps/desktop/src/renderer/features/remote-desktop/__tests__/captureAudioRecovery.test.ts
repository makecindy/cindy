// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { DESKTOP_AUDIO_RETRY_MS } from '../../../../shared/remoteDesktop';
import { startDesktopCaptureHost } from '../captureHost';
import { nativeCaptureStream } from '../nativeCaptureStream';

vi.mock('../nativeCaptureStream', () => ({ nativeCaptureStream: vi.fn() }));
const disposers: Array<() => void> = [];
afterEach(() => {
  disposers.splice(0).forEach((dispose) => dispose());
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
const flush = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};
function media(audio = true) {
  const video = { kind: 'video', stop: vi.fn() };
  const sound = { kind: 'audio', stop: vi.fn() };
  const tracks = audio ? [video, sound] : [video];
  return {
    video,
    sound,
    getTracks: () => tracks,
    getVideoTracks: () => tracks.filter((track) => track.kind === 'video'),
    getAudioTracks: () => tracks.filter((track) => track.kind === 'audio'),
    addTrack: (track: typeof sound) => tracks.push(track),
  };
}
function setup() {
  vi.useFakeTimers();
  const video = media(false);
  const nativeStop = vi.fn();
  vi.mocked(nativeCaptureStream).mockResolvedValue({
    stream: video,
    stop: nativeStop,
    clear: vi.fn(),
  } as any);
  const capture = vi.fn().mockRejectedValue(new Error('NotAllowedError'));
  vi.stubGlobal('navigator', { mediaDevices: { getDisplayMedia: capture } });
  const peers: Peer[] = [];
  class Peer {
    remoteReady = false;
    localDescription = { sdp: 'answer' };
    iceGatheringState = 'complete';
    close = vi.fn();
    addTrack = vi.fn();
    audio = {
      direction: 'recvonly',
      receiver: { track: { kind: 'audio' } },
      sender: { setStreams: vi.fn(), replaceTrack: vi.fn(async (_track: unknown) => {}) },
    };
    constructor() {
      peers.push(this);
    }
    getSenders() {
      return [];
    }
    getTransceivers() {
      expect(this.remoteReady).toBe(true);
      return [this.audio];
    }
    async setRemoteDescription() {
      this.remoteReady = true;
    }
    async setLocalDescription() {}
    async createAnswer() {
      return {};
    }
  }
  vi.stubGlobal('RTCPeerConnection', Peer);
  let command!: (value: any) => void;
  const reply = vi.fn(async () => {});
  const api = {
    onCommand: (callback: typeof command) => {
      command = callback;
      return () => {};
    },
    registerHost: vi.fn(async () => {}),
    reply,
  };
  disposers.push(startDesktopCaptureHost(api as any));
  const offer = (audio = true, overlay = true) =>
    command({
      id: 'offer',
      op: 'offer',
      lease: 'lease',
      sdp: 'offer',
      attemptId: 'attempt',
      sourceId: 'screen:1',
      nativeCapture: true,
      cursorOverlay: overlay,
      settings: { audio, fps: 30 },
    });
  return { video, nativeStop, peers, capture, reply, offer, stop: () => command({ op: 'stop' }) };
}

it.each(['rejected', 'missing', 'without-overlay'])(
  'keeps video after %s audio and restores only its audio sender when permission becomes ready',
  async (mode) => {
    const h = setup();
    const empty = media(false);
    if (mode === 'missing') h.capture.mockResolvedValueOnce(empty);
    h.offer(true, mode !== 'without-overlay');
    await flush();
    const peer = h.peers[0];
    expect(h.reply).toHaveBeenCalledWith('offer', 'answer');
    expect(peer.audio.direction).toBe('sendonly');
    expect(peer.audio.sender.setStreams).toHaveBeenCalledWith(h.video);
    expect(h.video.video.stop).not.toHaveBeenCalled();
    const recovered = media();
    h.capture.mockResolvedValueOnce(recovered);
    await vi.advanceTimersByTimeAsync(DESKTOP_AUDIO_RETRY_MS[0]);
    expect(peer.audio.sender.replaceTrack).toHaveBeenCalledWith(recovered.sound);
    expect(h.peers).toHaveLength(1);
    expect(peer.close).not.toHaveBeenCalled();
    expect(recovered.video.stop).toHaveBeenCalledOnce();
    expect(recovered.sound.stop).not.toHaveBeenCalled();
    expect(h.video.getAudioTracks()).toEqual([recovered.sound]);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.capture).toHaveBeenCalledTimes(2);
    h.stop();
    expect(recovered.sound.stop).toHaveBeenCalledOnce();
  },
);

it('exhausts audio retries without closing video or restarting capture', async () => {
  const h = setup();
  h.offer();
  await flush();
  await vi.advanceTimersByTimeAsync(120_000);
  expect(h.capture).toHaveBeenCalledTimes(1 + DESKTOP_AUDIO_RETRY_MS.length);
  expect(h.peers).toHaveLength(1);
  expect(h.peers[0].close).not.toHaveBeenCalled();
  expect(h.video.video.stop).not.toHaveBeenCalled();
  expect(h.nativeStop).not.toHaveBeenCalled();
});

it('waits for a timed-out permission request to settle before retrying and stops its late tracks', async () => {
  const h = setup();
  let finish!: (value: unknown) => void;
  h.capture.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  h.offer();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(h.reply).toHaveBeenCalledWith('offer', 'answer');
  expect(h.capture).toHaveBeenCalledTimes(1);
  const late = media();
  finish(late);
  await flush();
  late.getTracks().forEach((track) => expect(track.stop).toHaveBeenCalledOnce());
  const recovered = media();
  h.capture.mockResolvedValueOnce(recovered);
  await vi.advanceTimersByTimeAsync(DESKTOP_AUDIO_RETRY_MS[0]);
  expect(h.peers[0].audio.sender.replaceTrack).toHaveBeenCalledWith(recovered.sound);
});

it.each(['capture', 'replaceTrack'] as const)(
  'fences late %s success after audio is disabled by a new offer',
  async (phase) => {
    const h = setup();
    h.offer();
    await flush();
    let finish!: (value?: any) => void;
    const recovered = media();
    if (phase === 'capture')
      h.capture.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
    else {
      h.capture.mockResolvedValueOnce(recovered);
      h.peers[0].audio.sender.replaceTrack.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
    }
    await vi.advanceTimersByTimeAsync(DESKTOP_AUDIO_RETRY_MS[0]);
    h.offer(false);
    await flush();
    finish(phase === 'capture' ? recovered : undefined);
    await flush();
    recovered.getTracks().forEach((track) => expect(track.stop).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.capture).toHaveBeenCalledTimes(2);
    expect(h.peers[1].audio.sender.replaceTrack).not.toHaveBeenCalled();
    expect(h.peers[1].close).not.toHaveBeenCalled();
  },
);

it('cancels scheduled recovery on stop and never attempts audio for an audio-off offer', async () => {
  const h = setup();
  h.offer();
  await flush();
  h.stop();
  await vi.advanceTimersByTimeAsync(120_000);
  expect(h.capture).toHaveBeenCalledTimes(1);
  h.offer(false);
  await flush();
  await vi.advanceTimersByTimeAsync(120_000);
  expect(h.capture).toHaveBeenCalledTimes(1);
  expect(h.peers[1].audio.sender.setStreams).not.toHaveBeenCalled();
});

it('keeps retrying locally after replaceTrack rejects without dropping the video peer', async () => {
  const h = setup();
  h.offer();
  await flush();
  const failed = media();
  h.capture.mockResolvedValueOnce(failed);
  h.peers[0].audio.sender.replaceTrack.mockRejectedValueOnce(new Error('InvalidStateError'));
  await vi.advanceTimersByTimeAsync(DESKTOP_AUDIO_RETRY_MS[0]);
  failed.getTracks().forEach((track) => expect(track.stop).toHaveBeenCalledOnce());
  const recovered = media();
  h.capture.mockResolvedValueOnce(recovered);
  await vi.advanceTimersByTimeAsync(DESKTOP_AUDIO_RETRY_MS[1]);
  expect(h.peers[0].audio.sender.replaceTrack).toHaveBeenLastCalledWith(recovered.sound);
  expect(h.peers[0].close).not.toHaveBeenCalled();
});
