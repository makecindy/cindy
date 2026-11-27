import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PLUGIN_ATTACHMENT_MAX_BYTES, PLUGIN_ATTACHMENT_MAX_ITEM_BYTES } from '../../../shared/pluginAttachments.js';
import type { AgentInputSerializedFile } from '../../../shared/agentInputQueue.js';

const state = vi.hoisted(() => ({ owner: { client: { drizzle: {} } }, ingest: vi.fn(), root: '' }));
vi.mock('../../localDb/client/current.js', () => ({ getCurrentDbClientSnapshot: () => state.owner }));
vi.mock('../blobStore.desktop.js', () => ({
  extForMime: (mime: string) => ({ 'image/png': '.png', 'image/jpeg': '.jpg', 'video/mp4': '.mp4' } as Record<string, string>)[mime],
  supportedMime: (mime: string) => ['image/png', 'image/jpeg', 'video/mp4'].includes(mime),
  blobUrl: (hash: string, ext: string) => `cindy-media://blobs/${hash}${ext}`,
  resolveSafe: (url: string) => ({ absPath: `/media/${url.slice('cindy-media://blobs/'.length)}` }),
}));
vi.mock('../ingest.js', () => ({ ingestMedia: state.ingest }));
// The IM file tree, rooted in a temporary folder: staging, then the task's own folder.
vi.mock('../../im/shared/inboundFileStaging.js', async () => {
  const { default: nodeFs } = await import('node:fs');
  const { default: nodePath } = await import('node:path');
  return {
    stageInboundFile: async ({ integration, buffer, fileName }: { integration: string; buffer: Uint8Array; fileName: string }) => {
      const dir = nodePath.join(state.root, integration, 'staging');
      nodeFs.mkdirSync(dir, { recursive: true });
      const absPath = nodePath.join(dir, `${Math.random().toString(16).slice(2)}-${fileName}`);
      nodeFs.writeFileSync(absPath, buffer);
      return { absPath, discard: async () => undefined };
    },
    adoptStagedInboundFiles: async (sessionId: string, attachments: Array<{ absPath: string }>) => {
      for (const attachment of attachments) {
        const dir = nodePath.join(state.root, 'plugin', 'sessions', sessionId);
        nodeFs.mkdirSync(dir, { recursive: true });
        const target = nodePath.join(dir, nodePath.basename(attachment.absPath));
        nodeFs.renameSync(attachment.absPath, target);
        attachment.absPath = target;
      }
    },
  };
});
import { collectPluginAttachmentPayloadTexts, withParsedPluginMessageAttachments, withPluginMessageAttachments } from '../pluginMessageAttachments.js';

const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const base64 = bytes.toString('base64');
const hash = createHash('sha256').update(bytes).digest('hex');
const url = `cindy-media://blobs/${hash}.png`;
// Minimal ISO BMFF header: ftyp isom/mp41 → video/mp4.
const video = Buffer.from([0, 0, 0, 24, ...Buffer.from('ftypisom'), 0, 0, 2, 0, ...Buffer.from('isommp41')]);
const document = Buffer.from('%PDF-1.7 quarterly report');
const withImages = <T>(deliver: (files: AgentInputSerializedFile[]) => Promise<T>) =>
  withParsedPluginMessageAttachments([{ base64, name: 'window.png' }], images =>
    withPluginMessageAttachments(images, () => {}, deliver));
const ingested = (input: { buffer: Buffer; mimeType: string }) => {
  const digest = createHash('sha256').update(input.buffer).digest('hex');
  const ext = input.mimeType === 'video/mp4' ? '.mp4' : '.png';
  return { url: `cindy-media://blobs/${digest}${ext}`, mimeType: input.mimeType, ext, bytes: input.buffer.length };
};
afterEach(() => {
  state.ingest.mockReset();
  if (state.root) fs.rmSync(state.root, { recursive: true, force: true });
  state.root = '';
  expect(collectPluginAttachmentPayloadTexts()).toEqual([]);
});

