import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RECORDING_AUDIO } from '../../../shared/recordingAudio';

const mocks = vi.hoisted(() => ({ handlers: new Map<string, (...args: any[]) => any>(), sources: vi.fn(), id: 0 }));
vi.mock('electron', () => ({
  ipcMain: { handle: (key: string, handler: (...args: any[]) => any) => mocks.handlers.set(key, handler), on: (key: string, handler: (...args: any[]) => any) => mocks.handlers.set(key, handler) },
  desktopCapturer: { getSources: mocks.sources },
}));
vi.mock('../../remote-desktop/captureWindow', () => ({ DesktopCaptureWindow: class {
  contents: any = { id: ++mocks.id, mainFrame: {}, isDestroyed: () => false, session: { setDisplayMediaRequestHandler: vi.fn() } };
  start = vi.fn(async () => {});
  dispose = vi.fn();
  assertSender(event: any) { if (event.sender !== this.contents || event.senderFrame !== this.contents.mainFrame) throw new Error('Wrong owner'); }
  registered(event: any) { this.assertSender(event); }
} }));
import { RecordingAudioHost, registerRecordingAudioIpc } from '../recordingAudio';

// Unit: real host/IPC lifecycle protects the isolated-media boundary described in
// electron-security-and-process-boundaries.md. Existing window tests cover media
// grants, not PCM ownership, bounded buffering or late display enumeration.
// Minimal failures: forged sender, >100 ms backlog, stop before getSources resolves.
// Measured standalone wall time on Windows: 1.87 s (Vitest 381 ms).
registerRecordingAudioIpc();
const active: RecordingAudioHost[] = [];
beforeEach(() => { vi.useFakeTimers(); mocks.sources.mockReset(); });
afterEach(() => { active.forEach(host => host.stop()); active.length = 0; vi.useRealTimers(); });
function setup() {
  const host = new RecordingAudioHost({ system: true, microphone: false }, 7);
  active.push(host);
  const starting = host.start();
  const owner = host.window.contents!;
  const event = { sender: owner, senderFrame: owner.mainFrame };
  return { host, starting, owner, event };
}

it('only accepts its registered top frame and returns bounded live PCM once', async () => {
  const { host, starting, owner, event } = setup();
  expect(mocks.handlers.get(RECORDING_AUDIO.REGISTER)!(event)).toEqual({ system: true, microphone: false });
  expect(() => mocks.handlers.get(RECORDING_AUDIO.REGISTER)!({ sender: { id: -1 } })).toThrow();
  mocks.handlers.get(RECORDING_AUDIO.STATE)!(event);
  await starting;
  const send = mocks.handlers.get(RECORDING_AUDIO.DATA)!;
  send({ sender: owner, senderFrame: {} }, new Uint8Array(8).fill(9));
  send({ sender: { id: owner.id, mainFrame: owner.mainFrame }, senderFrame: owner.mainFrame }, new Uint8Array(8).fill(9));
  expect(host.read()).toHaveLength(0);
  send(event, new Uint8Array(38400).fill(1));
  send(event, new Uint8Array(8).fill(2));
  const bytes = host.read();
  expect(bytes.length).toBe(38400);
  expect(bytes[0]).toBe(1);
  expect(Array.from(bytes.slice(-8))).toEqual(Array(8).fill(2));
  expect(host.read()).toHaveLength(0);
  host.stop();
  expect(() => host.read()).toThrow();
  expect(host.window.dispose).toHaveBeenCalledOnce();
});

it.each(['malformed', 'stalled', 'denied'] as const)('revokes capture and reports %s audio instead of silently saving', async reason => {
  const { host, starting, event } = setup();
  if (reason === 'denied') {
    const rejected = expect(starting).rejects.toThrow('microphoneFailed');
    mocks.handlers.get(RECORDING_AUDIO.STATE)!(event, 'microphoneFailed');
    await rejected;
  } else {
    mocks.handlers.get(RECORDING_AUDIO.STATE)!(event);
    await starting;
    if (reason === 'malformed') mocks.handlers.get(RECORDING_AUDIO.DATA)!(event, new Uint8Array(7));
    else vi.advanceTimersByTime(3001);
    expect(() => host.read()).toThrow();
  }
  expect(host.window.dispose).toHaveBeenCalledOnce();
});

it('grants only the selected display and refuses a pending request after cancellation', async () => {
  const { host, starting, owner, event } = setup();
  mocks.handlers.get(RECORDING_AUDIO.STATE)!(event);
  await starting;
  const request = vi.mocked(owner.session.setDisplayMediaRequestHandler).mock.calls[0][0]!;
  const callback = vi.fn();
  const args = { frame: owner.mainFrame, videoRequested: true, audioRequested: true } as any;
  mocks.sources.mockResolvedValueOnce([{ display_id: '8' }, { display_id: '7' }]);
  request(args, callback);
  await vi.advanceTimersByTimeAsync(0);
  expect(callback).toHaveBeenLastCalledWith({ video: { display_id: '7' }, audio: 'loopback' });
  let resolve!: (sources: any[]) => void;
  mocks.sources.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  request(args, callback);
  host.stop();
  resolve([{ display_id: '7' }]);
  await vi.advanceTimersByTimeAsync(0);
  expect(callback).toHaveBeenLastCalledWith({});
});
