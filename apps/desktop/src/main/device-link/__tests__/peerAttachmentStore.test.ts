import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
const state = vi.hoisted(() => ({ root: '', peer: 'a', current: true }));
vi.mock('../../appSessionState', () => ({ ownerScopedUserDataPath: () => state.root }));
vi.mock('../broadcast-tap', () => ({
  captureDataOwnerBroadcastScope: () => ({}),
  isDataOwnerBroadcastScopeCurrent: () => state.current,
}));
vi.mock('../invoke-context', () => ({
  getDeviceLinkInvokeContext: () => ({ controllerDeviceId: state.peer }),
}));
import { handlePeerAttachment, copyPeerAttachment } from '../peerAttachmentStore';
beforeEach(async () => {
  state.root = await mkdtemp(path.join(os.tmpdir(), 'cindy-peer-upload-'));
  state.current = true;
  state.peer = 'a';
});
afterEach(async () => {
  await rm(state.root, { recursive: true, force: true });
});
const metadata = {
  size: 5,
  sha256: createHash('sha256').update('hello').digest('hex'),
  mimeType: 'text/plain',
};
it('verifies complete bytes, retains retryable staging and fences another controller', async () => {
  const { ticket } = (await handlePeerAttachment('a', { op: 'begin', ...metadata })) as {
    ticket: string;
  };
  await handlePeerAttachment('a', {
    op: 'write',
    ticket,
    offset: 0,
    data: Buffer.from('hello').toString('base64'),
  });
  await expect(
    copyPeerAttachment({ ...metadata, ticket }, path.join(state.root, 'out')),
  ).rejects.toThrow();
  await handlePeerAttachment('a', { op: 'finish', ticket });
  await copyPeerAttachment({ ...metadata, ticket }, path.join(state.root, 'out'));
  expect(await readFile(path.join(state.root, 'out'), 'utf8')).toBe('hello');
  state.peer = 'b';
  await expect(
    copyPeerAttachment({ ...metadata, ticket }, path.join(state.root, 'out2')),
  ).rejects.toThrow('DENIED');
  await expect(handlePeerAttachment('b', { op: 'cancel', ticket })).rejects.toThrow('DENIED');
  state.current = false;
  await expect(handlePeerAttachment('a', { op: 'cancel', ticket })).rejects.toThrow('CANCELLED');
});
it('rejects incorrect hashes and out of order writes', async () => {
  const { ticket } = (await handlePeerAttachment('a', { op: 'begin', ...metadata })) as {
    ticket: string;
  };
  await expect(
    handlePeerAttachment('a', { op: 'write', ticket, offset: 2, data: 'eA==' }),
  ).rejects.toThrow('BLOCK');
  await handlePeerAttachment('a', {
    op: 'write',
    ticket,
    offset: 0,
    data: Buffer.from('wrong').toString('base64'),
  });
  await expect(handlePeerAttachment('a', { op: 'finish', ticket })).rejects.toThrow('INTEGRITY');
});
