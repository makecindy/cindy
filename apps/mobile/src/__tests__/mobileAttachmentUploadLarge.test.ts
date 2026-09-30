import { beforeAll, describe, expect, it, vi } from 'vitest';
import { apiFetchRaw } from '@/api/client';
import { installPeerUpload, installPeerUploadProbe } from '@/device-link/peerFileRegistry';
import { OSS_ATTACHMENT_MAX_BYTES, buildPeerAttachmentRef, parsePeerAttachmentRef } from '@cindy/device-link';
import { i18n } from '@/i18n';
import { sha256MobileAttachmentFile } from '@/session/mobileAttachmentSha256';
import { uploadMobileAttachmentFromFile } from '@/session/mobileAttachmentUpload';

// 真实摘要要逐块读完数 GB,这里只验证路由:摘要换成定值。
vi.mock('@/session/mobileAttachmentSha256', () => ({
  sha256MobileAttachmentFile: vi.fn(async () => 'a'.repeat(64)),
  sha256MobileAttachmentBody: vi.fn(async () => 'a'.repeat(64)),
}));

beforeAll(async () => {
  await i18n.changeLanguage('zh-CN');
});

const size = OSS_ATTACHMENT_MAX_BYTES + 1;
const readFileChunk = vi.fn();

describe('mobileAttachmentUpload beyond the OSS limit', () => {
  it('sends over the direct connection without any size cap', async () => {
    const apiFetch = vi.fn();
    const peer = vi.fn(async (_device, _uri, metadata) =>
      buildPeerAttachmentRef({ ...metadata, ticket: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' }));
    const off = installPeerUpload(peer);
    const offProbe = installPeerUploadProbe(async () => true);
    try {
      const attachment = await uploadMobileAttachmentFromFile({ name: 'movie.mov', size }, 'file:///source', {
        deviceId: 'host-a', token: 'token', deps: { apiFetch: apiFetch as unknown as typeof apiFetchRaw, readFileChunk },
      });
      expect(parsePeerAttachmentRef(attachment.path)?.size).toBe(size);
      expect(attachment.category).toBe('file');
      expect(apiFetch).not.toHaveBeenCalled();
    } finally { off(); offProbe(); }
  });

  it('fails before snapshotting or hashing when the peer cannot take a direct attachment', async () => {
    const apiFetch = vi.fn();
    const snapshotFile = vi.fn();
    const peer = vi.fn();
    const probe = vi.fn(async () => false);
    vi.mocked(sha256MobileAttachmentFile).mockClear();
    const off = installPeerUpload(peer);
    const offProbe = installPeerUploadProbe(probe);
    try {
      await expect(uploadMobileAttachmentFromFile({ name: 'movie.mov', size }, 'file:///source', {
        deviceId: 'host-a', token: 'token', deps: { apiFetch: apiFetch as unknown as typeof apiFetchRaw, snapshotFile },
      })).rejects.toThrow('文件超过 2 GB，只能在与电脑直连时发送');
      expect(probe).toHaveBeenCalledWith('host-a', size);
      expect(snapshotFile).not.toHaveBeenCalled();
      expect(sha256MobileAttachmentFile).not.toHaveBeenCalled();
      expect(peer).not.toHaveBeenCalled();
      expect(apiFetch).not.toHaveBeenCalled();
    } finally { off(); offProbe(); }
  });

  it('fails without falling back to OSS when the direct connection is unavailable', async () => {
    const apiFetch = vi.fn();
    const off = installPeerUpload(async () => null);
    const offProbe = installPeerUploadProbe(async () => true);
    try {
      await expect(uploadMobileAttachmentFromFile({ name: 'movie.mov', size }, 'file:///source', {
        deviceId: 'host-a', token: 'token', deps: { apiFetch: apiFetch as unknown as typeof apiFetchRaw, readFileChunk },
      })).rejects.toThrow('文件超过 2 GB，只能在与电脑直连时发送');
      expect(apiFetch).not.toHaveBeenCalled();
    } finally { off(); offProbe(); }
  });
});
