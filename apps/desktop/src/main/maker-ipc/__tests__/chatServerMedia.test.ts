import { describe, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({ fetch: vi.fn(), read: vi.fn(), ingest: vi.fn() }));
vi.mock('electron', () => ({ net: { fetch: f.fetch } }));
vi.mock('../../cindy-media/blobStore.js', () => ({ readFile: f.read, supportedMime: () => true }));
vi.mock('../../cindy-media/ingest.js', () => ({ ingestMedia: f.ingest }));
vi.mock('../../localDb/client/current.js', () => ({ getDbClient: () => ({ drizzle: {} }) }));
vi.mock('../../appSessionState.js', () => ({ ownerScopedUserDataPath: () => '/unused-test-owner' }));
vi.mock('../botGroupAttachments.js', () => ({ safeAttachmentFileName: (name: string) => name }));
import { createChatMedia } from '../chatServerMedia.js';
import type { ChatApi } from '../chatServerMigration.js';
import type { BotGroupAttachment } from '../../../shared/botGroupChat.js';
const attachment: BotGroupAttachment = { id: 'file', name: 'picture.png', category: 'image', mimeType: 'image/png', size: 3, url: 'cindy-media://test', path: null };

describe('chat private media', () => {
  it('uploads the bytes without a Cindy token and seals before returning the message reference', async () => {
    f.read.mockResolvedValue({ buffer: Buffer.from('png'), mimeType: 'image/png' });
    f.fetch.mockResolvedValue(new Response('', { status: 200 }));
    const api = vi.fn(async route => route.endsWith('/media') ? { id: 'media', uploadUrl: 'https://upload.example.test/signed' } : {}) as unknown as ChatApi;
    const media = createChatMedia(api, () => true);
    expect(await media.upload('room', 'operation', [attachment], 'actor')).toEqual([{ type: 'media', mediaId: 'media', caption: 'picture.png' }]);
    expect(f.fetch).toHaveBeenLastCalledWith('https://upload.example.test/signed', expect.objectContaining({ redirect: 'error', headers: { 'Content-Type': 'image/png' } }));
    expect(vi.mocked(api).mock.calls.at(-1)?.[0]).toBe('/conversations/room/media/media/complete');
  });
  it('does not upload bytes when the owner changes during local file reading', async () => {
    let current = true;
    f.fetch.mockClear();
    f.read.mockImplementation(async () => { current = false; return { buffer: Buffer.from('png') }; });
    const api = vi.fn() as unknown as ChatApi;
    await expect(createChatMedia(api, () => current).upload('room', 'op', [attachment], 'actor')).rejects.toThrow('OWNER_CHANGED');
    expect(api).not.toHaveBeenCalled();
    expect(f.fetch).not.toHaveBeenCalled();
  });
  it('rechecks membership before reusing cached media bytes', async () => {
    f.fetch.mockResolvedValue(new Response('png'));
    f.ingest.mockResolvedValue({ url: 'cindy-media://cached' });
    let allowed = true;
    const api = vi.fn(async () => {
      if (!allowed) throw new Error('CONVERSATION_NOT_FOUND');
      return { name: 'p.png', type: 'image/png', size: 3, url: 'https://download.example.test/signed' };
    }) as unknown as ChatApi;
    const media = createChatMedia(api, () => true);
    expect((await media.download('room', 'media')).url).toBe('cindy-media://cached');
    allowed = false;
    await expect(media.download('room', 'media')).rejects.toThrow('CONVERSATION_NOT_FOUND');
    expect(api).toHaveBeenCalledTimes(2);
  });
});
