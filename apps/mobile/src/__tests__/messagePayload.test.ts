import { beforeAll, describe, expect, it } from 'vitest';
import { i18n } from '@/i18n';
import {
  buildAttachmentPayload,
  buildDiffPayload,
  buildMediaPayload,
  buildMermaidPayload,
  buildToolResultPayload,
  formatDiffPayload,
  formatDiffPayloadRows,
  formatDiffPayloadView,
  formatMediaActionNotice,
  isPayloadDesktopLocalMediaUrl,
  isPayloadDirectPreviewableUrl,
  payloadMediaKindLabel,
  summarizeMessagePayloadBody,
  summarizeMessagePayloadPreview,
} from '@/session/messagePayload';
import type { NormalizedRemoteMessage } from '@/session/messageNormalize';

// 文案已 i18n 化;固定 zh-CN 让字面量断言与语言环境解耦(全局 mock 默认 en-US)。
beforeAll(async () => {
  await i18n.changeLanguage('zh-CN');
});

describe('messagePayload', () => {
  it('formats full diff payloads without losing later segments', () => {
    const diff = {
      filePath: '/repo/app.ts',
      insertions: 3,
      deletions: 2,
      segments: [
        { key: 'edit:0', oldString: 'old A\nold B', newString: 'new A' },
        { key: 'edit:1', oldString: '', newString: 'new C\nnew D', label: 'Second edit' },
      ],
    };

    expect(formatDiffPayload(diff)).toBe(
      '/repo/app.ts\n\n'
      + '+3 / -2 行\n\n'
      + 'Edit 1/2\n'
      + '- old A\n'
      + '- old B\n'
      + '+ new A\n\n'
      + 'Second edit\n'
      + '+ new C\n'
      + '+ new D',
    );

    expect(buildDiffPayload(diff)).toMatchObject({
      kind: 'diff',
      title: '/repo/app.ts',
      body: expect.stringContaining('Second edit'),
    });

    expect(formatDiffPayloadRows(diff).map((row) => [row.kind, row.text])).toEqual([
      ['header', '/repo/app.ts'],
      ['stats', '+3 / -2 行'],
      ['segment', 'Edit 1/2'],
      ['delete', '- old A'],
      ['delete', '- old B'],
      ['add', '+ new A'],
      ['segment', 'Second edit'],
      ['add', '+ new C'],
      ['add', '+ new D'],
    ]);

    expect(formatDiffPayloadView(diff)).toEqual({
      filePath: '/repo/app.ts',
      stats: '+3 / -2 行',
      sections: [
        {
          key: 'edit:0',
          label: 'Edit 1/2',
          oldLines: [
            { key: 'edit:0:old:0', lineNumber: 1, text: 'old A' },
            { key: 'edit:0:old:1', lineNumber: 2, text: 'old B' },
          ],
          newLines: [
            { key: 'edit:0:new:0', lineNumber: 1, text: 'new A' },
          ],
        },
        {
          key: 'edit:1',
          label: 'Second edit',
          oldLines: [],
          newLines: [
            { key: 'edit:1:new:0', lineNumber: 1, text: 'new C' },
            { key: 'edit:1:new:1', lineNumber: 2, text: 'new D' },
          ],
        },
      ],
    });
  });

  it('builds full tool-result payloads from normalized tool messages', () => {
    const payload = buildToolResultPayload({
      key: 'read',
      kind: 'tool',
      role: 'tool_use',
      label: 'Read',
      body: 'Read(/repo/app.ts)',
      secondaryBody: 'line 1\nline 2\nline 3',
      align: 'agent',
      createdAt: '2026-01-01T00:00:00.000Z',
      source: {
        id: 'read',
        clientId: 'read',
        sessionId: 's1',
        role: 'tool_use',
        toolUseId: 'read',
        content: {},
        agentMeta: null,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    } satisfies NormalizedRemoteMessage);

    expect(payload).toEqual({
      kind: 'text',
      title: 'Read 输出',
      body: 'line 1\nline 2\nline 3',
    });
  });

  it('keeps remote media as a pending mobile resolver payload', () => {
    const payload = buildMediaPayload({
      kind: 'image',
      url: 'xdt-image://lizi-art-media-images/a.png',
      previewable: false,
    }, 'a.png');
    expect(payload).toMatchObject({
      kind: 'media',
      title: 'a.png',
      body: expect.stringContaining('移动端会尝试从远程电脑取回媒体'),
    });
    expect(summarizeMessagePayloadBody(payload).media).toMatchObject({
      kindLabel: '图片',
      needsRemoteFetch: true,
      canInlineDirectImage: false,
    });

    expect(buildAttachmentPayload({
      kind: 'image',
      name: 'photo.png',
      previewable: true,
      uri: 'data:image/png;base64,aaa',
    })).toMatchObject({
      kind: 'media',
      media: {
        kind: 'image',
        title: 'photo.png',
        url: 'data:image/png;base64,aaa',
      },
      title: 'photo.png',
    });
    expect(summarizeMessagePayloadBody(buildAttachmentPayload({
      kind: 'image',
      name: 'photo.png',
      previewable: true,
      uri: 'data:image/png;base64,aaa',
    }))).toMatchObject({
      bodyText: '内联图片数据 · PNG · 2 B',
      media: {
        canInlineDirectImage: true,
        directPreviewable: true,
      },
    });
    expect(summarizeMessagePayloadPreview(buildAttachmentPayload({
      kind: 'image',
      name: 'photo.png',
      previewable: true,
      uri: 'data:image/png;base64,aaa',
    }))).toMatchObject({
      previewText: '内联图片数据 · PNG · 2 B',
    });

    expect(buildAttachmentPayload({
      kind: 'file',
      name: 'spec.md',
      path: '/repo/spec.md',
      previewable: false,
    })).toEqual({
      kind: 'file',
      title: 'spec.md',
      body: '/repo/spec.md',
      sourcePath: '/repo/spec.md',
    });

    expect(buildAttachmentPayload({
      kind: 'file',
      name: 'voice.ogg',
      path: 'cindy-media://blobs/aa11bb22.ogg',
      mimeType: 'audio/ogg',
      previewable: false,
    })).toMatchObject({
      kind: 'media',
      media: {
        kind: 'audio',
        previewable: false,
        url: 'cindy-media://blobs/aa11bb22.ogg',
      },
    });
  });

  it('surfaces desktop media actions as read-only mobile guidance', () => {
    const media = {
      kind: 'image' as const,
      url: 'xdt-image://lizi-art-media-images/a.png',
      previewable: false,
      actions: {
        provider: 'mivo' as const,
        jobId: 'job-1',
        buttons: [
          { customId: 'MJ::JOB::upsample::1::abc' },
          { customId: 'MJ::JOB::variation::2::abc', label: 'V2' },
        ],
      },
    };

    expect(formatMediaActionNotice(media)).toBe([
      '桌面端为这个媒体提供了后续操作。',
      '可用操作：U1 / V2',
      '手机版 V1 只安全展示这些操作，暂不远程触发。请回到电脑端点击。',
    ].join('\n'));
    expect(buildMediaPayload(media, 'a.png').body).toContain('可用操作：U1 / V2');
  });

  it('builds full Mermaid source payloads', () => {
    expect(buildMermaidPayload('graph TD\nA --> B')).toEqual({
      kind: 'mermaid',
      title: 'Mermaid 图表源码',
      body: 'graph TD\nA --> B',
    });
  });

  it('exposes shared payload body presentation through the mobile adapter', () => {
    const payload = buildMediaPayload({
      kind: 'video',
      url: 'https://example.com/video.mp4',
      previewable: true,
    }, 'video.mp4');

    expect(summarizeMessagePayloadBody(payload).media).toMatchObject({
      canDirectOpen: true,
      canInlineDirectPlayer: true,
      kindLabel: '视频',
    });
    expect(summarizeMessagePayloadPreview(payload)).toMatchObject({
      actionKind: 'open-url',
      actionLabel: '预览媒体',
      canInlinePreview: true,
      detail: '可直接预览',
      severity: 'neutral',
    });
    expect(payloadMediaKindLabel('audio')).toBe('音频');
    expect(isPayloadDesktopLocalMediaUrl('xdt-file://artifact')).toBe(true);
    expect(isPayloadDirectPreviewableUrl('https://example.com/image.png')).toBe(true);
  });
});
