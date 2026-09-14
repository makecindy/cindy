import { describe, expect, it } from 'vitest';
import {
  getSentMessageImagePreview, rememberSentMessageImagePreviews, type SentMessageImagePreviews,
} from '@/session/sentMessageImagePreviews';
import { buildPendingSendItems } from '@/session/pendingSendItems';
import type { QueuedRemoteMessage, RemoteSerializedAttachment } from '@/session/types';

const image = (id: string, name = `${id}.jpg`): RemoteSerializedAttachment => ({
  id, name, category: 'image', path: `cindy-oss-attach://m/${id}`, url: `cindy-oss-attach://m/${id}`,
  mimeType: 'image/jpeg', size: 100, ext: 'jpg', sha256: id.repeat(64),
});

describe('sent image preview handoff', () => {
  it('keeps image order through mixed files and host URL materialization, including the formal message', () => {
    const previews: SentMessageImagePreviews = new Map();
    const files = [image('a'), { ...image('pdf'), category: 'pdf' as const }, image('b')];
    rememberSentMessageImagePreviews(previews, 'session', 'message', files, (file) => `file:///${file.id}.jpg`);
    const getPreview = (clientId: string, index: number, name: string, id?: string, sha256?: string) => (
      getSentMessageImagePreview(previews, 'session', clientId, index, name, id, sha256)
    );
    const queued = {
      clientId: 'message', text: '', chatMessage: {},
      files: files.map((file) => ({ ...file, url: `cindy-media://blobs/${file.id}.jpg` })),
    } as unknown as QueuedRemoteMessage;
    const [pending] = buildPendingSendItems({ queue: [queued], settling: [], outbox: [],
      hiddenClientIds: new Set(), sendingClientIds: new Set(), editingClientId: null,
      steeringClientIds: new Set(), presentationByClientId: new Map(), getImagePreview: getPreview });
    expect(pending.thumbs.map((thumb) => [thumb.key, thumb.uri])).toEqual([
      ['message-slot-0', 'file:///a.jpg'], ['message-slot-2', 'file:///b.jpg'],
    ]);
    expect(pending.thumbs[0].previewRef).toBe(files[0].url);
    // Formal messages have no file ID; the accepted message and image position remain stable.
    expect(getPreview('message', 1, 'b.jpg', undefined, files[2].sha256)?.uri).toBe(pending.thumbs[1].uri);
    expect(getPreview('message', 1, 'b.jpg', undefined, 'changed-fingerprint')).toBeUndefined();
    expect(getSentMessageImagePreview(previews, 'other-session', 'message', 1, 'b.jpg')).toBeUndefined();
  });

  it('replaces all image slots on edit, including same-name replacements and absent previews', () => {
    const previews: SentMessageImagePreviews = new Map();
    rememberSentMessageImagePreviews(previews, 's', 'm', [image('a', 'same.jpg'), image('b')], () => 'file:///old.jpg');
    expect(getSentMessageImagePreview(previews, 's', 'm', 0, 'same.jpg', 'changed-on-desktop')).toBeUndefined();
    rememberSentMessageImagePreviews(previews, 's', 'm', [image('new', 'same.jpg')], () => 'file:///new.jpg');
    expect(getSentMessageImagePreview(previews, 's', 'm', 0, 'same.jpg', 'new')?.uri).toBe('file:///new.jpg');
    expect(getSentMessageImagePreview(previews, 's', 'm', 1, 'b.jpg')).toBeUndefined();
    rememberSentMessageImagePreviews(previews, 's', 'm', [image('missing', 'same.jpg')], () => null);
    expect(getSentMessageImagePreview(previews, 's', 'm', 0, 'same.jpg')).toBeUndefined();
  });

  it('bounds retained message previews', () => {
    const previews: SentMessageImagePreviews = new Map();
    for (let n = 0; n < 65; n++) rememberSentMessageImagePreviews(previews, 's', String(n), [image('a')], () => 'file:///a.jpg');
    expect(previews.size).toBe(64);
    expect(getSentMessageImagePreview(previews, 's', '0', 0, 'a.jpg')).toBeUndefined();
  });

  it('preserves previews on text-only edits and matches the persisted original name', () => {
    const previews: SentMessageImagePreviews = new Map();
    const attachment = { ...image('a', 'upload.jpg'), originalName: 'photo.jpg' };
    rememberSentMessageImagePreviews(previews, 's', 'm', [attachment], () => 'ph://original');
    rememberSentMessageImagePreviews(previews, 's', 'm', [{ ...attachment, url: 'cindy-media://blobs/a.jpg' }], () => undefined);
    const formal = getSentMessageImagePreview(previews, 's', 'm', 0, 'photo.jpg', undefined, attachment.sha256);
    expect(formal?.uri).toBe('ph://original');
    expect(formal?.sourceRef).toBe(attachment.url);
    expect(getSentMessageImagePreview(previews, 's', 'm', 0, 'upload.jpg', 'a')).toEqual(formal);
  });
});
