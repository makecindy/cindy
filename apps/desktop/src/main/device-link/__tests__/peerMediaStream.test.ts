// Unit: a seek must request only its byte range; old hosts and revoked scopes
// must not publish a stream. Existing filePeer tests cover tickets, not HTTP reads.
import { beforeEach, expect, it, vi } from 'vitest';
const peer = vi.hoisted(() => vi.fn());
const bytes = vi.hoisted(() => vi.fn());
vi.mock('../filePeer', () => ({ tryPeerFileRange: peer }));
vi.mock('node:fs', () => ({ promises: { readFile: bytes } }));
import { openRemotePeerMediaStream } from '../peerMediaStream';
const metadata = { ossKey: '', size: 2 * 1024 * 1024 + 9, mimeType: 'video/mp4', version: 'a'.repeat(64) };
const dispose = vi.fn(async () => {});
beforeEach(() => {
  vi.clearAllMocks();
  peer.mockImplementation(async (_device, _url, _invoke, range) => ({ path: range, dispose }));
  bytes.mockImplementation(async range => Buffer.alloc(range.end - range.start + 1, range.start % 251));
});
const open = (current = () => true, signal?: AbortSignal) =>
  openRemotePeerMediaStream('device', 'cindy-media://video', vi.fn(), metadata, current, signal);
it('serves a tail seek without fetching the intervening video or re-reading the first chunk', async () => {
  const stream = (await open())!;
  expect(peer).toHaveBeenCalledTimes(1);
  const initial = await stream.serve('bytes=0-1');
  expect(Array.from(new Uint8Array(await initial.arrayBuffer()))).toEqual([0, 0]);
  expect(peer).toHaveBeenCalledTimes(1);
  const response = await stream.serve('bytes=-9');
  expect(response.status).toBe(206);
  expect(response.headers.get('content-range')).toBe(`bytes ${metadata.size - 9}-${metadata.size - 1}/${metadata.size}`);
  expect((await response.arrayBuffer()).byteLength).toBe(9);
  expect(peer.mock.calls[1][3]).toEqual({ start: metadata.size - 9, end: metadata.size - 1, version: metadata.version });
  expect(dispose).toHaveBeenCalledTimes(2);
});
it('rejects an unsatisfiable range without another transfer', async () => {
  const stream = (await open())!;
  expect((await stream.serve(`bytes=${metadata.size}-`)).status).toBe(416);
  expect(peer).toHaveBeenCalledTimes(1);
});
it('returns null for an old or unavailable peer before publishing an HTTP stream', async () => {
  expect(await openRemotePeerMediaStream('device', 'video', vi.fn(),
    { ...metadata, size: 2 * 1024 ** 3 + 1 }, () => true)).toBeNull();
  expect(peer).not.toHaveBeenCalled();
  peer.mockResolvedValue(null);
  expect(await open()).toBeNull();
  expect(bytes).not.toHaveBeenCalled();
});
it('rejects a revoked owner and disposes a pending range completed after cancellation', async () => {
  let current = true;
  const stream = (await open(() => current))!;
  current = false;
  await expect(stream.serve(null)).rejects.toThrow('FILE_PEER_CANCELLED');
  const abort = new AbortController();
  bytes.mockImplementationOnce(async () => { abort.abort(); return Buffer.alloc(1024 * 1024); });
  await expect(open(() => true, abort.signal)).rejects.toThrow('FILE_PEER_CANCELLED');
  expect(dispose).toHaveBeenCalledTimes(2);
});
it('cancels the active file read when the player abandons its response', async () => {
  const stream = (await open())!;
  let complete!: (value: unknown) => void;
  peer.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
  const response = await stream.serve('bytes=1048576-1048580');
  const reader = response.body!.getReader();
  const pending = reader.read();
  await Promise.resolve();
  const signal = peer.mock.calls[1][4] as AbortSignal;
  await reader.cancel();
  expect(signal.aborted).toBe(true);
  complete({ path: {}, dispose });
  await pending;
  expect(stream.isAvailable()).toBe(true);
});
