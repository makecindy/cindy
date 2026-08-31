/**
 * incomingContent.test.ts
 * ---------------------------------------------------------------------------
 * Migrated from apps/desktop/src/main/__tests__/feishuBotIncomingContent.test.ts.
 * Pure unit tests for parseIncoming — no electron / SDK / network deps.
 */
import { describe, it, expect } from 'vitest';
import { parseIncoming } from '../incomingContent.js';

describe('parseIncoming', () => {
  it('text → text only', () => {
    const r = parseIncoming('text', JSON.stringify({ text: '  hello world  ' }));
    expect(r).toEqual({ text: 'hello world', attachments: [], unsupported: [] });
  });

  it('image → image attachment, no text', () => {
    const r = parseIncoming('image', JSON.stringify({ image_key: 'img_abc' }));
    expect(r.text).toBe('');
    expect(r.attachments).toEqual([{ kind: 'image', imageKey: 'img_abc' }]);
    expect(r.unsupported).toEqual([]);
  });

  it('image without image_key → empty', () => {
    const r = parseIncoming('image', JSON.stringify({}));
    expect(r).toEqual({ text: '', attachments: [], unsupported: [] });
  });

  it('file with string file_size → parsed as number', () => {
    const r = parseIncoming(
      'file',
      JSON.stringify({ file_key: 'file_xx', file_name: 'doc.pdf', file_size: '12345' }),
    );
    expect(r.attachments).toEqual([
      { kind: 'file', fileKey: 'file_xx', fileName: 'doc.pdf', fileSize: 12345 },
    ]);
    expect(r.unsupported).toEqual([]);
  });

  it('file missing file_name → falls back to file_key', () => {
    const r = parseIncoming('file', JSON.stringify({ file_key: 'file_xx' }));
    expect(r.attachments[0]).toMatchObject({
      kind: 'file',
      fileKey: 'file_xx',
      fileName: 'file_xx',
    });
  });

  it('audio → unsupported, no attachment', () => {
    const r = parseIncoming('audio', JSON.stringify({ file_key: 'k', duration: '3000' }));
    expect(r.attachments).toEqual([]);
    expect(r.unsupported).toEqual([{ type: 'audio', label: '语音消息' }]);
  });

  it('media (short video) → unsupported with file_name', () => {
    const r = parseIncoming('media', JSON.stringify({ file_key: 'k', file_name: 'demo.mp4' }));
    expect(r.unsupported).toEqual([{ type: 'media', label: '视频文件 demo.mp4' }]);
  });

  it('sticker → silently dropped (no unsupported entry)', () => {
    const r = parseIncoming('sticker', JSON.stringify({ file_key: 'sticker-xx' }));
    expect(r).toEqual({ text: '', attachments: [], unsupported: [] });
  });

  it('location → silently dropped', () => {
    const r = parseIncoming('location', JSON.stringify({ name: 'Beijing' }));
    expect(r).toEqual({ text: '', attachments: [], unsupported: [] });
  });

  it('unknown msg_type → unsupported entry for visibility', () => {
    const r = parseIncoming('totally_new_type', JSON.stringify({ foo: 'bar' }));
    expect(r.unsupported).toEqual([
      { type: 'totally_new_type', label: '未知类型 totally_new_type' },
    ]);
  });

  it('post: title + paragraphs flatten into text, img → image, media → unsupported', () => {
    const post = {
      title: '本周进度',
      content: [
        [
          { tag: 'text', text: '完成了 ' },
          { tag: 'a', text: '需求文档', href: 'https://example.com' },
          { tag: 'text', text: ' 的编写' },
        ],
        [{ tag: 'img', image_key: 'img_p1' }],
        [{ tag: 'at', user_id: 'u_1', user_name: 'Alice' }, { tag: 'text', text: ' 来确认下' }],
        [{ tag: 'media', file_key: 'mk', file_name: 'demo.mp4' }],
      ],
    };
    const r = parseIncoming('post', JSON.stringify(post));
    expect(r.text).toBe('本周进度\n完成了 需求文档 的编写\n 来确认下');
    expect(r.attachments).toEqual([{ kind: 'image', imageKey: 'img_p1' }]);
    expect(r.unsupported).toEqual([{ type: 'post.media', label: '视频文件 demo.mp4' }]);
  });

  it('post with empty content arrays → just title (or empty)', () => {
    const r = parseIncoming(
      'post',
      JSON.stringify({ title: '', content: [[]] }),
    );
    expect(r).toEqual({ text: '', attachments: [], unsupported: [] });
  });

  it('malformed JSON → empty result, no throw', () => {
    const r = parseIncoming('text', '{not-json');
    expect(r).toEqual({ text: '', attachments: [], unsupported: [] });
  });

  it('interactive v2 markdown card → extracts content for reply context', () => {
    const r = parseIncoming(
      'interactive',
      JSON.stringify({
        schema: '2.0',
        config: { update_multi: true },
        body: {
          elements: [{ tag: 'markdown', content: 'Omarchy Quattro 发布了' }],
        },
      }),
    );
    expect(r).toEqual({
      text: 'Omarchy Quattro 发布了',
      attachments: [],
      unsupported: [],
    });
  });

  it('interactive v2 mixed markdown + img → text and [图片] marker', () => {
    const r = parseIncoming(
      'interactive',
      JSON.stringify({
        schema: '2.0',
        body: {
          elements: [
            { tag: 'markdown', content: '见图' },
            {
              tag: 'img',
              img_key: 'img_k',
              alt: { tag: 'plain_text', content: '截图' },
            },
          ],
        },
      }),
    );
    expect(r.text).toBe('见图\n[图片]');
    expect(r.attachments).toEqual([]);
    expect(r.unsupported).toEqual([]);
  });

  it('interactive v1 lark_md card → extracts title and body, skips buttons', () => {
    const r = parseIncoming(
      'interactive',
      JSON.stringify({
        config: { wide_screen_mode: true, update_multi: true },
        elements: [
          { tag: 'div', text: { tag: 'lark_md', content: '**授权**' } },
          { tag: 'div', text: { tag: 'lark_md', content: '要执行危险操作' } },
          {
            tag: 'action',
            actions: [{ tag: 'button', text: { tag: 'plain_text', content: '允许' } }],
          },
        ],
      }),
    );
    expect(r.text).toBe('**授权**\n要执行危险操作');
  });

  it('interactive template / empty card → empty so reply path can fall back', () => {
    const r = parseIncoming(
      'interactive',
      JSON.stringify({ type: 'template', data: { template_id: 'ctp_x' } }),
    );
    expect(r).toEqual({ text: '', attachments: [], unsupported: [] });
  });
});
