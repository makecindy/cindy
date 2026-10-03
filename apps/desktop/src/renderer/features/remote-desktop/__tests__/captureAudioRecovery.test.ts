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
    removeTrack: (track: typeof sound) => tracks.splice(tracks.indexOf(track), 1),
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
    addTrack = vi.fn((track: any) => {
      if (track.kind === 'audio') this.audio.sender.track = track;
    });
    audio = {
      direction: 'recvonly',
      receiver: { track: { kind: 'audio' } },
      sender: {
        track: undefined as any,
        setStreams: vi.fn(),
        replaceTrack: vi.fn(async (_track: unknown) => {}),
      },
    };
    video = {
      track: { kind: 'video' },
      getParameters: () => ({ encodings: [{}] }),
      setParameters: vi.fn(async (_parameters: unknown) => {}),
    };
    constructor() {
      peers.push(this);
    }
    getSenders() {
      return this.audio.sender.track ? [this.video, this.audio.sender] : [this.video];
    }
    getTransceivers() {
      expect(this.remoteReady).toBe(true);
      return [this.audio];
    }
    remote: { sdp?: string } | undefined;
    async setRemoteDescription(description?: { sdp?: string }) {
      this.remoteReady = true;
      this.remote = description;
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
    request: vi.fn(async (_lease: string, _request: unknown): Promise<any> => ({
      ok: true,
      result: { ok: true },
    })),
    stop: vi.fn(async () => {}),
    input: vi.fn(async (_lease: string, _sequence: number, _events: unknown[]) => {}),
    nativeAudio: vi.fn(async () => new Uint8Array(0)),
    onCommand: (callback: typeof command) => {
      command = callback;
      return () => {};
    },
    registerHost: vi.fn(async () => {}),
    reply,
  };
  disposers.push(startDesktopCaptureHost(api as any));
  const offer = (
    audio = true,
    overlay = true,
    nativeAudio = false,
    quality?: 'auto' | 'saver' | 'hd',
    fps: 30 | 60 = 30,
    sdp = 'offer',
  ) =>
    command({
      id: 'offer',
      op: 'offer',
      lease: 'lease',
      sdp,
      attemptId: 'attempt',
      sourceId: 'screen:1',
      nativeCapture: true,
      nativeAudio,
      cursorOverlay: overlay,
      settings: { audio, fps, ...(quality ? { quality } : {}) },
    });
  const offerWithoutSettings = (sdp: string) =>
    command({
      id: 'offer',
      op: 'offer',
      lease: 'lease',
      sdp,
      attemptId: 'attempt',
      sourceId: 'screen:1',
      nativeCapture: true,
      cursorOverlay: true,
    });
  return {
    api,
    video,
    nativeStop,
    peers,
    capture,
    reply,
    offer,
    offerWithoutSettings,
    reset: (resume = false) =>
      command({ op: 'capture-reset', lease: 'lease', nativeAudio: resume }),
    stop: () => command({ op: 'stop' }),
  };
}

function nativeSound() {
  const sound = media().sound;
  const close = vi.fn(async () => {});
  vi.stubGlobal(
    'AudioContext',
    class {
      close = close;
      async resume() {}
      createMediaStreamDestination() {
        return { stream: { getTracks: () => [sound], getAudioTracks: () => [sound] } };
      }
    },
  );
  return { sound, close };
}

it.each([
  [undefined, 60, 'maintain-framerate', 60, 20_000_000, ''],
  ['auto', 60, 'maintain-framerate', 60, 20_000_000, ''],
  ['saver', 60, 'maintain-framerate', 30, 2_000_000, ''],
  ['hd', 60, 'maintain-resolution', 60, 20_000_000, 'text'],
  ['hd', 30, 'maintain-resolution', 30, 20_000_000, 'text'],
] as const)(
  'applies the %s tier at %i fps as sender ceilings without restarting capture',
  async (quality, fps, degradationPreference, maxFramerate, maxBitrate, contentHint) => {
    const h = setup();
    h.offer(false, true, false, quality, fps);
    await flush();
    expect(h.peers[0].video.setParameters).toHaveBeenCalledExactlyOnceWith({
      degradationPreference,
      encodings: [{ maxFramerate, maxBitrate }],
    });
    expect(vi.mocked(nativeCaptureStream).mock.calls.at(-1)?.[4]).toBe(maxFramerate);
    expect((h.video.video as { contentHint?: string }).contentHint).toBe(contentHint);
    expect(h.peers).toHaveLength(1);
    expect(h.reply).toHaveBeenCalledWith('offer', 'answer');
    expect(h.nativeStop).not.toHaveBeenCalled();
  },
);

