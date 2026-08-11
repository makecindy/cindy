import { describe, expect, it } from 'vitest';

import { createCodexHistoryImageMarkerTransform } from '../codex-history-image-marker.js';

const ctx = {
  reqId: 1,
  method: 'POST',
  url: '/v1/responses',
  headers: { 'thread-id': 'thread-1' },
  upstreamBase: 'https://text.example/v1',
};

function transformFor(strip = true) {
  return createCodexHistoryImageMarkerTransform({
    shouldStripImages: () => strip,
    sessionIdFromHeaders: () => 'session-1',
  });
}

describe('createCodexHistoryImageMarkerTransform', () => {
  it('replaces Responses images with an explicit unavailable marker', () => {
    const result = transformFor()(
      {
        model: 'deepseek-chat',
        input: [
          {
            type: 'message',
            role: 'user',
            content: [
              { type: 'input_text', text: 'old question' },
              { type: 'input_image', image_url: 'data:image/png;base64,bGVnYWN5' },
            ],
          },
        ],
      },
      ctx,
    );

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('input_image');
    expect(serialized).not.toContain('bGVnYWN5');
    expect(serialized).toContain('IMAGE_ATTACHMENT_UNAVAILABLE_V1');
    expect(serialized).toContain('user_uploaded_image');
    expect(serialized).toContain('did not receive the image');
  });

  it('handles Chat Completions image_url objects without fetching them', () => {
    const result = transformFor()(
      {
        model: 'deepseek-chat',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'describe' },
              { type: 'image_url', image_url: { url: 'https://example.test/legacy.png' } },
            ],
          },
        ],
      },
      { ...ctx, url: '/v1/chat/completions' },
    );

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('image_url');
    expect(serialized).not.toContain('https://example.test/legacy.png');
    expect(serialized).toContain('Do not claim to have seen');
  });

  it('replaces direct Responses image items in their original history position', () => {
    const result = transformFor()(
      {
        model: 'deepseek-chat',
        input: [
          { type: 'input_image', image_url: 'data:image/png;base64,cm9vdA==' },
          { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'question' }] },
        ],
      },
      ctx,
    ) as { input: unknown[] };

    expect(JSON.stringify(result)).not.toContain('input_image');
    expect(JSON.stringify(result)).toContain('user_uploaded_image');
    expect(result.input).toHaveLength(2);
    expect(result.input[0]).toMatchObject({ type: 'message', role: 'user' });
  });

  it('handles Anthropic image source blocks without retaining base64 data', () => {
    const result = transformFor()(
      {
        model: 'deepseek-chat',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'old question' },
              {
                type: 'image',
                source: { type: 'base64', media_type: 'image/png', data: 'c2Vuc2l0aXZl' },
              },
            ],
          },
        ],
      },
      { ...ctx, url: '/v1/messages' },
    );

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('"type":"image"');
    expect(serialized).not.toContain('c2Vuc2l0aXZl');
    expect(serialized).toContain('IMAGE_ATTACHMENT_UNAVAILABLE_V1');
  });

  it('is a no-op for capable or unknown routes', () => {
    const body = {
      model: 'vision',
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_image', image_url: 'x' }] },
      ],
    };
    expect(transformFor(false)(body, ctx)).toBeNull();
  });
});
