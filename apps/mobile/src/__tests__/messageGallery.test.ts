import { describe, expect, it, vi } from 'vitest';
import {
  collectMobileMessageGalleryImages,
  galleryImageIndexForPayload,
  lightboxImagesForPayload,
} from '@/session/messageGallery';
import type { MobileMessageRenderItem } from '@/session/messageRenderModel';
import { buildMobileMessageRenderItems } from '@/session/messageRenderModel';
import type { RemoteMessage } from '@/session/types';
import { mobileMarkdownImageUrlForWorkdir, mobileMarkdownManagedImagePreviewUrl } from '@/session/messageMarkdown';
import { buildMediaPayload } from '@/session/messagePayload';
import { buildOutboxItem, outboxDisplayItem, type MobileOutboxThumb } from '@/session/sessionOutbox';
import { buildPendingSendItems } from '@/session/pendingSendItems';
import { getSentMessageImagePreview, rememberSentMessageImagePreviews, type GetSentMessageImagePreview,
  type SentMessageImagePreviews } from '@/session/sentMessageImagePreviews';

const durableThumbs = vi.hoisted(() => new Map<string, string>());
vi.mock('@/session/sentAttachmentThumbStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/session/sentAttachmentThumbStore')>()),
  getSentAttachmentThumbUri: (ref: string) => durableThumbs.get(ref) ?? null,
}));

function messageItem(key: string, message: Partial<MobileMessageRenderItem & { message: unknown }>['message']): MobileMessageRenderItem {
  return {
    type: 'message',
    key,
    message: {
      key,
      source: { clientId: key, role: 'user', content: '', createdAt: '2026-01-01T00:00:00.000Z' },
      kind: 'user',
      role: 'user',
      label: 'user',
      body: '',
      align: 'user',
      createdAt: '2026-01-01T00:00:00.000Z',
      ...(message as object),
    },
  } as MobileMessageRenderItem;
}

function pendingItem(key: string, thumbs: MobileOutboxThumb[]): Extract<MobileMessageRenderItem, { type: 'pending_send' }> {
  return {
    type: 'pending_send', key, clientId: key, text: '', sentInlineTokens: [], phase: 'queued',
    queueIndex: 1, thumbs, fileCount: 0, attachmentCount: thumbs.length, uploadedCount: thumbs.length,
    errorText: null, actions: null, hint: null,
  };
}