it('keeps full resolution while the screen is still only for tiers that ask for it', async () => {
  const h = setup();
  h.offer(false, true, false, 'auto');
  await flush();
  const onMotion = vi.mocked(nativeCaptureStream).mock.calls.at(-1)?.[5];
  expect(onMotion).toBeTypeOf('function');
  const video = h.peers[0].video.setParameters;
  onMotion!(false);
  await flush();
  expect(video).toHaveBeenLastCalledWith(
    expect.objectContaining({ degradationPreference: 'maintain-resolution' }),
  );
  onMotion!(true);
  await flush();
  expect(video).toHaveBeenLastCalledWith(
    expect.objectContaining({ degradationPreference: 'maintain-framerate' }),
  );

  const hd = setup();
  hd.offer(false, true, false, 'hd');
  await flush();
  expect(vi.mocked(nativeCaptureStream).mock.calls.at(-1)?.[5]).toBeUndefined();
});

it('passes the tier bandwidth floor to the viewer offer, leaving legacy offers untouched', async () => {
  const sdp = 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 100\r\na=rtpmap:100 VP8/90000\r\n';
  const h = setup();
  h.offer(false, true, false, 'saver', 30, sdp);
  await flush();
  expect(h.peers[0].remote?.sdp).toContain('a=fmtp:100 x-google-start-bitrate=1500;');
  const legacy = setup();
  legacy.offerWithoutSettings(sdp);
  await flush();
  expect(legacy.peers.at(-1)?.remote?.sdp).toBe(sdp);
});

it('clears locked audio and restores its existing sender after unlock without Chromium capture', async () => {
  const h = setup();
  const old = nativeSound();
  h.offer(true, true, true);
  await flush();
  h.capture.mockClear();
  h.reset();
  expect(old.sound.stop).toHaveBeenCalledOnce();
  const next = nativeSound();
  h.reset(true);
  await flush();
  expect(h.peers[0].audio.sender.replaceTrack).toHaveBeenCalledWith(next.sound);
  expect(h.video.getAudioTracks()).toEqual([next.sound]);
  expect(h.capture).not.toHaveBeenCalled();
  expect(h.peers[0].close).not.toHaveBeenCalled();
  h.stop();
  expect(next.sound.stop).toHaveBeenCalled();
});

it.each(['lock', 'stop'])('discards late native audio recovery after %s', async (end) => {
  const h = setup();
  nativeSound();
  h.offer(true, true, true);
  await flush();
  const next = nativeSound();
  let resolve!: (bytes: Uint8Array<ArrayBuffer>) => void;
  h.api.nativeAudio.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  h.reset(true);
  await flush();
  if (end === 'lock') h.reset();
  else h.stop();
  resolve(new Uint8Array(0));
  await flush();
  expect(next.sound.stop).toHaveBeenCalledOnce();
  expect(h.peers[0].audio.sender.replaceTrack).not.toHaveBeenCalled();
});

it.each(['startup', 'connected'] as const)(
  'isolates %s native audio failure from video and the lease',
  async (phase) => {
    const h = setup();
    const audio = nativeSound();
    if (phase === 'startup') h.api.nativeAudio.mockRejectedValueOnce(new Error('audio failed'));
    h.offer(true, true, true);
    await flush();
    expect(h.reply).toHaveBeenCalledWith('offer', 'answer');
    if (phase === 'connected') {
      h.api.nativeAudio.mockRejectedValueOnce(new Error('audio failed'));
      await vi.advanceTimersByTimeAsync(20);
    }
    expect(audio.sound.stop).toHaveBeenCalledOnce();
    expect(audio.close).toHaveBeenCalledOnce();
    expect(h.peers[0].close).not.toHaveBeenCalled();
    expect(h.nativeStop).not.toHaveBeenCalled();
    expect(h.video.video.stop).not.toHaveBeenCalled();
    expect(h.api.stop).not.toHaveBeenCalled();
  },
);

it.each(['resolve', 'reject'] as const)(
  'fences late native audio startup %s after a replacement offer',
  async (outcome) => {
    const h = setup();
    const old = nativeSound();
    let resolve!: (bytes: Uint8Array<ArrayBuffer>) => void;
    let reject!: (error: Error) => void;
    h.api.nativeAudio.mockImplementationOnce(
      () =>
        new Promise((yes, no) => {
          resolve = yes;
          reject = no;
        }),
    );
    h.offer(true, true, true);
    await flush();
    const current = nativeSound();
    h.offer(true, true, true);
    await flush();
    if (outcome === 'resolve') resolve(new Uint8Array(0));
    else reject(new Error('old audio failed'));
    await flush();
    expect(old.sound.stop).toHaveBeenCalledOnce();
    expect(current.sound.stop).not.toHaveBeenCalled();
    expect(h.peers).toHaveLength(1);
    expect(h.peers[0].close).not.toHaveBeenCalled();
    expect(h.api.stop).not.toHaveBeenCalled();
    expect(h.reply).toHaveBeenCalledTimes(1);
  },
);

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

