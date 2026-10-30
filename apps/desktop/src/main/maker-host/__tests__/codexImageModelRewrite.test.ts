import { describe, expect, it } from 'vitest';
import { createCodexImageModelRewrite } from '../codex-image-model-rewrite.js';

const binding = {
  wireModel: 'gpt-image-2',
  litellmModel: 'byok-a/image-alias',
  supportsEdit: true,
};
const rewrite = createCodexImageModelRewrite(binding);
const ctx = {
  reqId: 1,
  method: 'POST',
  url: '/images/generations',
  headers: { 'content-type': 'application/json' },
};

describe('Codex Provider image model binding', () => {
  it.each(['{}', 'null', '[]', '{"model":"other-provider/image"}', '{"prompt":"private-prompt"'])(
    'rejects invalid input without including the payload: %s',
    async (input) => {
      await expect(rewrite(Buffer.from(input), ctx)).rejects.toThrow();
      try {
        await rewrite(Buffer.from(input), ctx);
      } catch (error) {
        expect(String(error)).not.toContain('private-prompt');
      }
    },
  );

  it('rejects duplicate multipart model fields and invalid multipart bodies', async () => {
    const form = new FormData();
    form.append('model', 'gpt-image-2');
    form.append('model', 'other-model');
    const encoded = new Response(form);
    await expect(
      rewrite(Buffer.from(await encoded.arrayBuffer()), {
        ...ctx,
        headers: { 'content-type': encoded.headers.get('content-type')! },
      }),
    ).rejects.toThrow('Provider binding');
    await expect(
      rewrite(Buffer.from('invalid'), {
        ...ctx,
        headers: { 'content-type': 'multipart/form-data' },
      }),
    ).rejects.toThrow('Invalid image request multipart body');
  });

  it('rejects unsupported encodings and content types', async () => {
    await expect(
      rewrite(Buffer.from('{}'), {
        ...ctx,
        headers: { ...ctx.headers, 'content-encoding': 'gzip' },
      }),
    ).rejects.toThrow('encoding');
    await expect(
      rewrite(Buffer.from('{}'), {
        ...ctx,
        headers: { 'content-type': 'application/octet-stream' },
      }),
    ).rejects.toThrow('content type');
  });

  it('rejects edits locally when the Provider binding is generate-only', async () => {
    const generateOnly = createCodexImageModelRewrite({ ...binding, supportsEdit: false });
    await expect(
      generateOnly(Buffer.from('{"model":"gpt-image-2"}'), {
        ...ctx,
        url: '/_cindy/custom-provider/route/images/edits',
      }),
    ).rejects.toThrow('not supported');
    await expect(
      generateOnly(Buffer.from('{"model":"gpt-image-2"}'), {
        ...ctx,
        url: '/_cindy/custom-provider/route/images/generations',
      }),
    ).resolves.toEqual({ body: Buffer.from('{"model":"byok-a/image-alias"}') });
  });
});
