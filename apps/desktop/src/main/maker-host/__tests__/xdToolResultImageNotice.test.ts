import { describe, expect, it } from 'vitest';

import type { RequestTransformCtx } from '@cindy/anthropic-compat-proxy';

import { createXdToolResultImageNoticeTransform } from '../xd-tool-result-image-notice.js';

const imageBlock = {
  type: 'image',
  source: { type: 'base64', media_type: 'image/png', data: 'SECRET_IMAGE_BYTES' },
};

function context(upstreamBase: string): RequestTransformCtx {
  return {
    reqId: 1,
    method: 'POST',
    url: '/v1/messages',
    headers: {},
    upstreamBase,
  };
}

function request(model = 'codex/gpt-5.6-sol'): Record<string, unknown> {
  return {
    model,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'read-1',
            content: [{ type: 'text', text: 'image metadata' }, imageBlock],
          },
        ],
      },
    ],
  };
}

describe('XD tool-result image notice', () => {
  const transform = createXdToolResultImageNoticeTransform(
    () => 'https://gateway.example.com/anthropic/',
  );

  it.each(['codex/gpt-5.6-sol', 'gpt-5.6-sol', 'gpt-5.6-sol[1m]'])(
    'replaces XD-routed %s tool-result images without exposing image bytes',
    (model) => {
      const output = transform(
        request(model),
        context('https://gateway.example.com:443/anthropic'),
      );
      const json = JSON.stringify(output);

      expect(output).not.toBeNull();
      expect(json).toContain('image metadata');
      expect(json).toContain('current route cannot deliver images inside tool results');
      expect(json).toContain('attach it directly to the conversation');
      expect(json).not.toContain('SECRET_IMAGE_BYTES');
      expect(json).not.toContain('text-only');
    },
  );

  it('does not change the same model on a custom provider route', () => {
    expect(transform(request(), context('https://custom.example.com/v1'))).toBeNull();
  });

  it('does not change other models or ordinary user images', () => {
    expect(
      transform(request('claude-opus-5'), context('https://gateway.example.com/anthropic')),
    ).toBeNull();
    expect(
      transform(
        {
          model: 'codex/gpt-5.6-sol',
          messages: [{ role: 'user', content: [imageBlock] }],
        },
        context('https://gateway.example.com/anthropic'),
      ),
    ).toBeNull();
  });
});
