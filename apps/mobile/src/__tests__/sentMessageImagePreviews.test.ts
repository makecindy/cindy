import { describe, expect, it } from 'vitest';
import {
  getSentMessageImagePreview, pruneSentMessageImagePreviews, rememberOutboxImagePreviews,
  rememberSentMessageImagePreviews, type SentMessageImagePreviews,
} from '@/session/sentMessageImagePreviews';
import { buildPendingSendItems } from '@/session/pendingSendItems';
import { buildOutboxItem, outboxItemWithUpload } from '@/session/sessionOutbox';
import type { QueuedRemoteMessage, RemoteSerializedAttachment } from '@/session/types';

const image = (id: string, name = `${id}.jpg`): RemoteSerializedAttachment => ({
  id, name, category: 'image', path: `cindy-oss-attach://m/${id}`, url: `cindy-oss-attach://m/${id}`,
  mimeType: 'image/jpeg', size: 100, ext: 'jpg', sha256: id.repeat(64),
});

describe('sent image preview handoff', () => {
  it('seeds restored mixed/partial outbox slots and extends the bridge as uploads finish', () => {
    const previews: SentMessageImagePreviews = new Map();
    const second = image('b');
    let item = buildOutboxItem({ sessionId: 's', clientId: 'm', text: '', permissionModeAtSend: 'ask',
      readyAttachments: [{ ...image('pdf'), category: 'pdf' }, second], readyPreviews: [null, 'file:///durable-b.jpg'],
      claimedUploads: [{ localId: 'upload', kind: 'image', failed: true, previewUri: 'file:///durable-a.jpg' }] });
    rememberOutboxImagePreviews(previews, 's', item);
    expect(getSentMessageImagePreview(previews, 's', 'm', 0, second.name, second.id))
      .toMatchObject({ galleryImageKey: 'm-slot-1', uri: 'file:///durable-b.jpg' });
    item = outboxItemWithUpload(item, 'upload', image('a'));
    rememberOutboxImagePreviews(previews, 's', item);
    expect(getSentMessageImagePreview(previews, 's', 'm', 1, 'a.jpg', 'a'))
      .toMatchObject({ galleryImageKey: 'm-slot-2', uri: 'file:///durable-a.jpg' });
    expect(getSentMessageImagePreview(previews, 's', 'm', 0, second.name, second.id)?.galleryImageKey).toBe('m-slot-1');
    expect(getSentMessageImagePreview(previews, 'other-session', 'm', 0, second.name, second.id)).toBeUndefined();
    // A stale local row is captured first; the authoritative queue still replaces its images.
    rememberSentMessageImagePreviews(previews, 's', 'm', [image('replacement', second.name)], () => null);
    expect(getSentMessageImagePreview(previews, 's', 'm', 0, second.name, second.id)).toBeUndefined();
    expect(getSentMessageImagePreview(previews, 's', 'm', 0, second.name, 'replacement')?.galleryImageKey).toBeUndefined();
  });

  it('retains every restored live outbox identity without local image pixels', () => {
    const previews: SentMessageImagePreviews = new Map();
    const live = new Set(Array.from({ length: 65 }, (_, index) => `restored-${index}`));
    for (const clientId of live) {
      const item = buildOutboxItem({ sessionId: 's', clientId, text: '', permissionModeAtSend: 'ask',
        readyAttachments: [image('a')], claimedUploads: [] });
      rememberOutboxImagePreviews(previews, 's', item, live);
    }
    expect(previews.size).toBe(65);
    for (const clientId of live) {
      expect(getSentMessageImagePreview(previews, 's', clientId, 0, 'a.jpg', 'a'))
        .toMatchObject({ galleryImageKey: `${clientId}-slot-0`, uri: null });
    }
  });

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
      ['message-attachment:a', 'file:///a.jpg'], ['message-attachment:b', 'file:///b.jpg'],
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

  it('retains all live messages in addition to 64 historical records, then releases departed identities', () => {
    const previews: SentMessageImagePreviews = new Map();
    const live = new Set(Array.from({ length: 65 }, (_, index) => `live-${index}`));
    for (const clientId of live) rememberSentMessageImagePreviews(previews, 's', clientId, [image('a')],
      () => 'file:///local.jpg', () => `${clientId}-slot-0`, live);
    for (let index = 0; index < 65; index++) rememberSentMessageImagePreviews(previews, 's', `past-${index}`,
      [image('a')], () => null, undefined, live);
    expect(previews.size).toBe(129);
    for (const clientId of live) {
      expect(getSentMessageImagePreview(previews, 's', clientId, 0, 'a.jpg', 'a'))
        .toMatchObject({ uri: 'file:///local.jpg', galleryImageKey: `${clientId}-slot-0` });
    }
    expect(getSentMessageImagePreview(previews, 's', 'past-0', 0, 'a.jpg', 'a')).toBeUndefined();
    expect(getSentMessageImagePreview(previews, 's', 'past-1', 0, 'a.jpg', 'a')).toBeDefined();
    // A completed/cancelled message stops being protected even if no new image is recorded.
    const previousLive = new Set(live);
    live.delete('live-0');
    pruneSentMessageImagePreviews(previews, 's', live, previousLive);
    expect(previews.size).toBe(128);
    // Just completed is recent history: do not lose its identity at the exact formal handoff.
    expect(getSentMessageImagePreview(previews, 's', 'live-0', 0, 'a.jpg', 'a')?.galleryImageKey).toBe('live-0-slot-0');
    expect(getSentMessageImagePreview(previews, 's', 'past-1', 0, 'a.jpg', 'a')).toBeUndefined();
    pruneSentMessageImagePreviews(previews, 's', new Set(), live);
    expect(previews.size).toBe(64);
  });

  it('scopes live-message retention to the current session', () => {
    const previews: SentMessageImagePreviews = new Map();
    rememberSentMessageImagePreviews(previews, 'other', 'live', [image('a')], () => null);
    const live = new Set(['live']);
    rememberSentMessageImagePreviews(previews, 's', 'live', [image('a')], () => null, undefined, live);
    for (let index = 0; index < 64; index++) rememberSentMessageImagePreviews(previews, 's', `past-${index}`,
      [image('a')], () => null, undefined, live);
    expect(getSentMessageImagePreview(previews, 'other', 'live', 0, 'a.jpg', 'a')).toBeUndefined();
    expect(getSentMessageImagePreview(previews, 's', 'live', 0, 'a.jpg', 'a')).toBeDefined();
    expect(previews.size).toBe(65);
  });

  it('remembers observed queue identity without local pixels and replaces it on remote edits', () => {
    const previews: SentMessageImagePreviews = new Map();
    const file = image('a');
    rememberSentMessageImagePreviews(previews, 's', 'm', [file], () => null);
    expect(getSentMessageImagePreview(previews, 's', 'm', 0, file.name, file.id)).toMatchObject({
      attachmentId: file.id, uri: null, sourceRef: file.url, sha256: file.sha256,
    });
    expect(getSentMessageImagePreview(previews, 's', 'm', 0, file.name, undefined, file.sha256)?.attachmentId).toBe(file.id);
    const replacement = { ...image('b'), name: file.name };
    rememberSentMessageImagePreviews(previews, 's', 'm', [replacement], () => null);
    expect(getSentMessageImagePreview(previews, 's', 'm', 0, file.name, file.id)).toBeUndefined();
    expect(getSentMessageImagePreview(previews, 's', 'm', 0, file.name, undefined, file.sha256)).toBeUndefined();
    expect(getSentMessageImagePreview(previews, 's', 'm', 0, file.name, undefined, replacement.sha256)?.attachmentId).toBe(replacement.id);
    rememberSentMessageImagePreviews(previews, 's', 'm', [], () => null);
    expect(getSentMessageImagePreview(previews, 's', 'm', 0, file.name, replacement.id)).toBeUndefined();
    // Text-only queue traffic must not evict image identities from this bounded store.
    rememberSentMessageImagePreviews(previews, 's', 'm', [file], () => null);
    for (let n = 0; n < 65; n++) rememberSentMessageImagePreviews(previews, 's', String(n), [], () => null);
    expect(getSentMessageImagePreview(previews, 's', 'm', 0, file.name, file.id)?.attachmentId).toBe(file.id);
  });

  it('finds an unchanged attachment by ID after a remote edit moves its image index', () => {
    const previews: SentMessageImagePreviews = new Map();
    const files = [image('a'), image('b')];
    rememberSentMessageImagePreviews(previews, 's', 'm', files, (file) => `file:///${file.id}.jpg`,
      (file) => `m-slot-${files.indexOf(file)}`);
    const moved = getSentMessageImagePreview(previews, 's', 'm', 0, 'b.jpg', 'b');
    expect(moved).toMatchObject({ attachmentId: 'b', uri: 'file:///b.jpg', galleryImageKey: 'm-slot-1' });
    expect(getSentMessageImagePreview(previews, 's', 'm', 0, 'b.jpg', 'replacement')).toBeUndefined();
    // Formal history omits IDs. Reconnect a moved image only after checking its pixels.
    expect(getSentMessageImagePreview(previews, 's', 'm', 0, 'b.jpg', undefined, files[1].sha256)).toEqual(moved);
    expect(getSentMessageImagePreview(previews, 's', 'm', 0, 'b.jpg', undefined, 'changed')).toBeUndefined();
  });

  it.each([null, 'file:///original.jpg'])('tracks a materialized queue reference without a hash while retaining preview %s', (uri) => {
    const previews: SentMessageImagePreviews = new Map();
    const file = { ...image('a'), sha256: undefined };
    rememberSentMessageImagePreviews(previews, 's', 'm', [file], () => uri, () => 'm-slot-1');
    const materialized = { ...file, url: 'cindy-media://blobs/a.jpg' };
    rememberSentMessageImagePreviews(previews, 's', 'm', [materialized], () => null);
    expect(getSentMessageImagePreview(previews, 's', 'm', 0, file.name, undefined, undefined, materialized.url))
      .toMatchObject({ attachmentId: file.id, sourceRef: uri ? file.url : materialized.url, uri, galleryImageKey: 'm-slot-1' });
    expect(getSentMessageImagePreview(previews, 's', 'm', 0, file.name, undefined, undefined, 'cindy-media://blobs/replaced.jpg'))
      .toBeUndefined();
    // A new attachment ID must not inherit the previous URL bridge or its local pixels.
    const replacement = { ...file, id: 'replacement', url: 'cindy-media://blobs/replaced.jpg' };
    rememberSentMessageImagePreviews(previews, 's', 'm', [replacement], () => null);
    expect(getSentMessageImagePreview(previews, 's', 'm', 0, file.name, undefined, undefined, materialized.url)).toBeUndefined();
    expect(getSentMessageImagePreview(previews, 's', 'm', 0, file.name, undefined, undefined, replacement.url))
      .toMatchObject({ attachmentId: replacement.id, uri: null });
    expect(getSentMessageImagePreview(previews, 's', 'm', 0, file.name, replacement.id)?.galleryImageKey).toBeUndefined();
  });

  it('does not choose an ambiguous formal image after its position changes', () => {
    const previews: SentMessageImagePreviews = new Map();
    const first = image('a', 'same.jpg');
    rememberSentMessageImagePreviews(previews, 's', 'm', [first, { ...first, id: 'b' }], () => 'file:///same.jpg',
      (file) => `key-${file.id}`);
    expect(getSentMessageImagePreview(previews, 's', 'm', 2, 'same.jpg', undefined, first.sha256)).toBeUndefined();
  });

  it.each([null, 'file:///durable.jpg'])('retains outbox identity with preview %s and rejects a real replacement', (uri) => {
    const previews: SentMessageImagePreviews = new Map();
    const file = image('a');
    const key = 'm-slot-2';
    rememberSentMessageImagePreviews(previews, 's', 'm', [file], () => uri, () => key);
    const getPreview = (id: string) => getSentMessageImagePreview(previews, 's', 'm', 0, file.name, id);
    expect(getPreview(file.id)).toMatchObject({ uri, galleryImageKey: key });
    // A text-only edit may refresh the URI or lack a new local preview.
    rememberSentMessageImagePreviews(previews, 's', 'm', [file], () => 'file:///refreshed.jpg');
    expect(getPreview(file.id)).toMatchObject({ uri: 'file:///refreshed.jpg', galleryImageKey: key });
    rememberSentMessageImagePreviews(previews, 's', 'm', [file], () => null);
    expect(getPreview(file.id)?.galleryImageKey).toBe(key);
    const replacement = { ...file, id: 'replacement' };
    expect(getPreview(replacement.id)).toBeUndefined();
    rememberSentMessageImagePreviews(previews, 's', 'm', [replacement], () => 'file:///new.jpg');
    expect(getPreview(replacement.id)?.galleryImageKey).toBeUndefined();
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