describe('plugin message attachment delivery', () => {
  // Production boundary: withParsedPluginMessageAttachments. No URL/path reads or caller MIME trust.
  it.each([
    [{ url }], [{ path: '/private/window.png', base64 }], [{ base64, mimeType: 'image/png' }],
    [{ base64: 'not image===' }], [{ base64: 'AB==' }],
    [{ base64, name: '../window.png' }], Array.from({ length: 11 }, () => ({ base64 })),
    [{ base64: 'A'.repeat(Math.ceil(PLUGIN_ATTACHMENT_MAX_ITEM_BYTES / 3) * 4 + 4) }],
  ].map(value => ({ value })))('rejects invalid or oversized attachments before ingestion', async ({ value }) => {
    await expect(withParsedPluginMessageAttachments(value, vi.fn())).rejects.toThrow('INVALID_ATTACHMENTS');
    expect(state.ingest).not.toHaveBeenCalled();
  });
  it('detects the image from bytes and protects it through the durable handoff', async () => {
    state.ingest.mockImplementation(async (input: { assertStillValid: () => void }, db: unknown) => {
      input.assertStillValid();
      expect(db).toBe(state.owner.client.drizzle);
      expect(collectPluginAttachmentPayloadTexts().join('')).toContain(url);
      return { url, mimeType: 'image/png', ext: '.png', bytes: bytes.length };
    });
    const result = await withImages(async files => {
      expect(files).toMatchObject([{ url, category: 'image', mimeType: 'image/png', path: '', originalName: 'window.png' }]);
      expect(files[0]).not.toHaveProperty('base64');
      expect(collectPluginAttachmentPayloadTexts().join('')).toContain(url);
      return 'persisted';
    });
    expect(result).toBe('persisted');
    expect(state.ingest).toHaveBeenCalledWith(expect.objectContaining({ refs: [], isCache: false }), state.owner.client.drizzle);
  });
  // Like Cindy's IM channels: media enters cindy-media, other bytes are files in the task folder,
  // and model-only references stay reclaimable (media cache, staging files).
  it('routes video and documents like IM inbound attachments, keeping context reclaimable', async () => {
    state.root = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-attachments-'));
    state.ingest.mockImplementation(async (input: { buffer: Buffer; mimeType: string }) => ingested(input));
    const delivered = await withParsedPluginMessageAttachments(
      [{ base64: video.toString('base64'), name: 'clip.mp4' }, { base64: document.toString('base64'), name: 'report.pdf' }],
      (items, contextItems) => withPluginMessageAttachments(items, () => {},
        async (files, contextFiles) => ({ files, contextFiles }), { sessionId: 'task-1', contextItems }),
      [{ base64 }, { base64: document.toString('base64'), name: 'old.pdf' }],
    );
    const videoUrl = ingested({ buffer: video, mimeType: 'video/mp4' }).url;
    expect(delivered.files).toMatchObject([
      { category: 'file', mimeType: 'video/mp4', url: videoUrl, path: `/media/${videoUrl.slice('cindy-media://blobs/'.length)}`, name: 'clip.mp4' },
      { category: 'file', mimeType: 'application/octet-stream', ext: '.pdf', name: 'report.pdf' },
    ]);
    expect(delivered.files[1]).not.toHaveProperty('url');
    expect(path.dirname(delivered.files[1]!.path)).toBe(path.join(state.root, 'plugin', 'sessions', 'task-1'));
    expect(fs.readFileSync(delivered.files[1]!.path)).toEqual(document);
    expect(delivered.contextFiles).toMatchObject([{ category: 'image', url, name: 'image.png' }, { category: 'file', name: 'old.pdf' }]);
    expect(path.dirname(delivered.contextFiles[1]!.path)).toBe(path.join(state.root, 'plugin', 'staging'));
    expect(state.ingest.mock.calls.map(([input]) => [input.mimeType, input.isCache]))
      .toEqual([['video/mp4', false], ['image/png', true]]);
  });
  it('removes files written for a send whose media import fails, and never delivers it', async () => {
    state.root = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-attachments-'));
    state.ingest.mockRejectedValue(new Error('write failed'));
    const deliver = vi.fn();
    await expect(withParsedPluginMessageAttachments(
      [{ base64: document.toString('base64'), name: 'report.pdf' }, { base64 }],
      items => withPluginMessageAttachments(items, () => {}, deliver, { sessionId: 'task-1' }),
    )).rejects.toThrow('write failed');
    expect(deliver).not.toHaveBeenCalled();
    expect(fs.readdirSync(path.join(state.root, 'plugin', 'sessions', 'task-1'))).toEqual([]);
  });
  it.each(['SUPERSEDED', 'DELIVERY_REJECTED', 'DELIVERY_UNCERTAIN'])('releases only in-flight protection after %s without replaying', async code => {
    state.ingest.mockResolvedValue({ url, mimeType: 'image/png', ext: '.png', bytes: bytes.length });
    const deliver = vi.fn(async () => { throw new Error(code); });
    await expect(withImages(deliver)).rejects.toThrow(code);
    expect(deliver).toHaveBeenCalledOnce();
    // Any adopted queue/message is protected by the existing queue and chat ref owners.
    expect(collectPluginAttachmentPayloadTexts()).toEqual([]);
  });
  it('rejects a stale owner after ingestion and never submits to the new account', async () => {
    state.ingest.mockImplementation(async () => {
      state.owner = { client: { drizzle: {} } };
      return { url, mimeType: 'image/png', ext: '.png', bytes: bytes.length };
    });
    const deliver = vi.fn();
    await expect(withImages(deliver)).rejects.toThrow('PERMISSION_DENIED');
    expect(deliver).not.toHaveBeenCalled();
  });
  it('does not deliver after an import failure; a retry imports the same content safely', async () => {
    const deliver = vi.fn(async () => 'accepted');
    state.ingest.mockRejectedValueOnce(new Error('write failed'))
      .mockResolvedValueOnce({ url, mimeType: 'image/png', ext: '.png', bytes: bytes.length });
    await expect(withImages(deliver)).rejects.toThrow('write failed');
    expect(deliver).not.toHaveBeenCalled();
    expect(await withImages(deliver)).toBe('accepted');
    expect(deliver).toHaveBeenCalledOnce();
  });
  // Hold the real production boundary before receipt admission, without importing or sending.
  it('bounds aggregate decoding before allocation and releases successful and failed requests', async () => {
    const large = Buffer.alloc(PLUGIN_ATTACHMENT_MAX_BYTES / 2);
    bytes.copy(large);
    const encoded = large.toString('base64');
    // Each request carries the whole per-send budget, split across shown and context attachments.
    const value = [{ base64: encoded }];
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const decode = vi.spyOn(Buffer, 'from');
    const first = withParsedPluginMessageAttachments(value, async () => {
      await held;
      return 'accepted';
    }, value);
    const second = withParsedPluginMessageAttachments(value, async () => {
      await held;
      throw new Error('cancelled');
    }, value);
    const settled = Promise.allSettled([first, second]);
    try {
      const deliver = vi.fn();
      await expect(withParsedPluginMessageAttachments(value, deliver))
        .rejects.toMatchObject({ code: 'TASK_BUSY', retryable: true });
      expect(deliver).not.toHaveBeenCalled();
      expect(decode.mock.calls.filter(args => args[0] === encoded)).toHaveLength(4);
      expect(await withParsedPluginMessageAttachments(undefined, async () => 'text')).toBe('text');
    } finally {
      release();
      decode.mockRestore();
      await settled;
    }
    expect(await settled).toMatchObject([{ status: 'fulfilled' }, { status: 'rejected' }]);
    expect(await Promise.all([1, 2].map(() => withParsedPluginMessageAttachments(value, async (items, context) =>
      items[0]!.buffer.length + context[0]!.buffer.length, value))))
      .toEqual([PLUGIN_ATTACHMENT_MAX_BYTES, PLUGIN_ATTACHMENT_MAX_BYTES]);
  });
});
