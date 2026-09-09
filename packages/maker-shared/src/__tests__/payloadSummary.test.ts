import { describe, expect, it } from 'vitest';
import {
  buildAttachmentPayload,
  buildDiffPayload,
  buildFilePayload,
  buildMediaPayload,
  buildMermaidPayload,
  buildPayloadToolDiff,
  buildTextPayload,
  extractPayloadToolResultMedia,
  formatDiffPayload,
  formatDiffPayloadRows,
  formatDiffPayloadView,
  formatMediaActionNotice,
  formatPayloadToolUseSummary,
  isPayloadDesktopLocalMediaUrl,
  isPayloadDirectPreviewableUrl,
  payloadMediaKindLabel,
  summarizeMessagePayloadBody,
  summarizeMessagePayloadPreview,
  summarizeMessagePayload,
  type PayloadToolDiffLike,
} from '../payloadSummary';

describe('payloadSummary', () => {
  const diff: PayloadToolDiffLike = {
    filePath: '/repo/app.ts',
    insertions: 3,
    deletions: 2,
    segments: [
      { key: 'edit:0', oldString: 'old A\nold B', newString: 'new A' },
      { key: 'edit:1', oldString: '', newString: 'new C\nnew D', label: 'Second edit' },
    ],
  };

  it('formats full diff payloads and stable compare sections', () => {
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

  it('projects desktop tool inputs into summaries and diff payloads', () => {
    expect(formatPayloadToolUseSummary('Read', { file_path: '/repo/src/app.ts' })).toBe(
      'Read(/repo/src/app.ts)',
    );
    expect(formatPayloadToolUseSummary('Bash', {
      command: 'pnpm --filter mobile test -- --runInBand --very-long-argument',
    })).toBe('Bash(pnpm --filter mobile test -- --runInBand --very-long-argu...)');
    expect(formatPayloadToolUseSummary('UnknownTool', { value: 'x' })).toBe('UnknownTool()');

    expect(buildPayloadToolDiff('Edit', {
      file_path: '/repo/app.ts',
      old_string: 'old A\nold B',
      new_string: 'new A',
    })).toEqual({
      deletions: 2,
      filePath: '/repo/app.ts',
      insertions: 1,
      segments: [{ key: 'edit:0', oldString: 'old A\nold B', newString: 'new A' }],
    });

    expect(buildPayloadToolDiff('Write', {
      file_path: '/repo/new.ts',
      content: 'line A\nline B',
    })).toEqual({
      deletions: 0,
      filePath: '/repo/new.ts',
      insertions: 2,
      segments: [{ key: 'write:0', oldString: '', newString: 'line A\nline B' }],
    });

    expect(buildPayloadToolDiff('MultiEdit', {
      file_path: '/repo/app.ts',
      edits: [
        { old_string: 'a', new_string: 'b' },
        { old_string: '', new_string: 'c\nd' },
      ],
    })).toEqual({
      deletions: 1,
      filePath: '/repo/app.ts',
      insertions: 3,
      segments: [
        { key: 'edit:0', oldString: 'a', newString: 'b', label: 'Edit 1/2' },
        { key: 'edit:1', oldString: '', newString: 'c\nd', label: 'Edit 2/2' },
      ],
    });

    expect(buildPayloadToolDiff('Read', { file_path: '/repo/app.ts' })).toBeUndefined();
    expect(buildPayloadToolDiff('Edit', { old_string: 'a', new_string: 'b' })).toBeUndefined();
  });

  it('builds pi edit diffs from both the declared edits[] and the legacy top-level shape', () => {
    // 声明 schema 形态:{ path, edits: [{ oldText, newText }] }。
    expect(buildPayloadToolDiff('edit', {
      path: '/repo/app.ts',
      edits: [
        { oldText: 'a', newText: 'b' },
        { oldText: '', newText: 'c\nd' },
      ],
    })).toEqual({
      deletions: 1,
      filePath: '/repo/app.ts',
      insertions: 3,
      segments: [
        { key: 'edit:0', oldString: 'a', newString: 'b', label: 'Edit 1/2' },
        { key: 'edit:1', oldString: '', newString: 'c\nd', label: 'Edit 2/2' },
      ],
    });

    // legacy 顶层单段:{ path, oldText, newText } —— 必须产出真实 diff 而非空段。
    expect(buildPayloadToolDiff('edit', {
      path: '/repo/app.ts',
      oldText: 'old A\nold B',
      newText: 'new A',
    })).toEqual({
      deletions: 2,
      filePath: '/repo/app.ts',
      insertions: 1,
      segments: [{ key: 'edit:0', oldString: 'old A\nold B', newString: 'new A' }],
    });

    // pi write 用 path + content。
    expect(buildPayloadToolDiff('write', {
      path: '/repo/new.ts',
      content: 'line A\nline B',
    })).toEqual({
      deletions: 0,
      filePath: '/repo/new.ts',
      insertions: 2,
      segments: [{ key: 'write:0', oldString: '', newString: 'line A\nline B' }],
    });
  });

  it('summarizes payload chrome data without UI dependencies', () => {
    expect(summarizeMessagePayload(buildDiffPayload(diff))).toEqual({
      kind: 'diff',
      kindLabel: 'DIFF',
      title: '/repo/app.ts',
      subtitle: '+3 / -2 行',
      copyableText: expect.stringContaining('Second edit'),
      sourcePath: '/repo/app.ts',
      openTarget: { kind: 'file', value: '/repo/app.ts' },
    });

    expect(summarizeMessagePayload(buildFilePayload('spec.md', '/repo/spec.md'))).toMatchObject({
      kind: 'file',
      kindLabel: 'FILE',
      title: 'spec.md',
      subtitle: '/repo/spec.md',
      sourcePath: '/repo/spec.md',
      openTarget: { kind: 'file', value: '/repo/spec.md' },
    });

    expect(summarizeMessagePayload(buildMermaidPayload('graph TD\nA --> B'))).toMatchObject({
      kind: 'mermaid',
      kindLabel: 'MERMAID',
      subtitle: '图表源码',
    });

    expect(summarizeMessagePayload(buildTextPayload('Read 输出', 'line 1'))).toMatchObject({
      kind: 'text',
      kindLabel: 'TEXT',
      copyableText: 'line 1',
    });
  });

  it('summarizes payload body presentation without native UI dependencies', () => {
    expect(summarizeMessagePayloadBody(buildDiffPayload(diff))).toMatchObject({
      bodyText: expect.stringContaining('Second edit'),
      diff: {
        filePath: '/repo/app.ts',
        sectionCount: 2,
        stats: '+3 / -2 行',
      },
      kind: 'diff',
      textMonospace: true,
    });

    expect(summarizeMessagePayloadBody(buildFilePayload('spec.md', '/repo/spec.md'))).toMatchObject({
      bodyText: '/repo/spec.md',
      file: {
        displayPath: '/repo/spec.md',
        sourcePath: '/repo/spec.md',
      },
      kind: 'file',
      textMonospace: true,
    });

    expect(summarizeMessagePayloadBody(buildMermaidPayload('graph TD\nA --> B'))).toMatchObject({
      bodyText: 'graph TD\nA --> B',
      emptyText: '空 Mermaid 图表。',
      kind: 'mermaid',
      mermaid: { source: 'graph TD\nA --> B' },
      textMonospace: true,
    });

    expect(summarizeMessagePayloadBody(buildTextPayload('Read 输出', 'line 1'))).toEqual({
      bodyText: 'line 1',
      emptyText: '没有可展示的文本内容。',
      kind: 'text',
      textMonospace: false,
    });
  });

  it('projects payload previews with severity and primary actions', () => {
    expect(summarizeMessagePayloadPreview(buildDiffPayload(diff))).toMatchObject({
      actionKind: 'view',
      actionLabel: '查看 diff',
      canInlinePreview: false,
      detail: '/repo/app.ts · +3 / -2 行',
      kind: 'diff',
      meta: ['+3 / -2 行', '2 处编辑'],
      needsRemoteFetch: false,
      previewText: expect.stringContaining('- old A'),
      severity: 'info',
      shouldUseMonospacePreview: true,
      title: '/repo/app.ts',
    });

    expect(summarizeMessagePayloadPreview(buildFilePayload('missing.txt', ''))).toMatchObject({
      actionKind: 'view',
      actionLabel: '查看详情',
      detail: '没有远程路径',
      kind: 'file',
      meta: ['缺少远程路径'],
      severity: 'warning',
    });

    expect(summarizeMessagePayloadPreview(buildMermaidPayload('graph TD\nA --> B'))).toMatchObject({
      actionLabel: '查看图表',
      canInlinePreview: true,
      detail: 'Mermaid 图表源码',
      shouldUseMonospacePreview: true,
    });

    expect(summarizeMessagePayloadPreview(buildTextPayload('Read 输出', 'line 1'), { maxPreviewChars: 24 })).toMatchObject({
      actionKind: 'view',
      actionLabel: '查看内容',
      detail: '文本输出',
      previewText: 'line 1',
      severity: 'neutral',
    });
  });

  it('keeps remote media action guidance model-side', () => {
    const media = {
      kind: 'image' as const,
      url: 'xdt-image://lizi-art-media-images/a.png',
      previewable: false,
      actions: {
        provider: 'mivo',
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

    const payload = buildMediaPayload(media, 'a.png');
    expect(payload.body).toContain('可用操作：U1 / V2');
    expect(summarizeMessagePayload(payload)).toEqual({
      kind: 'media',
      kindLabel: 'IMAGE',
      title: 'a.png',
      subtitle: '需要远程取件',
      copyableText: 'xdt-image://lizi-art-media-images/a.png',
      openTarget: undefined,
    });
    expect(summarizeMessagePayloadBody(payload).media).toMatchObject({
      canDirectOpen: false,
      canInlineDirectImage: false,
      directPreviewable: false,
      kindLabel: '图片',
      needsRemoteFetch: true,
      placeholderText: '正在准备远程媒体取件',
    });
    expect(summarizeMessagePayloadPreview(payload)).toMatchObject({
      actionKind: 'fetch-remote-media',
      actionLabel: '取回媒体',
      detail: '需要从电脑端取回媒体',
      meta: ['图片', '待取件'],
      needsRemoteFetch: true,
      severity: 'info',
    });
  });

  it('projects mobile attachments into shared payloads', () => {
    expect(buildAttachmentPayload({
      kind: 'image',
      name: 'photo.png',
      previewable: true,
      uri: 'data:image/png;base64,aaa',
    })).toEqual({
      body: 'data:image/png;base64,aaa',
      kind: 'media',
      media: {
        kind: 'image',
        previewable: true,
        title: 'photo.png',
        url: 'data:image/png;base64,aaa',
      },
      title: 'photo.png',
    });
    expect(summarizeMessagePayload(buildAttachmentPayload({
      kind: 'image',
      name: 'photo.png',
      previewable: true,
      uri: 'data:image/png;base64,aaa',
    }))).toMatchObject({
      copyableText: 'data:image/png;base64,aaa',
      openTarget: { kind: 'url', value: 'data:image/png;base64,aaa' },
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
      body: '/repo/spec.md',
      kind: 'file',
      sourcePath: '/repo/spec.md',
      title: 'spec.md',
    });

    expect(buildAttachmentPayload({
      kind: 'file',
      name: 'clip.mp4',
      path: 'cindy-media://blobs/aa11bb22.mp4',
      mimeType: 'video/mp4',
      previewable: false,
    })).toMatchObject({
      kind: 'media',
      media: {
        kind: 'video',
        previewable: false,
        title: 'clip.mp4',
        url: 'cindy-media://blobs/aa11bb22.mp4',
      },
      title: 'clip.mp4',
    });
    expect(summarizeMessagePayloadBody(buildAttachmentPayload({
      kind: 'file',
      name: 'voice.ogg',
      path: 'cindy-media://blobs/cc33dd44.ogg',
      mimeType: 'audio/ogg; codecs=opus',
      previewable: false,
    })).media).toMatchObject({
      kindLabel: '音频',
      needsRemoteFetch: true,
    });

    expect(summarizeMessagePayloadPreview(buildAttachmentPayload({
      kind: 'file',
      name: 'missing.txt',
      previewable: false,
    }))).toMatchObject({
      actionKind: 'view',
      detail: '没有远程路径',
      severity: 'warning',
    });
  });

  it('extracts structured media from desktop tool results', () => {
    const media = extractPayloadToolResultMedia(JSON.stringify({
      xdt_image_url: 'xdt-image://lizi-art-media-images/cover.png',
      xdt_image_urls: [
        'xdt-image://lizi-art-media-images/cover.png',
        'xdt-image://lizi-art-media-images/variant.png',
      ],
      xdt_video_urls: ['xdt-video://lizi-art-media-videos/v.mp4'],
      _xdt_audio_tracks: [
        { title: 'Narration', xdt_audio_url: 'xdt-audio://lizi-art-media-audio/a.mp3' },
      ],
      _xdt_actions: {
        provider: 'mivo',
        jobId: 'job-1',
        buttons: [
          { customId: 'MJ::JOB::upsample::1::abc', label: 'U1' },
          { customId: 'MJ::JOB::variation::2::abc', emoji: 'V2' },
        ],
      },
    }));

    expect(media).toEqual([
      {
        actions: {
          buttons: [
            { customId: 'MJ::JOB::upsample::1::abc', label: 'U1', emoji: undefined },
            { customId: 'MJ::JOB::variation::2::abc', label: undefined, emoji: 'V2' },
          ],
          jobId: 'job-1',
          provider: 'mivo',
        },
        kind: 'image',
        previewable: false,
        title: undefined,
        url: 'xdt-image://lizi-art-media-images/cover.png',
      },
      {
        actions: {
          buttons: [
            { customId: 'MJ::JOB::upsample::1::abc', label: 'U1', emoji: undefined },
            { customId: 'MJ::JOB::variation::2::abc', label: undefined, emoji: 'V2' },
          ],
          jobId: 'job-1',
          provider: 'mivo',
        },
        kind: 'image',
        previewable: false,
        title: undefined,
        url: 'xdt-image://lizi-art-media-images/variant.png',
      },
      {
        actions: {
          buttons: [
            { customId: 'MJ::JOB::upsample::1::abc', label: 'U1', emoji: undefined },
            { customId: 'MJ::JOB::variation::2::abc', label: undefined, emoji: 'V2' },
          ],
          jobId: 'job-1',
          provider: 'mivo',
        },
        kind: 'video',
        previewable: false,
        title: undefined,
        url: 'xdt-video://lizi-art-media-videos/v.mp4',
      },
      {
        kind: 'audio',
        previewable: false,
        title: 'Narration',
        url: 'xdt-audio://lizi-art-media-audio/a.mp3',
      },
    ]);

    expect(extractPayloadToolResultMedia(JSON.stringify({
      _xdt_render_image: false,
      xdt_image_url: 'xdt-image://hidden.png',
    }))).toEqual([]);
    expect(extractPayloadToolResultMedia('not json xdt_image_url')).toEqual([]);
  });

  it('extracts ghost-world audio tracks (xdt_audio_tracks + cindy-media,意识 xd-mivo 链路)', () => {
    const media = extractPayloadToolResultMedia(JSON.stringify({
      xdt_audio_tracks: [
        { kind: 'music', title: '雨后城市', xdt_audio_url: 'cindy-media://blobs/aa.mp3' },
        { kind: 'music', title: '坏协议', xdt_audio_url: 'https://evil.example/x.mp3' },
      ],
    }));
    expect(media).toEqual([
      { kind: 'audio', previewable: false, title: '雨后城市', url: 'cindy-media://blobs/aa.mp3' },
    ]);
    // fallback 数组同样双协议。
    expect(extractPayloadToolResultMedia(JSON.stringify({
      xdt_audio_urls: ['cindy-media://blobs/bb.mp3', 'file:///etc/x.mp3'],
    }))).toEqual([
      { kind: 'audio', previewable: false, title: undefined, url: 'cindy-media://blobs/bb.mp3' },
    ]);
  });

  it('extracts cindy-media blob URLs from tool results (媒体总仓迁移后的新地址形态)', () => {
    const media = extractPayloadToolResultMedia(JSON.stringify({
      xdt_image_url: 'cindy-media://blobs/aa11bb22cc33.png',
      xdt_image_urls: ['cindy-media://blobs/dd44ee55ff66.webp'],
      xdt_video_urls: ['cindy-media://blobs/1122334455aa.mp4'],
    }));
    expect(media).toEqual([
      {
        kind: 'image',
        previewable: false,
        title: undefined,
        url: 'cindy-media://blobs/aa11bb22cc33.png',
      },
      {
        kind: 'image',
        previewable: false,
        title: undefined,
        url: 'cindy-media://blobs/dd44ee55ff66.webp',
      },
      {
        kind: 'video',
        previewable: false,
        title: undefined,
        url: 'cindy-media://blobs/1122334455aa.mp4',
      },
    ]);
    // 非托管协议仍然被过滤,不放行任意 scheme
    expect(extractPayloadToolResultMedia(JSON.stringify({
      xdt_image_url: 'file:///etc/passwd',
      xdt_image_urls: ['javascript:alert(1)'],
    }))).toEqual([]);
  });

  it('classifies direct payload media URLs for mobile viewer decisions', () => {
    const image = buildMediaPayload({
      kind: 'image',
      previewable: true,
      url: 'https://example.com/a.png',
    }, 'a.png');
    expect(summarizeMessagePayloadBody(image).media).toMatchObject({
      canDirectOpen: true,
      canInlineDirectImage: true,
      canInlineDirectPlayer: false,
      directPreviewable: true,
      kindLabel: '图片',
      needsRemoteFetch: false,
    });
    expect(summarizeMessagePayloadPreview(image)).toMatchObject({
      actionKind: 'open-url',
      actionLabel: '预览媒体',
      canInlinePreview: true,
      detail: '可直接预览',
      meta: ['图片', '可预览'],
      severity: 'neutral',
    });

    const video = buildMediaPayload({
      kind: 'video',
      previewable: true,
      url: 'https://example.com/a.mp4',
    }, 'a.mp4');
    expect(summarizeMessagePayloadBody(video).media).toMatchObject({
      canInlineDirectImage: false,
      canInlineDirectPlayer: true,
      kindLabel: '视频',
    });

    expect(payloadMediaKindLabel('audio')).toBe('音频');
    expect(isPayloadDesktopLocalMediaUrl('xdt-audio://track')).toBe(true);
    // 媒体总仓 blob 地址走 remote-media resolver 取件,同属"桌面端本机媒体"
    expect(isPayloadDesktopLocalMediaUrl('cindy-media://blobs/aa11bb22.png')).toBe(true);
    expect(isPayloadDirectPreviewableUrl('cindy-media://blobs/aa11bb22.png')).toBe(false);
    expect(isPayloadDirectPreviewableUrl('data:image/png;base64,aaa')).toBe(true);
  });
});
