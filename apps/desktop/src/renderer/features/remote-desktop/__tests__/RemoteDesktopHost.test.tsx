// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { startDesktopCaptureHost } from '../captureHost';
const disposers: Array<() => void> = [];
import { nativeCaptureStream } from '../nativeCaptureStream';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/ui/confirm-dialog', () => ({ ConfirmDialog: () => null }));
vi.mock('@/components/settings/RemoteDesktopPermissions', () => ({
  RemoteDesktopPermissions: () => null,
}));
vi.mock('../nativeCaptureStream', () => ({ nativeCaptureStream: vi.fn() }));
afterEach(() => {
  disposers.splice(0).forEach((dispose) => dispose());
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it('keeps system audio with cursor-free native video and stops cursor updates with the lease', async () => {
  vi.useFakeTimers();
  const audio = { kind: 'audio', stop: vi.fn() };
  const chromiumVideo = { kind: 'video', stop: vi.fn() };
  const nativeVideo = { kind: 'video', stop: vi.fn() };
  const tracks = [nativeVideo];
  const stream = {
    getTracks: () => tracks,
    getVideoTracks: () => [nativeVideo],
    getAudioTracks: () => tracks.filter((track) => track.kind === 'audio'),
    addTrack: (track: typeof audio) => tracks.push(track),
  };
  let cursorUpdate!: (value: any) => void;
  const stopNative = vi.fn();
  vi.mocked(nativeCaptureStream).mockImplementationOnce(async (_read, _alive, _failed, update) => {
    cursorUpdate = update!;
    return { stream, stop: stopNative, clear: vi.fn() } as any;
  });
  vi.stubGlobal('navigator', {
    mediaDevices: {
      getDisplayMedia: vi.fn(async () => ({
        getTracks: () => [audio, chromiumVideo],
        getVideoTracks: () => [chromiumVideo],
        getAudioTracks: () => [audio],
      })),
    },
  });
  let peer: any;
  class Peer {
    localDescription = { sdp: 'answer' };
    iceGatheringState = 'complete';
    close = vi.fn();
    addTrack = vi.fn();
    constructor() {
      peer = this;
    }
    getSenders() {
      return [];
    }
    async setRemoteDescription() {}
    async setLocalDescription() {}
    async createAnswer() {
      return {};
    }
  }
  vi.stubGlobal('RTCPeerConnection', Peer);
  let command!: (value: any) => void;
  const api = {
    onCommand: (fn: typeof command) => {
      command = fn;
      return () => {};
    },
    registerHost: vi.fn(async () => {}),
    reply: vi.fn(async () => {}),
  };
  disposers.push(startDesktopCaptureHost(api as any));
  await act(async () =>
    command({
      op: 'offer',
      id: 'offer',
      lease: 'lease',
      sdp: 'offer',
      attemptId: 'a',
      sourceId: 'screen:1',
      nativeCapture: true,
      cursorOverlay: true,
      settings: { audio: true, fps: 60 },
    }),
  );
  expect(api.reply).toHaveBeenCalledWith('offer', 'answer');
  expect(peer.addTrack.mock.calls.map(([track]: any[]) => track)).toEqual([nativeVideo, audio]);
  expect(chromiumVideo.stop).toHaveBeenCalledOnce();
  expect(audio.stop).not.toHaveBeenCalled();
  const channel = { label: 'input-v1', readyState: 'open', bufferedAmount: 0, send: vi.fn() };
  peer.ondatachannel({ channel });
  cursorUpdate({ x: 0.5 });
  await act(() => vi.advanceTimersByTimeAsync(50));
  expect(channel.send).toHaveBeenLastCalledWith(
    JSON.stringify({ type: 'cursor', cursor: { x: 0.5 } }),
  );
  channel.bufferedAmount = 65537;
  cursorUpdate({ x: 0.6 });
  await act(() => vi.advanceTimersByTimeAsync(50));
  expect(channel.send).toHaveBeenCalledTimes(1);
  command({ op: 'stop' });
  channel.bufferedAmount = 0;
  cursorUpdate({ x: 0.7 });
  await act(() => vi.advanceTimersByTimeAsync(100));
  expect(channel.send).toHaveBeenCalledTimes(1);
  expect(audio.stop).toHaveBeenCalledOnce();
  expect(nativeVideo.stop).toHaveBeenCalledOnce();
  expect(stopNative).toHaveBeenCalledOnce();
});

it.each(['rejected', 'missing'] as const)(
  'rejects native video with %s requested audio and releases capture',
  async (audio) => {
    const track = { stop: vi.fn() };
    const stream = {
      getTracks: () => [track],
      getVideoTracks: () => [track],
      getAudioTracks: () => [],
      addTrack: vi.fn(),
    };
    const stopNative = vi.fn();
    vi.mocked(nativeCaptureStream).mockResolvedValue({
      stream,
      stop: stopNative,
    } as unknown as Awaited<ReturnType<typeof nativeCaptureStream>>);
    const capture =
      audio === 'rejected'
        ? vi.fn().mockRejectedValue(new Error('unavailable'))
        : vi.fn().mockResolvedValue(stream);
    vi.stubGlobal('navigator', { mediaDevices: { getDisplayMedia: capture } });
    let command!: (value: unknown) => void;
    const reply = vi.fn().mockResolvedValue(undefined);
    Object.assign(window, {
      electronAPI: {
        remoteDesktop: {
          onCommand: (callback: typeof command) => {
            command = callback;
            return () => {};
          },
          registerHost: vi.fn().mockResolvedValue(undefined),
          state: vi.fn().mockResolvedValue(null),
          stop: vi.fn().mockResolvedValue(undefined),
          reply,
        },
      },
    });
    disposers.push(startDesktopCaptureHost(window.electronAPI.remoteDesktop as any));
    await act(async () => {
      command({
        op: 'offer',
        id: 'offer',
        lease: 'lease',
        sdp: 'sdp',
        sourceId: 'screen:1',
        nativeCapture: true,
        cursorOverlay: true,
        settings: { audio: true, fps: 30 },
      });
    });
    expect(reply).toHaveBeenCalledWith('offer', { error: 'DESKTOP_AUDIO_UNAVAILABLE' });
    expect(stopNative).toHaveBeenCalled();
    expect(track.stop).toHaveBeenCalled();
  },
);

it('exchanges replayable candidates without recapturing, tolerates transient disconnect and fences old attempts', async () => {
  vi.useFakeTimers();
  const peers: any[] = [];
  class Peer {
    connectionState = 'new';
    iceGatheringState = 'gathering';
    localDescription = { sdp: 'answer' };
    onconnectionstatechange = () => {};
    onicecandidate = (_event: any) => {};
    close = vi.fn(() => {
      this.connectionState = 'closed';
      this.onconnectionstatechange();
    });
    addIceCandidate = vi.fn(async () => {});
    constructor() {
      peers.push(this);
    }
    addTrack() {}
    getSenders() {
      return [];
    }
    async setRemoteDescription() {}
    async setLocalDescription() {}
    async createAnswer() {
      return {};
    }
  }
  vi.stubGlobal('RTCPeerConnection', Peer);
  const track = { stop: vi.fn() },
    stream = { getTracks: () => [track], getVideoTracks: () => [track] };
  const capture = vi.fn().mockResolvedValue(stream);
  vi.stubGlobal('navigator', { mediaDevices: { getDisplayMedia: capture } });
  let command!: (value: any) => void;
  const reply = vi.fn().mockResolvedValue(undefined);
  const viewHeartbeat = vi.fn().mockResolvedValue(undefined);
  Object.assign(window, {
    electronAPI: {
      remoteDesktop: {
        onCommand: (cb: typeof command) => {
          command = cb;
          return () => {};
        },
        reply,
        viewHeartbeat,
        registerHost: vi.fn().mockResolvedValue(undefined),
        state: vi.fn().mockResolvedValue(null),
        stop: vi.fn().mockResolvedValue(undefined),
      },
    },
  });
  disposers.push(startDesktopCaptureHost(window.electronAPI.remoteDesktop as any));
  const offer = {
    op: 'offer',
    id: 'offer',
    lease: 'lease',
    sdp: 'sdp',
    sourceId: 'screen:1',
    attemptId: 'a',
  };
  await act(async () => command(offer));
  expect(reply).toHaveBeenCalledWith('offer', 'answer'); // No gather delay for new endpoints.
  const channel = {
    label: 'input-v1',
    readyState: 'open',
    send: vi.fn(),
    onmessage: (_event: any) => {},
  };
  peers[0].ondatachannel({ channel });
  await act(() => vi.advanceTimersByTimeAsync(8000));
  expect(channel.send).toHaveBeenCalledTimes(1);
  const firstChallenge = JSON.parse(channel.send.mock.calls[0][0]).challenge;
  channel.onmessage({ data: firstChallenge });
  expect(viewHeartbeat).toHaveBeenCalledWith('lease');
  await act(() => vi.advanceTimersByTimeAsync(2000));
  expect(channel.send).toHaveBeenCalledTimes(2);
  expect(JSON.parse(channel.send.mock.calls[1][0]).challenge).not.toBe(firstChallenge);
  const candidate = {
    candidate: 'candidate:1 1 UDP 100 192.0.2.1 5000 typ host',
    sdpMid: '0',
    sdpMLineIndex: 0,
  };
  peers[0].onicecandidate({ candidate });
  const ice = {
    op: 'ice',
    id: 'ice',
    lease: 'lease',
    attemptId: 'a',
    after: 0,
    candidates: [candidate],
  };
  await act(async () => command(ice));
  await act(async () => command({ ...ice, id: 'replay' }));
  expect(reply).toHaveBeenCalledWith('replay', {
    attemptId: 'a',
    next: 1,
    candidates: [candidate],
    complete: false,
  });
  expect(peers[0].addIceCandidate).toHaveBeenCalledTimes(1);
  expect(capture).toHaveBeenCalledTimes(1);
  expect(track.stop).not.toHaveBeenCalled();
  peers[0].connectionState = 'disconnected';
  peers[0].onconnectionstatechange();
  await act(() => vi.advanceTimersByTimeAsync(4999));
  expect(peers[0].close).not.toHaveBeenCalled();
  peers[0].connectionState = 'connected';
  peers[0].onconnectionstatechange();
  await act(() => vi.advanceTimersByTimeAsync(2));
  expect(peers[0].close).not.toHaveBeenCalled();
  await act(async () => command({ ...offer, id: 'new', attemptId: 'b' }));
  channel.onmessage({ data: JSON.parse(channel.send.mock.calls[1][0]).challenge });
  expect(viewHeartbeat).toHaveBeenCalledTimes(1);
  await act(async () => command({ ...ice, id: 'old' }));
  expect(reply).toHaveBeenCalledWith('old', { error: 'DESKTOP_VIDEO_STOPPED' });
  expect(peers[1].addIceCandidate).not.toHaveBeenCalled();
  expect(peers[1].close).not.toHaveBeenCalled();
});
