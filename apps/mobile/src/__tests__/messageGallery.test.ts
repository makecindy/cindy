import { describe, expect, it } from 'vitest';
import {
  collectMobileMessageGalleryImages,
  galleryImageIndexForPayload,
  lightboxImagesForPayload,
} from '@/session/messageGallery';
import type { MobileMessageRenderItem } from '@/session/messageRenderModel';

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

describe('message gallery', () => {
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
      'xdt-file://open?path=C%3A%5Crepo%5Cartifacts%5Cbuild%20result.png&v=m-local',
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
      'xdt-file://open?path=%2Frepo%2Fartifacts%2Fplot.png&v=m1',
      'xdt-file://open?path=%2Frepo%2Fartifacts%2Fplot.png&v=m2',
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
        + '&sessionId=session-ssh&remoteHostId=ssh-host-1&workdir=%2Fhome%2Fu%2Fproj&v=m-ssh',
      'xdt-file://open?path=%2Fhome%2Fu%2Fproj%2Fexisting.png'
        + '&sessionId=session-ssh&remoteHostId=ssh-host-1&workdir=%2Fhome%2Fu%2Fproj&v=m-xdt',
    ]);
  });

  it('collects user image attachments and tool media images in render order', () => {
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
});