it('answers control requests on the input channel without risking the session', async () => {
  const h = setup();
  h.offer(false);
  await flush();
  const [peer] = h.peers as any[];
  const channel: any = {
    label: 'input-v1',
    readyState: 'open',
    bufferedAmount: 0,
    send: vi.fn(),
    close: vi.fn(),
  };
  peer.ondatachannel({ channel });
  const replies = () =>
    channel.send.mock.calls
      .map(([data]: [string]) => JSON.parse(data))
      .filter((message: any) => message.type === 'reply');
  const ask = async (id: string, request: unknown) => {
    channel.onmessage({ data: JSON.stringify({ type: 'request', id, request }) });
    await flush();
  };
  await ask('mute', { op: 'hostMute', lease: 'lease', enabled: true });
  expect(h.api.request).toHaveBeenCalledWith('lease', {
    op: 'hostMute',
    lease: 'lease',
    enabled: true,
  });
  expect(replies().at(-1)).toEqual({ type: 'reply', id: 'mute', ok: true, result: { ok: true } });
  h.api.request.mockResolvedValueOnce({ ok: false, error: 'DESKTOP_VIEW_ONLY' });
  await ask('control', { op: 'control', lease: 'lease', enabled: true });
  expect(replies().at(-1)).toEqual({
    type: 'reply',
    id: 'control',
    ok: false,
    error: 'DESKTOP_VIEW_ONLY',
  });
  // Operations outside the channel set are refused, not fatal: the viewer
  // falls back to the relay and the session continues.
  h.api.request.mockClear();
  await ask('start', { op: 'start', displayId: '1' });
  await ask('list', { op: 'windowAction', lease: 'lease', action: 'list' });
  expect(h.api.request).not.toHaveBeenCalled();
  expect(
    replies()
      .slice(-2)
      .map((reply: any) => reply.error),
  ).toEqual(['DESKTOP_CHANNEL_UNSUPPORTED', 'DESKTOP_CHANNEL_UNSUPPORTED']);
  // A result too large for one channel message is reported, never truncated.
  h.api.request.mockResolvedValueOnce({ ok: true, result: 'x'.repeat(40_000) });
  await ask('modes', { op: 'displayModes', lease: 'lease' });
  expect(replies().at(-1)).toMatchObject({ id: 'modes', error: 'DESKTOP_REPLY_TOO_LARGE' });
  // Requests have their own bound; overflow is refused, not a session stop.
  h.api.request.mockImplementation(() => new Promise(() => {}));
  for (let i = 0; i < 9; i++) await ask(`slow-${i}`, { op: 'clipboardVersion', lease: 'lease' });
  expect(replies().at(-1)).toMatchObject({ id: 'slow-8', error: 'DESKTOP_CHANNEL_BUSY' });
  expect(h.api.stop).not.toHaveBeenCalled();
  expect(peer.close).not.toHaveBeenCalled();
  expect(channel.close).not.toHaveBeenCalled();
});

it('answers control requests while input batches fill their own bound', async () => {
  const h = setup();
  h.offer(false);
  await flush();
  const [peer] = h.peers as any[];
  const channel: any = {
    label: 'input-v1',
    readyState: 'open',
    bufferedAmount: 0,
    send: vi.fn(),
    close: vi.fn(),
  };
  peer.ondatachannel({ channel });
  h.api.input.mockImplementation(() => new Promise(() => {}));
  const batch = (sequence: number) =>
    channel.onmessage({ data: JSON.stringify({ sequence, events: [] }) });
  for (let sequence = 1; sequence <= 8; sequence++) batch(sequence);
  channel.onmessage({
    data: JSON.stringify({
      type: 'request',
      id: 'mute',
      request: { op: 'hostMute', lease: 'lease', enabled: true },
    }),
  });
  await flush();
  expect(JSON.parse(channel.send.mock.calls.at(-1)[0])).toEqual({
    type: 'reply',
    id: 'mute',
    ok: true,
    result: { ok: true },
  });
  expect(h.api.stop).not.toHaveBeenCalled();
  batch(9);
  expect(h.api.stop).toHaveBeenCalled();
});
