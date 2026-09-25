import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { promises as fs } from 'node:fs';
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
  vi.restoreAllMocks();
  await rm(state.root, { recursive: true, force: true });
});
const metadata = {
  size: 5,
  sha256: createHash('sha256').update('hello').digest('hex'),
  mimeType: 'text/plain',
};
it('expires unfinished tickets after one idle hour even without admission sweeping', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(0);
  const { ticket } = (await handlePeerAttachment('a', { op: 'begin', ...metadata })) as {
    ticket: string;
  };
  clock.mockReturnValue(60 * 60_000 + 1);
  await expect(
    handlePeerAttachment('a', { op: 'write', ticket, offset: 0, data: 'aGVsbG8=' }),
  ).rejects.toThrow('DENIED');
  await expect(handlePeerAttachment('a', { op: 'finish', ticket })).rejects.toThrow('DENIED');
  // Expiry must not remove the owner's existing cancellation/cleanup path.
  await expect(handlePeerAttachment('a', { op: 'cancel', ticket })).resolves.toEqual({ ok: true });
});
it('serializes admission sweeping with an in-flight ticket write and rechecks its timestamp', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(0);
  const { ticket } = (await handlePeerAttachment('a', { op: 'begin', ...metadata })) as {
    ticket: string;
  };
  clock.mockReturnValue(60 * 60_000 - 1);
  const rename = fs.rename.bind(fs);
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const spy = vi.spyOn(fs, 'rename').mockImplementationOnce(async (from, to) => {
    await hold;
    await rename(from, to);
  });
  const write = handlePeerAttachment('a', { op: 'write', ticket, offset: 0, data: 'aGVsbG8=' });
  await vi.waitFor(() => expect(spy).toHaveBeenCalled());
  clock.mockReturnValue(60 * 60_000 + 1);
  const admission = handlePeerAttachment('a', { op: 'begin', ...metadata });
  release();
  await Promise.all([write, admission]);
  expect(await readFile(path.join(state.root, ticket), 'utf8')).toBe('hello');
  await handlePeerAttachment('a', { op: 'finish', ticket });
  clock.mockReturnValue(2 * 60 * 60_000);
  await copyPeerAttachment({ ...metadata, ticket }, path.join(state.root, 'completed'));
});
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
