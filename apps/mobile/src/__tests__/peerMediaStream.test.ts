// Unit: production file-player adapter must retain only a local stream receipt,
// release staging ranges, and stop on scope change. Transfer tests do not open players.
import { beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({
  peer: vi.fn(), bytes: vi.fn(), release: vi.fn(), create: vi.fn(),
  bridge: vi.fn(), available: vi.fn(), receipt: vi.fn(),
}));
vi.mock('expo-file-system', () => ({ File: class { bytes = h.bytes; } }));
vi.mock('expo-crypto', () => ({ getRandomBytesAsync: async () => new Uint8Array(32), randomUUID: () => 'test-player' }));
vi.mock('@cindy/agent-net/portable', () => ({ openNativeByteStream: h.bridge, toBase64Url: () => 'random-ephemeral-seed' }));
vi.mock('../device-link/agentNetNative', () => ({ MobileAgentNetEngine: { available: h.available, create: h.create } }));
vi.mock('../device-link/peerFileRegistry', () => ({
  tryMobilePeerFileRange: h.peer, peerMediaUri: () => 'file:///temporary-range',
  releasePeerMedia: h.release, recordPeerMediaPlayback: h.receipt,
}));
import { openPeerMediaStream } from '../device-link/peerMediaStream';
const metadata = { ossKey: '', size: 2 * 1024 * 1024, mimeType: 'video/mp4', version: 'a'.repeat(64) };
const destroy = vi.fn(async () => {});
beforeEach(() => {
  vi.clearAllMocks();
  h.available.mockReturnValue(true);
  h.create.mockResolvedValue({ destroy });
  h.peer.mockImplementation(async (_device, _url, range) => {
    h.bytes.mockResolvedValueOnce(new Uint8Array(range.end - range.start + 1));
    return { ...metadata, size: range.end - range.start + 1 };
  });
  h.bridge.mockResolvedValue({ isOpen: () => false });
});
const open = (current = () => true, signal?: AbortSignal) => openPeerMediaStream('device', 'cindy-media://video', metadata, current, signal);
it('uses the verified probe and shares repeated native tail requests without retransfer', async () => {
  const result = await open();
  expect(result).toEqual(metadata);
  const reader = await h.bridge.mock.calls[0][2]({});
  const write = vi.fn();
  await reader.read(0, 1, write);
  expect(write.mock.calls[0][0]).toEqual(new Uint8Array(2));
  expect(h.peer).toHaveBeenCalledTimes(1);
  await Promise.all([
    reader.read(metadata.size - 3, metadata.size - 1, write),
    reader.read(metadata.size - 3, metadata.size - 1, write),
  ]);
  await reader.read(metadata.size - 3, metadata.size - 1, write);
  expect(h.peer).toHaveBeenCalledTimes(2);
  expect(write).toHaveBeenCalledTimes(4);
  expect(h.peer.mock.calls[1][2]).toEqual({ start: metadata.size - 3, end: metadata.size - 1, version: metadata.version });
  expect(h.release).toHaveBeenCalledTimes(2);
  expect(h.receipt).toHaveBeenCalledWith(result, expect.any(Object));
  expect(h.create.mock.calls[0][0].udp).toBe(false);
});
it('falls back without opening a native engine when the peer cannot serve ranges', async () => {
  expect(await openPeerMediaStream('device', 'video',
    { ...metadata, size: 2 * 1024 ** 3 + 1 }, () => true)).toBeNull();
  expect(h.peer).not.toHaveBeenCalled();
  h.peer.mockResolvedValue(null);
  expect(await open()).toBeNull();
  expect(h.create).not.toHaveBeenCalled();
});
it('releases mismatched staging data and never publishes its bytes', async () => {
  h.peer.mockResolvedValue({ ...metadata, size: 1024 * 1024, version: 'b'.repeat(64) });
  await expect(open()).rejects.toThrow('FILE_PEER_CHANGED');
  expect(h.release).toHaveBeenCalledOnce();
  expect(h.receipt).not.toHaveBeenCalled();
});
it('refuses cached bytes after owner revocation and tears down a failed native bridge', async () => {
  let current = true;
  await open(() => current);
  const reader = await h.bridge.mock.calls[0][2]({});
  current = false;
  const write = vi.fn();
  await expect(reader.read(0, 1, write)).rejects.toThrow('FILE_PEER_CANCELLED');
  expect(write).not.toHaveBeenCalled();
  h.bridge.mockRejectedValueOnce(new Error('native unavailable'));
  await expect(open()).rejects.toThrow('native unavailable');
  expect(destroy).toHaveBeenCalledOnce();
});
it('reserves the four native slots while probes are still pending', async () => {
  const finish: Array<(value: null) => void> = [];
  h.peer.mockImplementation(() => new Promise(resolve => finish.push(resolve)));
  const pending = Array.from({ length: 4 }, () => open());
  expect(await open()).toBeNull();
  expect(h.peer).toHaveBeenCalledTimes(4);
  finish.forEach(resolve => resolve(null));
  await Promise.all(pending);
  h.peer.mockResolvedValue(null);
  expect(await open()).toBeNull();
  expect(h.peer).toHaveBeenCalledTimes(5);
});
