import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildAttachmentOssRef, buildPeerAttachmentRef } from '@cindy/device-link';
import type { StartReviewRequest } from '../reviewStartHandler';
import { withOutboundReviewConfirmation, withPreparedOutboundReview } from '../reviewOutboundInput';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function setup(managed = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-review-outbound-'));
  roots.push(root);
  const file = path.join(root, 'external.md');
  await fs.writeFile(file, 'approved bytes');
  const request = { sourceSessionId: 'remote-source', focus: '/host/only.md', attachments: [{ name: 'external.md', path: file }] };
  const deps = {
    owner: { instanceId: 'outbound-test', processId: process.pid, liveness: { version: 1 as const, port: 65534, token: 'outbound-test-token' } },
    ensureOwnerReady: vi.fn(async () => {}),
    resolvePath: async (raw: string) => ({ absPath: await fs.realpath(raw), managed }),
  };
  return { request, deps, file };
}

describe('controller Review attachment authorization', () => {
  const integrity = { size: 1, sha256: 'a'.repeat(64) };
  const sensitiveAttachments: Array<[string, StartReviewRequest['attachments'][number]]> = [
    ['inline dotenv', { name: '.env', base64: 'ZmFrZQ==' }],
    ['inline key', { name: 'id_rsa', base64: 'ZmFrZQ==' }],
    ['cached label', { name: '.env.local', url: 'xdt-image://task/ordinary.txt' }],
    ['cached original name', { name: 'ordinary.txt', originalName: 'id_rsa', url: 'cindy-media://blobs/ordinary.txt' }],
    ['masked name', { name: '.env', originalName: 'ordinary.txt', base64: 'ZmFrZQ==' }],
    ['source path', { name: 'ordinary.txt', path: path.join(os.tmpdir(), 'fake-review-fixture', '.env') }],
    ['alternate path', { name: 'ordinary.txt', url: 'xdt-image://task/ordinary.txt', path: path.join(os.tmpdir(), 'fake-review-fixture', 'id_rsa') }],
    ['peer original name', { name: 'ordinary.txt', url: buildPeerAttachmentRef({ ...integrity, ticket: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', originalName: '.env' }) }],
    ['OSS original name', { name: 'ordinary.txt', url: buildAttachmentOssRef({ ...integrity, ossKey: 'cindy/device-link/fake/ordinary.txt', originalName: 'id_rsa' }) }],
  ];

  it.each(sensitiveAttachments)('rejects %s before preparing or uploading any attachment', async (_label, attachment) => {
    const { request, deps } = await setup();
    deps.resolvePath = vi.fn();
    const confirm = vi.fn(async () => true);
    const upload = vi.fn();
    const batch = { ...request, attachments: [...request.attachments, attachment] };
    await expect(withOutboundReviewConfirmation(confirm, () => withPreparedOutboundReview(batch, upload, deps))).rejects.toThrow('PERMISSION_DENIED');
    expect(deps.resolvePath).not.toHaveBeenCalled();
    expect(deps.ensureOwnerReady).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
  });

  it.each(['.environment', '.envrc', 'environment.ts'])('keeps ordinary similarly named attachments usable (%s)', async (name) => {
    const { request, deps } = await setup();
    const upload = vi.fn(async () => 'uploaded');
    const batch = { ...request, attachments: [{ ...request.attachments[0], name }] };
    await expect(withOutboundReviewConfirmation(async () => true, () => withPreparedOutboundReview(batch, upload, deps))).resolves.toBe('uploaded');
    expect(upload).toHaveBeenCalledOnce();
  });

  it.each([false, undefined])('uploads nothing when native confirmation is denied or unavailable (%s)', async (decision) => {
    const { request, deps } = await setup();
    const upload = vi.fn();
    const operation = () => withPreparedOutboundReview(request, upload, deps);
    const run = decision === undefined ? operation() : withOutboundReviewConfirmation(async () => decision, operation);
    await expect(run).rejects.toThrow('cancelled');
    expect(upload).not.toHaveBeenCalled();
    expect(deps.ensureOwnerReady).not.toHaveBeenCalled();
  });

  it.each([false, true])('uploads only confirmed immutable bytes and cleans snapshots after success/failure (%s)', async (fail) => {
    const { request, deps, file } = await setup();
    let snapshotPath = '';
    const confirm = vi.fn(async () => true);
    const operation = withOutboundReviewConfirmation(confirm, () => withPreparedOutboundReview(request, async (prepared) => {
      snapshotPath = prepared.attachments[0].path!;
      expect(snapshotPath).not.toBe(file);
      await fs.writeFile(file, 'changed after snapshot');
      expect(await fs.readFile(snapshotPath, 'utf8')).toBe('approved bytes');
      expect(prepared.focus).toBe('/host/only.md');
      expect(prepared.attachments[0].url).toBeUndefined();
      if (fail) throw new Error('upload failed');
      return 'uploaded';
    }, deps));
    if (fail) await expect(operation).rejects.toThrow('upload failed');
    else await expect(operation).resolves.toBe('uploaded');
    expect(confirm).toHaveBeenCalledWith([{ kind: 'external-path', label: 'external.md', path: await fs.realpath(file) }]);
    await expect(fs.stat(snapshotPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(request.attachments[0].path).toBe(file);
  });

  it('rejects a file replaced while confirmation is open before uploading', async () => {
    const { request, deps, file } = await setup();
    const upload = vi.fn();
    await expect(withOutboundReviewConfirmation(async () => {
      await fs.writeFile(file, 'different file content after confirmation');
      return true;
    }, () => withPreparedOutboundReview(request, upload, deps))).rejects.toThrow('changed after permission');
    expect(upload).not.toHaveBeenCalled();
  });

  it('retains the no-extra-confirmation rule for controller-managed artifacts', async () => {
    const { request, deps } = await setup(true);
    const confirm = vi.fn(async () => false);
    const upload = vi.fn(async () => 'uploaded');
    await expect(withOutboundReviewConfirmation(confirm, () => withPreparedOutboundReview(request, upload, deps))).resolves.toBe('uploaded');
    expect(confirm).not.toHaveBeenCalled();
  });

  it('requires confirmation for inline bytes and never uploads an unapproved alternate path', async () => {
    const { deps } = await setup();
    const request = { sourceSessionId: 'remote-source', attachments: [{ name: 'inline.txt', base64: 'YQ==', path: 'clipboard://item' }] };
    const upload = vi.fn(async (prepared) => prepared);
    await expect(withPreparedOutboundReview(request, upload, deps)).rejects.toThrow('cancelled');
    const prepared = await withOutboundReviewConfirmation(async () => true, () => withPreparedOutboundReview(request, upload, deps));
    expect(prepared.attachments[0]).toEqual({ name: 'inline.txt', base64: 'YQ==', path: undefined, url: undefined });
  });

  it('does not resolve already uploaded peer references as controller paths', async () => {
    const { deps } = await setup();
    const ref = buildPeerAttachmentRef({ ticket: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', size: 1, sha256: 'a'.repeat(64) });
    deps.resolvePath = vi.fn();
    const request = { sourceSessionId: 'remote-source', attachments: [{ name: 'a', url: ref }] };
    await withPreparedOutboundReview(request, async (prepared) => expect(prepared).toBe(request), deps);
    expect(deps.resolvePath).not.toHaveBeenCalled();
  });

  it('does not suppress sensitive-path rejections from the existing Review resolver', async () => {
    const { request, deps } = await setup();
    deps.resolvePath = async () => { throw new Error('Review refused a credential or key path'); };
    const confirm = vi.fn(async () => true);
    const upload = vi.fn();
    await expect(withOutboundReviewConfirmation(confirm, () => withPreparedOutboundReview(request, upload, deps))).rejects.toThrow('credential or key path');
    expect(confirm).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
  });
});
