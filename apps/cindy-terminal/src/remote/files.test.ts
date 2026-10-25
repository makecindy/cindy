import { mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { TerminalFilePeerService } from './files.js';
import type { TerminalRemoteContext } from './types.js';

// Exercise the real request/auth/handle lifecycle with a disk file. Only native
// SDP negotiation is a stub; actual native bytes are covered by the smoke script.
it('binds file tickets to the authenticated peer and closes authorized handles on stop', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'cindy-terminal-file-test-'));
  const file = path.join(dir, 'sample');
  await writeFile(file, 'private data');
  const handles: Awaited<ReturnType<typeof open>>[] = [];
  const context = (peer: string): TerminalRemoteContext => ({
    source: { kind: 'owner', deviceId: peer, peerId: peer }, sourceDeviceId: peer,
    controllerDeviceId: peer, requestId: 'request1', ownerScope: 'owner1',
    signal: new AbortController().signal, assertCurrent() {},
  });
  class NativePeer {
    iceGatheringState = 'complete';
    localDescription: unknown;
    addEventListener() {}
    createDataChannel() { throw new Error('Unused'); }
    async setRemoteDescription() {}
    async setLocalDescription(value: unknown) { this.localDescription = value; }
    async createAnswer() { return { type: 'answer', sdp: 'answer' }; }
    close() {}
  }
  const openFile = vi.fn(async () => { const handle = await open(file, 'r'); handles.push(handle); return { handle, mimeType: 'text/plain' }; });
  const service = new TerminalFilePeerService({
    native: { RTCPeerConnection: NativePeer as unknown as typeof RTCPeerConnection },
    getOwnerScope: () => 'owner1', invokeRemote: vi.fn(), invokeAuthorized: vi.fn(), openFile,
  });
  try {
    expect(await service.request({ action: 'caps' }, context('controller1'))).toMatchObject({ streaming: true, attachments: false });
    const { connection } = await service.request({ action: 'offer', sdp: 'offer' }, context('controller1')) as { connection: string };
    await expect(service.request({ action: 'open', connection, url: 'cindy-media://known' }, context('controller2'))).rejects.toThrow('File connection unavailable');
    expect(openFile).not.toHaveBeenCalled();
    await expect(service.request({ action: 'open', connection, url: 'cindy-media://known' }, context('controller1'))).resolves.toMatchObject({ size: 12, mimeType: 'text/plain' });
    service.stop();
    await vi.waitFor(async () => { await expect(handles[0].stat()).rejects.toThrow(); }, { interval: 1 });
  } finally { service.stop(); await Promise.all(handles.map(handle => handle.close().catch(() => {}))); await rm(dir, { recursive: true, force: true }); }
});