describe('message gallery', () => {
  it.each([
    ['file:///photo.jpg', null, 'file:///photo.jpg', true],
    ['ph://photo', null, 'ph://photo', true],
    ['content://photo', null, 'content://photo', true],
    ['assets-library://photo', null, 'assets-library://photo', true],
    ['file:///photo.jpg', 'cindy-oss-attach://photo', 'file:///photo.jpg', true],
    ['file:///photo.jpg', 'cindy-media://blobs/photo.jpg', 'cindy-media://blobs/photo.jpg', false],
    [null, 'cindy-media://blobs/photo.jpg', 'cindy-media://blobs/photo.jpg', false],
    ['file:///photo.jpg', 'https://example.com/photo.jpg', 'https://example.com/photo.jpg', true],
  ] as const)('includes pending image %s / %s using a renderable source', (uri, ossRef, url, previewable) => {
    const gallery = collectMobileMessageGalleryImages([pendingItem('pending', [
      { key: 'photo', uri, ossRef, uploading: !ossRef },
    ])]);
    expect(gallery).toHaveLength(1);
    expect(gallery[0]).toMatchObject({ url, groupKey: 'pending', payload: { media: { url, previewable } } });
  });

  it('uses the durable upload preview and keeps paging within the selected pending message', () => {
    durableThumbs.set('cindy-oss-attach://pending', 'file:///durable.jpg');
    try {
      const gallery = collectMobileMessageGalleryImages([
        pendingItem('pending-a', [
          { key: 'a0', uri: 'file:///temporary.jpg', ossRef: 'cindy-media://blobs/a.jpg',
            previewRef: 'cindy-oss-attach://pending', uploading: false },
          { key: 'a1', uri: 'file:///b.jpg', ossRef: null, uploading: true },
        ]),
        pendingItem('pending-b', [{ key: 'b0', uri: 'file:///c.jpg', ossRef: null, uploading: false }]),
      ]);
      expect(gallery[0].previewUri).toBe('file:///durable.jpg');
      expect(lightboxImagesForPayload(gallery, gallery[0].payload, 'pending-a').map((image) => image.key))
        .toEqual(['a0', 'a1']);
    } finally { durableThumbs.clear(); }
  });

  it('excludes pending placeholders that have no readable image yet', () => {
    const gallery = collectMobileMessageGalleryImages([pendingItem('pending', [
      { key: 'upload', uri: null, ossRef: 'cindy-oss-attach://missing', uploading: false },
      { key: 'empty', uri: null, ossRef: null, uploading: true },
    ])]);
    expect(gallery).toEqual([]);
  });

  it('keeps the second pending image in its gallery as uploads settle to new URLs', () => {
    const thumbs = [0, 1].map((index) => ({ key: `pending-slot-${index}`, uri: `file:///temporary-${index}.jpg`,
      ossRef: `cindy-oss-attach://pending-${index}`, uploading: true }));
    const initial = collectMobileMessageGalleryImages([pendingItem('pending', thumbs)]);
    const opened = initial[1].payload;
    try {
      durableThumbs.set(thumbs[1].ossRef, 'file:///durable-1.jpg');
      const durable = collectMobileMessageGalleryImages([pendingItem('pending', thumbs)]);
      const durablePages = lightboxImagesForPayload(durable, opened, 'pending');
      expect(durablePages.map((image) => image.key)).toEqual(thumbs.map((thumb) => thumb.key));
      expect(galleryImageIndexForPayload(durablePages, opened)).toBe(1);
      const settled = collectMobileMessageGalleryImages([pendingItem('pending', thumbs.map((thumb, index) => ({
        ...thumb, uploading: false, ossRef: `cindy-media://blobs/settled-${index}.jpg`,
      })))]);
      const settledPages = lightboxImagesForPayload(settled, opened, 'pending');
      expect(settledPages).toHaveLength(2);
      expect(galleryImageIndexForPayload(settledPages, opened)).toBe(1);
      expect(settledPages[1].url).toBe('cindy-media://blobs/settled-1.jpg');
    } finally { durableThumbs.clear(); }
  });

  it('keeps distinct pending attachment slots even when they settle to the same content URL', () => {
    const gallery = collectMobileMessageGalleryImages([pendingItem('pending', [0, 1].map((index) => ({
      key: `pending-slot-${index}`, uri: null, ossRef: 'cindy-media://blobs/same.jpg', uploading: false,
    })))]);
    expect(gallery).toHaveLength(2);
    expect(galleryImageIndexForPayload(gallery, gallery[1].payload)).toBe(1);
  });

  it('locates the replacement of a clicked slot when an earlier placeholder becomes readable before opening', () => {
    const thumbs = [
      { key: 'earlier', uri: null, ossRef: null, uploading: true },
      { key: 'clicked', uri: 'file:///clicked.jpg', ossRef: null, uploading: false },
    ];
    const clicked = collectMobileMessageGalleryImages([pendingItem('pending', thumbs)])[0].payload;
    const current = collectMobileMessageGalleryImages([pendingItem('pending', [
      { ...thumbs[0], uri: 'file:///earlier.jpg' },
      { ...thumbs[1], key: 'replacement', uri: 'file:///replacement.jpg' },
    ])]);
    const images = lightboxImagesForPayload(current, clicked, 'pending');
    expect(galleryImageIndexForPayload(images, clicked)).toBe(1);
  });

  it('prefers an unchanged attachment identity to its old position when a queued edit reorders images', () => {
    const thumbs = [0, 1].map((index) => ({ key: `slot-${index}`, uri: 'file:///duplicate.jpg',
      ossRef: null, uploading: false }));
    const clicked = collectMobileMessageGalleryImages([pendingItem('pending', thumbs)])[1].payload;
    const reordered = collectMobileMessageGalleryImages([pendingItem('pending', [...thumbs].reverse())]);
    expect(galleryImageIndexForPayload(reordered, clicked)).toBe(0);
  });

  it('retains the open pending gallery through row handoff without using another message with the same URL', () => {
    const previous = collectMobileMessageGalleryImages([pendingItem('pending', [0, 1].map((index) => ({
      key: `pending-slot-${index}`, uri: `file:///local-${index}.jpg`, ossRef: null, uploading: false,
    })))]);
    const opened = previous[1].payload;
    const unrelated = collectMobileMessageGalleryImages([messageItem('other', {
      attachments: [{ kind: 'image', name: 'same.jpg', uri: opened.media.url, previewable: true }],
    })]);
    expect(lightboxImagesForPayload(unrelated, opened, 'pending', previous, false, true)).toEqual(previous);
    expect(lightboxImagesForPayload([], opened, 'pending', previous, false, true)).toEqual(previous);
    // A different click must not inherit a previous viewer's pending gallery.
    expect(lightboxImagesForPayload(unrelated, unrelated[0].payload, 'other', previous)).toEqual(unrelated);
  });

  it.each([false, true])('hands an outbox snapshot to the formal message with a different server ID (history gap: %s)', (gap) => {
    const files = [0, 1].map((index) => ({ id: `upload-${index}`, name: `photo-${index}.jpg`,
      category: 'image' as const, path: `cindy-oss-attach://upload-${index}`, size: 100, ext: 'jpg', mimeType: 'image/jpeg' }));
    const item = buildOutboxItem({ clientId: 'mobile-client-id', sessionId: 's', text: '',
      readyAttachments: files, readyPreviews: ['file:///outbox-0.jpg', 'file:///outbox-1.jpg'],
      claimedUploads: [], permissionModeAtSend: 'ask' });
    const [row] = buildPendingSendItems({ queue: [], settling: [], outbox: [outboxDisplayItem(item)],
      hiddenClientIds: new Set(), sendingClientIds: new Set(), editingClientId: null,
      steeringClientIds: new Set(), presentationByClientId: new Map() });
    let previous = collectMobileMessageGalleryImages([row]);
    const opened = previous[1].payload;
    if (gap) previous = lightboxImagesForPayload([], opened, row.key, previous, false, true);
    const message: RemoteMessage = { id: 'server-history-id', clientId: item.clientId, sessionId: 's',
      role: 'user', content: { images: files.map((file, index) => ({
        name: file.name, url: `cindy-media://blobs/formal-${index}.jpg`,
      })) }, toolUseId: null, agentMeta: null, createdAt: '2026-01-01T00:00:00.000Z' };
    // A separate message has identical image URLs, and the server's ID differs from clientId.
    const rows = buildMobileMessageRenderItems([{ ...message, id: 'other-server-id', clientId: 'other' }, message]);
    expect(rows.some((entry) => entry.key === row.key)).toBe(true);
    const gallery = collectMobileMessageGalleryImages(rows);
    const current = lightboxImagesForPayload(gallery, opened, row.key, previous, true);
    expect(current).toHaveLength(2);
    expect(current.map((image) => image.groupKey)).toEqual([row.key, row.key]);
    expect(current.map((image) => image.url)).toEqual([
      'cindy-media://blobs/formal-0.jpg', 'cindy-media://blobs/formal-1.jpg',
    ]);
    expect(current.every((image) => image.payload.media.previewable === false)).toBe(true);
    expect(current).not.toEqual(previous);
  });

  it.each(['text only', 'non-image files', 'unreadable replacement'])('does not retain deleted pending images when the source row remains (%s)', (edit) => {
    const previous = collectMobileMessageGalleryImages([pendingItem('pending', [
      { key: 'pending-slot-0:old', uri: 'file:///removed.jpg', ossRef: null, uploading: false },
    ])]);
    const row = pendingItem('pending', edit === 'unreadable replacement' ? [
      { key: 'pending-slot-0:new', uri: null, ossRef: null, uploading: true },
    ] : []);
    row.text = 'edited on another device';
    row.fileCount = edit === 'non-image files' ? 1 : 0;
    const current = collectMobileMessageGalleryImages([row]);
    expect(lightboxImagesForPayload(current, previous[0].payload, row.key, previous, true)).toEqual([]);
    // Actual row departure still preserves the open snapshot during handoff.
    expect(lightboxImagesForPayload([], previous[0].payload, row.key, previous, false, true)).toEqual(previous);
  });

  it.each([false, true])('discards a removed pending message instead of retaining its snapshot (same URL in another message: %s)', (duplicate) => {
    const previous = collectMobileMessageGalleryImages([pendingItem('pending', [
      { key: 'pending-slot-0', uri: 'file:///removed.jpg', ossRef: null, uploading: false },
    ])]);
    const opened = previous[0].payload;
    const current = duplicate ? collectMobileMessageGalleryImages([messageItem('other', {
      attachments: [{ kind: 'image', name: 'same.jpg', uri: opened.media.url, previewable: true }],
    })]) : [];
    expect(lightboxImagesForPayload(current, opened, 'pending', previous, false, false)).toEqual([]);
    // Even with no retained snapshot, the canceled payload must not revive itself as a single image.
    expect(lightboxImagesForPayload(current, opened, 'pending', null, false, false)).toEqual([]);
  });

  it('keeps proven attachment identities in formal history while deduplicating their Markdown reference', () => {
    const previews: SentMessageImagePreviews = new Map();
    const files = ['a', 'b'].map((id) => ({ id, name: `${id}.jpg`, category: 'image' as const,
      path: `cindy-oss-attach://${id}`, sha256: 'c'.repeat(64), size: 100, mimeType: 'image/jpeg', ext: 'jpg' }));
    rememberSentMessageImagePreviews(previews, 's', 'm', files, () => null, (file) => `m-slot-${file.id}`);
    const getPreview: GetSentMessageImagePreview = (...args) => getSentMessageImagePreview(previews, 's', ...args);
    const url = 'https://example.invalid/same.jpg';
    const rows = buildMobileMessageRenderItems([{ id: 'server', clientId: 'm', sessionId: 's', role: 'user',
      toolUseId: null, agentMeta: null, createdAt: '2026-01-01T00:00:00.000Z', content: {
        text: `![body copy](${url})`, images: files.map((file) => ({ name: file.name, sha256: file.sha256, url })),
      } }]);
    const gallery = collectMobileMessageGalleryImages(rows, undefined, undefined, 's', getPreview);
    expect(gallery.map((image) => image.key)).toEqual(['m-slot-a', 'm-slot-b']);
    expect(gallery.every((image) => image.payload.galleryImageKey === image.key)).toBe(true);
  });

  it('does not copy a pending identity to a same-name formal replacement with different pixels', () => {
    const previews: SentMessageImagePreviews = new Map();
    const file = { id: 'old', name: 'same.jpg', category: 'image' as const, path: 'cindy-oss-attach://old',
      sha256: 'a'.repeat(64), size: 100, mimeType: 'image/jpeg', ext: 'jpg' };
    rememberSentMessageImagePreviews(previews, 's', 'm', [file], () => 'file:///old.jpg', () => 'm-slot-old');
    const getPreview: GetSentMessageImagePreview = (...args) => getSentMessageImagePreview(previews, 's', ...args);
    const rows = buildMobileMessageRenderItems([{ id: 'server', clientId: 'm', sessionId: 's', role: 'user',
      toolUseId: null, agentMeta: null, createdAt: '2026-01-01T00:00:00.000Z', content: {
        images: [{ name: file.name, sha256: 'b'.repeat(64), url: 'cindy-media://blobs/new.jpg' }],
      } }]);
    const [replacement] = collectMobileMessageGalleryImages(rows, undefined, undefined, 's', getPreview);
    expect(replacement.key).not.toBe('m-slot-old');
    expect(replacement.previewUri).toBeUndefined();
    expect(replacement.payload.galleryImageKey).toBeUndefined();
  });

  it.each([1, 2])('uses the current pending message when the clicked attachment is replaced (%i images)', (count) => {
    const initialThumbs = Array.from({ length: count }, (_, index) => ({
      key: `pending-slot-${index}:original`, uri: `file:///original-${index}.jpg`, ossRef: null, uploading: false,
    }));
    const initial = collectMobileMessageGalleryImages([pendingItem('pending', initialThumbs)]);
    const clickedIndex = count - 1;
    const clicked = initial[clickedIndex].payload;
    let previous = initial;
    // The original clicked identity remains absent across later queue updates.
    for (const version of ['replacement', 'edited-again']) {
      const current = collectMobileMessageGalleryImages([pendingItem('pending', initialThumbs.map((thumb, index) => (
        index === clickedIndex ? { ...thumb, key: `pending-slot-${index}:${version}`, uri: `file:///${version}.jpg` } : thumb
      )))]);
      previous = lightboxImagesForPayload(current, clicked, 'pending', previous);
      expect(previous).toEqual(current);
    }
    // Once the row leaves, keep the latest gallery rather than resurrecting the originally clicked image.
    const unrelated = collectMobileMessageGalleryImages([pendingItem('other', initialThumbs.map((thumb) => (
      { ...thumb, key: `other:${thumb.key}` }
    )))]);
    expect(lightboxImagesForPayload(unrelated, clicked, 'pending', previous, false, true)).toEqual(previous);
    expect(lightboxImagesForPayload([], clicked, 'pending', previous, false, true)).toEqual(previous);
  });

  it.each(['', ' "title"', " 'title'"])(
    'excludes out-of-workdir Markdown images from neighbor prefetch with title suffix %s', (title) => {
      const outside = 'xdt-file://open?path=%2Fprivate%2Fphoto.png&baseDir=%2F';
      const gallery = collectMobileMessageGalleryImages([messageItem('m1', {
        body: `![ok](https://example.com/ok.png)\n\n![private](${outside}${title})`,
      })], '/repo');
      expect(gallery.map((image) => image.url)).toEqual(['https://example.com/ok.png']);
      // Explicitly clicking the external text chip still opens just that image.
      const url = mobileMarkdownImageUrlForWorkdir(outside, '/repo', 'm1')!;
      const payload = buildMediaPayload({ kind: 'image', url, previewable: false }, 'private');
      if (payload.kind !== 'media') throw new Error('Expected media payload');
      expect(lightboxImagesForPayload(gallery, payload).map((image) => image.url)).toEqual([url]);
    },
  );

  it('binds local gallery pages to the task root and retains their shared preview identity', () => {
    const source = 'xdt-file://open?path=%2Frepo%2Flink%2Fphoto.png&baseDir=%2F';
    const gallery = collectMobileMessageGalleryImages([messageItem('m1', {
      body: `![first](${source} "title")\n\n![second](second.png)`,
    })], '/repo');
    const previewUrl = mobileMarkdownManagedImagePreviewUrl(source, '/repo', 'm1')!;
    expect(gallery[0].url).toBe(previewUrl);
    expect(gallery).toHaveLength(2);
    for (const image of gallery) expect(new URL(image.url).searchParams.getAll('baseDir')).toEqual(['/repo']);
    expect(lightboxImagesForPayload(gallery, gallery[0].payload)).toEqual(gallery);
    expect(collectMobileMessageGalleryImages([messageItem('m1', { body: `![missing context](${source})` })])).toEqual([]);
  });

  it('uses the same SVG file attachment URL as the thumbnail and includes it in the image gallery', () => {
    const gallery = collectMobileMessageGalleryImages([
      messageItem('m-svg', { attachments: [
        { kind: 'file', name: 'diagram.svg', path: '/repo/diagram.svg', previewable: false },
      ] }),
    ], '/repo', 'ssh-host', 'session-1');
    expect(gallery).toHaveLength(1);
    expect(gallery[0].payload.media).toMatchObject({ kind: 'image', previewable: false });
    expect(gallery[0].url).toBe('xdt-file://open?path=%2Frepo%2Fdiagram.svg&sessionId=session-1&remoteHostId=ssh-host&workdir=%2Frepo&v=m-svg');
  });

  it('resolves relative markdown images against the remote session workdir', () => {
    const gallery = collectMobileMessageGalleryImages([
      messageItem('m-local', { body: '![构建图](artifacts/build result.png)' }),
    ], 'C:\\repo');
    expect(gallery).toHaveLength(1);
    expect(gallery[0].url).toBe(
      'xdt-file://open?path=C%3A%5Crepo%5Cartifacts%5Cbuild+result.png&v=m-local&baseDir=C%3A%5Crepo',
    );
    expect(gallery[0].payload).toMatchObject({
      media: { previewable: false },
    });
  });

  it('versions local markdown image urls by message so later references bypass stale media cache', () => {
    const gallery = collectMobileMessageGalleryImages([
      messageItem('m1', { body: '![构建图](artifacts/plot.png)' }),
      messageItem('m2', { body: '![构建图](artifacts/plot.png)' }),
    ], '/repo');

    expect(gallery.map((item) => item.url)).toEqual([
      'xdt-file://open?path=%2Frepo%2Fartifacts%2Fplot.png&v=m1&baseDir=%2Frepo',
      'xdt-file://open?path=%2Frepo%2Fartifacts%2Fplot.png&v=m2&baseDir=%2Frepo',
    ]);
  });

  it('carries SSH host context so remote workdir images do not fall through to desktop local paths', () => {
    const gallery = collectMobileMessageGalleryImages([
      messageItem('m-ssh', { body: '![远端图](artifacts/plot.png)' }),
      messageItem('m-xdt', {
        body: '![已有取件地址](xdt-file://open?path=%2Fhome%2Fu%2Fproj%2Fexisting.png&remoteHostId=forged)',
      }),
    ], '/home/u/proj', 'ssh-host-1', 'session-ssh');

    expect(gallery.map((item) => item.url)).toEqual([
      'xdt-file://open?path=%2Fhome%2Fu%2Fproj%2Fartifacts%2Fplot.png'
        + '&sessionId=session-ssh&remoteHostId=ssh-host-1&workdir=%2Fhome%2Fu%2Fproj&v=m-ssh&baseDir=%2Fhome%2Fu%2Fproj',
      'xdt-file://open?path=%2Fhome%2Fu%2Fproj%2Fexisting.png'
        + '&sessionId=session-ssh&remoteHostId=ssh-host-1&workdir=%2Fhome%2Fu%2Fproj&v=m-xdt&baseDir=%2Fhome%2Fu%2Fproj',
    ]);
  });

  it('collects user image attachments and tool media images and videos in render order', () => {
    const items: MobileMessageRenderItem[] = [
      messageItem('m1', {
        attachments: [
          { kind: 'image', name: 'user.png', uri: 'https://example.com/user.png', previewable: true },
          { kind: 'file', name: 'spec.md', path: '/repo/spec.md', previewable: false },
        ],
      }),
      {
        type: 'tool_group',
        key: 'tools-1',
        tools: [{
          key: 'tool-1',
          source: { clientId: 'tool-1', role: 'tool_use', content: '', createdAt: '2026-01-01T00:00:01.000Z' },
          kind: 'tool',
          role: 'tool_use',
          label: 'Generate',
          body: '',
          align: 'agent',
          createdAt: '2026-01-01T00:00:01.000Z',
          media: [
            { kind: 'image', url: 'xdt-image://cache/tool.png', title: 'tool.png', previewable: false },
            { kind: 'video', url: 'xdt-video://cache/tool.mp4', title: 'tool.mp4', previewable: false },
          ],
        }],
      },
    ] as MobileMessageRenderItem[];

    const gallery = collectMobileMessageGalleryImages(items);

    expect(gallery.map((item) => [item.title, item.url, item.payload.media.previewable])).toEqual([
      ['user.png', 'https://example.com/user.png', true],
      ['tool.png', 'xdt-image://cache/tool.png', false],
      ['tool.mp4', 'xdt-video://cache/tool.mp4', false],
    ]);
    expect(galleryImageIndexForPayload(gallery, gallery[1].payload)).toBe(1);
  });

  it('collects markdown body images (![]() and safe <img>) into the gallery', () => {
    const items: MobileMessageRenderItem[] = [
      messageItem('m1', {
        kind: 'agent',
        role: 'assistant',
        align: 'agent',
        body: [
          '对比如下 ![部署截图](https://example.com/shot.png)',
          '',
          '| 图 | 名 |',
          '| --- | --- |',
          '| <img src="https://example.com/h1.jpg" width="150"> | 房源一 |',
          '',
          '不安全的不收: <img src="javascript:alert(1)">',
        ].join('\n'),
      }),
    ];

    const gallery = collectMobileMessageGalleryImages(items);

    expect(gallery.map((item) => [item.title, item.url, item.payload.media.previewable])).toEqual([
      ['部署截图', 'https://example.com/shot.png', true],
      ['h1.jpg', 'https://example.com/h1.jpg', true],
    ]);
    // MarkdownBody 点击时按 url 构建的 payload 能在图集里定位到,从而获得横滑翻页。
    expect(galleryImageIndexForPayload(gallery, gallery[1].payload)).toBe(1);
  });

  it('skips body images for thinking and tool bodies that render as plain text', () => {
    // thinking / tool_group 的 body 以纯 Text 展示,图片标记不会渲染成图;
    // 收进图集会让 lightbox 翻到聊天里看不到的隐藏页(codex P2)。
    const items: MobileMessageRenderItem[] = [
      { ...messageItem('t1', { body: '思考里引用 ![隐藏图](https://example.com/hidden.png)' }), type: 'thinking' } as MobileMessageRenderItem,
      {
        type: 'tool_group',
        key: 'tools-1',
        tools: [{
          key: 'tool-1',
          source: { clientId: 'tool-1', role: 'tool_use', content: '', createdAt: '2026-01-01T00:00:01.000Z' },
          kind: 'tool',
          role: 'tool_use',
          label: 'Fetch',
          body: '工具正文 ![工具图](https://example.com/tool-body.png)',
          align: 'agent',
          createdAt: '2026-01-01T00:00:01.000Z',
        }],
      } as MobileMessageRenderItem,
      messageItem('m1', { body: '正文图 ![可见图](https://example.com/visible.png)' }),
    ];

    expect(collectMobileMessageGalleryImages(items).map((item) => item.url)).toEqual([
      'https://example.com/visible.png',
    ]);
  });

  it('dedupes markdown body images against attachment urls', () => {
    const items: MobileMessageRenderItem[] = [
      messageItem('m1', {
        attachments: [
          { kind: 'image', name: 'same.png', uri: 'https://example.com/same.png', previewable: true },
        ],
        body: '正文里再引用一次 ![同图](https://example.com/same.png)',
      }),
    ];

    expect(collectMobileMessageGalleryImages(items).map((item) => item.url)).toEqual([
      'https://example.com/same.png',
    ]);
  });

  it('skips body images for orcaCard and systemCard messages (plain-Text render paths)', () => {
    // orcaCard / systemCardType 消息的 body 走 OrcaCollabCard / MobileSystemCard 纯 Text 渲染,
    // 不经 MarkdownBody,正文图片标记在聊天里不可见,不应进图集成为"隐藏页"。
    const items: MobileMessageRenderItem[] = [
      messageItem('m1', {
        kind: 'agent',
        role: 'assistant',
        align: 'agent',
        body: 'worker 回报 ![隐藏图](https://example.com/orca.png)',
        orcaCard: { variant: 'report', title: 'worker 回报', body: 'worker 回报 ![隐藏图](https://example.com/orca.png)' },
      }),
      messageItem('m2', {
        kind: 'agent',
        role: 'assistant',
        align: 'agent',
        body: '![系统卡图](https://example.com/system.png)',
        systemCardType: 'compact',
      }),
      messageItem('m3', {
        kind: 'agent',
        role: 'assistant',
        align: 'agent',
        body: '正常气泡 ![可见图](https://example.com/visible.png)',
      }),
    ];

    expect(collectMobileMessageGalleryImages(items).map((item) => item.url)).toEqual([
      'https://example.com/visible.png',
    ]);
  });

  it('lightbox 翻页只在同一条消息(顶层 render item)内进行,跨轮次不串页(产品 2026-07-08)', () => {
    const items: MobileMessageRenderItem[] = [
      messageItem('m1', {
        attachments: [
          { kind: 'image', name: 'a1.png', uri: 'https://example.com/a1.png', previewable: true },
          { kind: 'image', name: 'a2.png', uri: 'https://example.com/a2.png', previewable: true },
        ],
      }),
      messageItem('m2', {
        attachments: [
          { kind: 'image', name: 'b1.png', uri: 'https://example.com/b1.png', previewable: true },
        ],
      }),
    ];

    const gallery = collectMobileMessageGalleryImages(items);
    expect(gallery).toHaveLength(3);

    // 点开第一条消息的图:图集只含该消息的两张,可翻页。
    const first = lightboxImagesForPayload(gallery, gallery[0].payload);
    expect(first.map((image) => image.url)).toEqual([
      'https://example.com/a1.png',
      'https://example.com/a2.png',
    ]);

    // 点开第二条消息的单图:图集只有它自己,不会翻到上一轮的图。
    const second = lightboxImagesForPayload(gallery, gallery[2].payload);
    expect(second.map((image) => image.url)).toEqual(['https://example.com/b1.png']);

    // 组信息缺失的集合(composer 托盘等自构造来源)保持整集语义。
    const ungrouped = gallery.map(({ groupKey: _groupKey, ...rest }) => rest);
    expect(lightboxImagesForPayload(ungrouped, ungrouped[0].payload)).toHaveLength(3);
  });

  it('同一 url 跨消息各自保留组内 entry;点开重复图退化单图不错开到别的消息(review P2)', () => {
    const items: MobileMessageRenderItem[] = [
      messageItem('m1', {
        attachments: [
          { kind: 'image', name: 'dup.png', uri: 'https://example.com/dup.png', previewable: true },
          { kind: 'image', name: 'a2.png', uri: 'https://example.com/a2.png', previewable: true },
        ],
      }),
      messageItem('m2', {
        attachments: [
          { kind: 'image', name: 'dup.png', uri: 'https://example.com/dup.png', previewable: true },
        ],
      }),
    ];

    const gallery = collectMobileMessageGalleryImages(items);
    // 跨消息不去重:m2 的 dup.png 保有自己的组内 entry。
    expect(gallery.map((image) => [image.groupKey, image.url])).toEqual([
      ['m1', 'https://example.com/dup.png'],
      ['m1', 'https://example.com/a2.png'],
      ['m2', 'https://example.com/dup.png'],
    ]);

    // url 命中多个组 → 无法判定点击来源,保守退化单图,绝不翻到别的消息的图。
    const dup = lightboxImagesForPayload(gallery, gallery[0].payload);
    expect(dup).toHaveLength(1);
    expect(dup[0].url).toBe('https://example.com/dup.png');

    // 未跨组的 url 照常取整组翻页。
    const unique = lightboxImagesForPayload(gallery, gallery[1].payload);
    expect(unique.map((image) => image.url)).toEqual([
      'https://example.com/dup.png',
      'https://example.com/a2.png',
    ]);
  });

  it('同一 url 后来又出现在别的消息里,按点击来源仍翻原消息的整组(不再退化单图)', () => {
    const items: MobileMessageRenderItem[] = [
      messageItem('m1', {
        attachments: [
          { kind: 'image', name: 'shot.png', uri: 'xdt-image://cache/shot.png', previewable: false },
          { kind: 'image', name: 'b.png', uri: 'xdt-image://cache/b.png', previewable: false },
        ],
      }),
      // 之后 Agent 读同一个文件,工具结果里又出现同一张图。
      messageItem('m2', {
        media: [{ kind: 'image', url: 'xdt-image://cache/shot.png', title: 'shot.png', previewable: false }],
      }),
    ];
    const gallery = collectMobileMessageGalleryImages(items);
    const shot = gallery[0].payload;

    expect(lightboxImagesForPayload(gallery, shot, 'm1').map((image) => image.url)).toEqual([
      'xdt-image://cache/shot.png',
      'xdt-image://cache/b.png',
    ]);
    expect(lightboxImagesForPayload(gallery, shot, 'm2').map((image) => image.url)).toEqual([
      'xdt-image://cache/shot.png',
    ]);
    // 来源不在图集里 / 没有来源:按 url 反查,多组命中仍保守退化单图。
    expect(lightboxImagesForPayload(gallery, shot, 'unknown')).toHaveLength(1);
    expect(lightboxImagesForPayload(gallery, shot)).toHaveLength(1);
  });

  it('回合结束后「工作过程」嵌套分组里的工具图仍在图集里,点开照常翻页', () => {
    const row = (i: number, role: string, content: unknown, toolUseId?: string): RemoteMessage => ({
      id: `r${i}`, clientId: `r${i}`, sessionId: 's', role, content, toolUseId,
      createdAt: `2026-01-01T00:00:${String(i).padStart(2, '0')}Z`, agentMeta: null,
    } as RemoteMessage);
    const rows: RemoteMessage[] = [row(0, 'user', 'make images')];
    let n = 1;
    for (let k = 0; k < 5; k++) {
      rows.push(row(n++, 'tool_use', { toolName: 'gen', toolUseId: `u${k}`, input: {} }, `u${k}`));
      rows.push(row(n++, 'tool_result', JSON.stringify({ xdt_image_url: `xdt-image://cache/img${k}.png` }), `u${k}`));
      if (k === 1) rows.push(row(n++, 'assistant', 'Two are done, continuing with the remaining three images now.'));
    }
    rows.push(row(n++, 'assistant', 'All five images are ready.'));
    const later = ['xdt-image://cache/img2.png', 'xdt-image://cache/img3.png', 'xdt-image://cache/img4.png'];

    for (const isSessionStreaming of [true, false]) {
      const items = buildMobileMessageRenderItems(rows, { isSessionStreaming });
      const gallery = collectMobileMessageGalleryImages(items);
      const block = items.find((item) => item.type === 'tool_media' && item.tools.some(
        (tool) => tool.media?.some((media) => media.url === later[0]),
      ))!;
      // 每个 url 只属于一个组(工具媒体块不另收),url 反查不会因多组命中而退化单图。
      expect(gallery.filter((image) => image.url === later[0])).toHaveLength(1);
      const entry = gallery.find((image) => image.url === later[0])!;
      // 从独立的工具媒体块点开:来源不在图集里,按 url 找回所属的工作过程组。
      expect(lightboxImagesForPayload(gallery, entry.payload, block.key).map((image) => image.url)).toEqual(later);
      // 从展开的「工作过程」点开。
      expect(lightboxImagesForPayload(gallery, entry.payload, entry.groupKey).map((image) => image.url)).toEqual(later);
    }

    // 查看器打开期间回合结束重组:流式时记下的来源 key 在结束后的图集里已不存在,
    // 仍按 url 找回同一组,不退化单图(review P1)。
    const streamingGallery = collectMobileMessageGalleryImages(buildMobileMessageRenderItems(rows, { isSessionStreaming: true }));
    const streamingKey = streamingGallery.find((image) => image.url === later[0])!.groupKey!;
    const settledGallery = collectMobileMessageGalleryImages(buildMobileMessageRenderItems(rows, { isSessionStreaming: false }));
    expect(settledGallery.some((image) => image.groupKey === streamingKey)).toBe(false);
    const settled = settledGallery.find((image) => image.url === later[0])!;
    expect(lightboxImagesForPayload(settledGallery, settled.payload, streamingKey).map((image) => image.url)).toEqual(later);
  });

  it('收同一条消息里的视频,与图片一起翻页', () => {
    const items: MobileMessageRenderItem[] = [
      messageItem('m1', {
        attachments: [
          { kind: 'image', name: 'a.png', uri: 'https://example.com/a.png', previewable: true },
        ],
        media: [{ kind: 'video', url: 'xdt-video://cache/clip.mp4', title: 'clip.mp4', previewable: false }],
      }),
      messageItem('m2', {
        attachments: [
          { kind: 'image', name: 'b.png', uri: 'https://example.com/b.png', previewable: true },
        ],
      }),
    ];
    const gallery = collectMobileMessageGalleryImages(items);
    const clip = gallery.find((image) => image.payload.media.kind === 'video')!;
    expect(lightboxImagesForPayload(gallery, clip.payload, 'm1').map((image) => image.url)).toEqual([
      'https://example.com/a.png',
      'xdt-video://cache/clip.mp4',
    ]);
  });

  it('walks folded work groups and drops duplicate image urls', () => {
    const items: MobileMessageRenderItem[] = [{
      type: 'work_group',
      key: 'work-1',
      children: [
        messageItem('child-1', {
          attachments: [
            { kind: 'image', name: 'same-a.png', uri: 'https://example.com/same.png', previewable: true },
          ],
        }) as Extract<MobileMessageRenderItem, { type: 'message' }>,
        messageItem('child-2', {
          attachments: [
            { kind: 'image', name: 'same-b.png', uri: 'https://example.com/same.png', previewable: true },
            { kind: 'image', name: 'other.png', uri: 'https://example.com/other.png', previewable: true },
          ],
        }) as Extract<MobileMessageRenderItem, { type: 'message' }>,
      ],
    }];

    expect(collectMobileMessageGalleryImages(items).map((item) => item.url)).toEqual([
      'https://example.com/same.png',
      'https://example.com/other.png',
    ]);
  });
  it('carries the sent local image as the viewer backdrop once the host has rewritten the url', () => {
    const calls: unknown[][] = [];
    const gallery = collectMobileMessageGalleryImages([
      messageItem('m-sent', { attachments: [
        { kind: 'file', name: 'notes.md', path: '/repo/notes.md', previewable: false },
        { kind: 'image', name: 'a.png', uri: 'xdt-image://cache/a.png', previewable: false },
        { kind: 'image', name: 'b.png', uri: 'xdt-image://cache/b.png', previewable: false, sha256: 'sha-b' },
      ] }),
    ], undefined, undefined, undefined, (...args) => {
      calls.push(args);
      return args[1] === 1
        ? { attachmentId: 'att-b', name: 'b.png', sourceRef: 'cindy-oss-attach://b', sha256: 'sha-b', uri: 'file:///local/b.jpg' }
        : undefined;
    });
    // 预览按「第几张图片附件」对位,与气泡 AttachmentStrip 同口径(文件附件不占位)。
    expect(calls.map((args) => args.slice(0, 3))).toEqual([['m-sent', 0, 'a.png'], ['m-sent', 1, 'b.png']]);
    expect(gallery.map((image) => [image.url, image.previewUri])).toEqual([
      ['xdt-image://cache/a.png', undefined],
      ['xdt-image://cache/b.png', 'file:///local/b.jpg'],
    ]);
  });

  it('prefers the persisted local copy over the outbox file that is cleaned up after delivery', () => {
    durableThumbs.set('cindy-oss-attach://b', 'file:///documents/sent-attachment-thumbs/b.jpg');
    try {
      const gallery = collectMobileMessageGalleryImages([
        messageItem('m-sent', { attachments: [
          { kind: 'image', name: 'b.png', uri: 'xdt-image://cache/b.png', previewable: false },
        ] }),
      ], undefined, undefined, undefined, () => (
        { attachmentId: 'att-b', name: 'b.png', sourceRef: 'cindy-oss-attach://b', uri: 'file:///outbox/b.jpg' }
      ));
      expect(gallery[0].previewUri).toBe('file:///documents/sent-attachment-thumbs/b.jpg');
    } finally {
      durableThumbs.clear();
    }
  });
});
