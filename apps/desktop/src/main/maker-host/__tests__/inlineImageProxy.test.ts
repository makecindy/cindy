import { createServer } from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { expect, it, vi } from 'vitest';
import { createAnthropicCompatProxy, controlRequestSize, recoverInlineAttachments, type OversizedRequestRecovery, type ImageRouteInfo } from '@cindy/anthropic-compat-proxy';
import { compressImageBuffer } from '@cindy/maker-core/image-compressor';
import { ImageResizer } from '../../../../../../packages/maker-core/src/agents/shared/image-resizer.js';
import { closeTestConnections, fetchOverTestConnections, listenOnAvailableLoopbackPort } from '../../../../../../packages/anthropic-compat-proxy/src/test-loopback-server.js';
import { createInlineImagePreprocessor } from '../inlineImagePreprocessor.js';

// Unit, PR 2 forwarding contract: real loopback proxy -> upstream bytes, default
// request thresholds. Existing encoder tests cannot detect proxy early-return,
// double-encode, or cache-bypasses-switch failures. No external service/credentials.
const uri = (bytes: Buffer, mime: string) => `data:${mime};base64,${bytes.toString('base64')}`;
const decode = (value: string) => {
  const [header, data] = value.split(',');
  return { mime: header.slice(5, header.indexOf(';')), bytes: Buffer.from(data, 'base64') };
};
type Body = { model: string; input: Array<{ role: string; content: Array<{ type: string; image_url?: string; text?: string }> }> };
const bodyFor = (images: string[]): Body => ({ model: 'gpt-6-astra', input: [{ role: 'user', content: [{ type: 'input_text', text: 'keep this text' }, ...images.map(image_url => ({ type: 'input_image', image_url }))] }] });

async function throughProxy(route: ImageRouteInfo, run: (send: (body: Body) => Promise<Body>, encode: ReturnType<typeof vi.fn<typeof compressImageBuffer>>, prepareCalls: () => number, allowRemovals: Array<boolean | undefined>) => Promise<void>, singleImageMaxBytes?: number, oversizedRequestRecovery?: OversizedRequestRecovery, maxRequestBodyBytes?: number, rejectFirstImageLimit?: number) {
  const received: Body[] = [];
  const allowRemovals: Array<boolean | undefined> = [];
  const upstream = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    received.push(JSON.parse(Buffer.concat(chunks).toString()));
    if (rejectFirstImageLimit && received.length === 1) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `image exceeds ${rejectFirstImageLimit} bytes maximum` } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  const port = await listenOnAvailableLoopbackPort(upstream);
  const encode = vi.fn(compressImageBuffer);
  const preprocessor = createInlineImagePreprocessor(undefined, encode);
  const prepare = vi.spyOn(preprocessor, 'prepare');
  const proxy = await createAnthropicCompatProxy({
    upstream: `http://127.0.0.1:${port}`,
    transformRequest: [],
    oversizedRequestRecovery,
    maxRequestBodyBytes,
    requestSizeController: {
      enabled: () => process.env.XDT_REQUEST_SIZE_CONTROL_DISABLE !== '1',
      format: () => 'responses', route: ctx => ({ ...route, providerId: ctx.headers['x-cindy-pi-provider-id'] }), preprocessor,
      control: (body, format, policy) => {
        allowRemovals.push(policy.allowRemoval);
        return controlRequestSize(body, format, { ...policy, preprocessor, singleImageMaxBytes: singleImageMaxBytes ?? policy.singleImageMaxBytes }, async () => { throw new Error('Disabled removal must not preserve images'); });
      },
    },
  });
  try {
    await run(async body => {
      const response = await fetchOverTestConnections(`${proxy.url}/v1/responses`, { method: 'POST', headers: { 'content-type': 'application/json', ...(route.providerId ? { 'x-cindy-pi-provider-id': route.providerId } : {}) }, body: JSON.stringify(body) });
      expect(response.status).toBe(200);
      await response.text();
      return received.at(-1)!;
    }, encode, () => prepare.mock.calls.length, allowRemovals);
  } finally {
    await closeTestConnections();
    await proxy.dispose();
    upstream.closeAllConnections();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
  }
}

it.each([
  { providerId: 'openai', modelId: 'gpt-6-astra' },
  { providerId: 'xai', modelId: 'grok-4' },
  { modelId: 'gpt-6-astra' },
  { providerId: 'openai', modelId: 'gpt-6-astra', deniedMimeTypes: ['image/webp'] },
])('compresses ordinary responses images for $providerId without lowering thresholds', async route => {
  const png = await sharp({ create: { width: 128, height: 96, channels: 3, background: '#406080' } }).png({ compressionLevel: 0 }).toBuffer();
  const jpeg = await sharp({ create: { width: 128, height: 96, channels: 3, background: '#708090' } }).withMetadata().jpeg({ quality: 100 }).toBuffer();
  const tiny = await sharp({ create: { width: 1, height: 1, channels: 3, background: 'black' } }).jpeg({ quality: 90, mozjpeg: true, chromaSubsampling: '4:4:4' }).toBuffer();
  const original = bodyFor([uri(png, 'image/png'), uri(jpeg, 'image/jpeg'), uri(tiny, 'image/jpeg')]);
  await throughProxy(route, async send => {
    const result = await send(original);
    const content = result.input[0].content;
    const compressedPng = decode(content[1].image_url!);
    expect(compressedPng.mime).toBe(route.providerId === 'openai' && !route.deniedMimeTypes?.includes('image/webp') ? 'image/webp' : 'image/png');
    expect(compressedPng.bytes.length).toBeLessThanOrEqual(png.length * 0.85);
    expect(await sharp(compressedPng.bytes).raw().toBuffer()).toEqual(await sharp(png).raw().toBuffer());
    const compressedJpeg = decode(content[2].image_url!);
    expect(compressedJpeg.mime).toBe('image/jpeg');
    expect(compressedJpeg.bytes).toEqual(jpeg);
    expect(await sharp(compressedJpeg.bytes).metadata()).toMatchObject({ width: 128, height: 96 });
    expect(content[3]).toEqual(original.input[0].content[3]);
    expect(content[0]).toEqual(original.input[0].content[0]);
  });
});

it('keeps resized JPEG bytes through the proxy without encoding a second time', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'image-proxy-resizer-'));
  try {
    const source = path.join(root, 'source.jpg');
    await sharp({ create: { width: 1600, height: 20, channels: 3, background: '#123456' } }).withMetadata().jpeg({ quality: 100 }).toFile(source);
    const resized = await new ImageResizer({ cacheDir: path.join(root, 'cache'), skipUnderBytes: 0 }).process(source);
    expect(resized).not.toBe(source);
    const bytes = await fs.readFile(resized);
    const body = bodyFor([uri(bytes, 'image/jpeg')]);
    await throughProxy({ providerId: 'openai', modelId: 'gpt-6-astra' }, async (send, encode, prepareCalls) => {
      expect(await send(body)).toEqual(body);
      expect(prepareCalls()).toBe(1); // Reject a vacuous pass when proxy skips prepare.
      expect(encode).not.toHaveBeenCalled();
    });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

it('honors enable -> disable -> enable through the real proxy and its cache', async () => {
  const previous = process.env.XDT_IMAGE_COMPRESSION_DISABLE;
  const bytes = await sharp({ create: { width: 100, height: 80, channels: 3, background: '#135790' } }).png({ compressionLevel: 0 }).toBuffer();
  const body = bodyFor([uri(bytes, 'image/png')]);
  try {
    delete process.env.XDT_IMAGE_COMPRESSION_DISABLE;
    await throughProxy({ providerId: 'openai', modelId: 'gpt-6-astra' }, async (send, encode) => {
      const enabled = await send(body);
      expect(enabled).not.toEqual(body);
      const calls = encode.mock.calls.length;
      process.env.XDT_IMAGE_COMPRESSION_DISABLE = '1';
      expect(await send(body)).toEqual(body);
      expect(encode).toHaveBeenCalledTimes(calls);
      delete process.env.XDT_IMAGE_COMPRESSION_DISABLE;
      expect(await send(body)).toEqual(enabled);
      expect(encode).toHaveBeenCalledTimes(calls);
    });
  } finally {
    if (previous === undefined) delete process.env.XDT_IMAGE_COMPRESSION_DISABLE;
    else process.env.XDT_IMAGE_COMPRESSION_DISABLE = previous;
  }
});


// Regression: the 400 retry must start from the original of only the image
// still above the learned limit, not re-encode an already-small prepared image.
it('retries only the still-oversized image from its original bytes and MIME', async () => {
  const raw = Buffer.alloc(128 * 96 * 3);
  let seed = 17;
  for (let i = 0; i < raw.length; i += 3) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    raw.fill(seed >>> 24, i, i + 3);
  }
  const png = await sharp(raw, { raw: { width: 128, height: 96, channels: 3 } }).png({ compressionLevel: 0 }).toBuffer();
  const small = await sharp({ create: { width: 200, height: 120, channels: 3, background: '#572193' } }).png({ compressionLevel: 0 }).toBuffer();
  const limit = 8192;
  expect(small.length).toBeGreaterThan(limit); // Raw size alone must not trigger tighten.
  await throughProxy({ providerId: 'openai', modelId: 'gpt-6-astra' }, async (send, encode, _prepareCalls, allowRemovals) => {
    const forwarded = await send(bodyFor([uri(png, 'image/png'), uri(small, 'image/png')]));
    expect(allowRemovals).toHaveLength(2); // Initial attempt plus the real upstream 400 retry.
    expect(encode).toHaveBeenCalledTimes(3); // Two prepare encodes, exactly one tighten encode.
    const largePrepared = await encode.mock.results[0].value;
    const smallPrepared = await encode.mock.results[1].value;
    expect(largePrepared.mimeType).toBe('image/webp');
    expect(largePrepared.bytes.length).toBeGreaterThan(limit);
    expect(smallPrepared.bytes.length).toBeLessThanOrEqual(limit);
    const budgetCalls = encode.mock.calls.filter(([input]) => input.budget);
    expect(budgetCalls).toHaveLength(1);
    expect(budgetCalls[0][0]).toMatchObject({ bytes: png, mimeType: 'image/png', budget: { maxBytes: limit } });
    const content = forwarded.input[0].content;
    expect(content.filter(item => item.type === 'input_image')).toHaveLength(2);
    expect(decode(content[1].image_url!).bytes.length).toBeLessThanOrEqual(limit);
    expect(content[2].image_url).toBe(uri(smallPrepared.bytes, smallPrepared.mimeType));
  }, undefined, undefined, undefined, limit);
});


it('still prepares images when request-size removal is disabled', async () => {
  const previous = process.env.XDT_REQUEST_SIZE_CONTROL_DISABLE;
  try {
    process.env.XDT_REQUEST_SIZE_CONTROL_DISABLE = '1';
    const png = await sharp({ create: { width: 96, height: 64, channels: 3, background: '#951753' } }).png({ compressionLevel: 0 }).toBuffer();
    await throughProxy({ providerId: 'openai', modelId: 'gpt-6-astra' }, async (send, encode, prepareCalls) => {
      const result = await send(bodyFor([uri(png, 'image/png')]));
      expect(prepareCalls()).toBe(1);
      expect(encode).toHaveBeenCalledOnce();
      expect(decode(result.input[0].content[1].image_url!).mime).toBe('image/webp');
    });
  } finally {
    if (previous === undefined) delete process.env.XDT_REQUEST_SIZE_CONTROL_DISABLE;
    else process.env.XDT_REQUEST_SIZE_CONTROL_DISABLE = previous;
  }
});


// PR 1 787ab1859b: scale only the configurable ingress limit to 32 KiB.
// Keep request-size triggerBytes unchanged; exercise real legacy disk-backed
// recovery, then compress only the image that remains inline.
it('compresses the retained image after legacy ingress recovery with removal disabled', async () => {
  const previous = process.env.XDT_REQUEST_SIZE_CONTROL_DISABLE;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'image-legacy-recovery-'));
  const maxRequestBodyBytes = 32 * 1024;
  try {
    process.env.XDT_REQUEST_SIZE_CONTROL_DISABLE = '1';
    const large = await sharp({ create: { width: 128, height: 96, channels: 3, background: '#456789' } }).png({ compressionLevel: 0 }).toBuffer();
    const retained = await sharp({ create: { width: 64, height: 48, channels: 3, background: '#254769' } }).png({ compressionLevel: 0 }).toBuffer();
    const body = bodyFor([uri(large, 'image/png'), uri(retained, 'image/png')]);
    expect(Buffer.byteLength(JSON.stringify(body))).toBeGreaterThan(maxRequestBodyBytes);
    const savedPath = path.join(root, 'preserved.png');
    const commit = vi.fn(async () => {});
    const legacy = vi.fn<OversizedRequestRecovery>(() => (spooled, target) => recoverInlineAttachments(spooled, target, {
      prepare: async attachment => {
        await fs.copyFile(attachment.filePath, savedPath);
        return savedPath;
      },
      commit,
    }));
    await throughProxy({ providerId: 'openai', modelId: 'gpt-6-astra' }, async (send, encode, prepareCalls, allowRemovals) => {
      const result = await send(body);
      expect(legacy).toHaveBeenCalledOnce();
      expect(commit).toHaveBeenCalledOnce();
      expect((await fs.readFile(savedPath)).equals(large)).toBe(true);
      expect(allowRemovals).toEqual([false]);
      expect(prepareCalls()).toBe(1);
      expect(encode).toHaveBeenCalledOnce();
      expect(encode.mock.calls[0][0].bytes).toEqual(retained);
      const content = result.input[0].content;
      expect(content[1].type).toBe('input_text');
      expect(content[1].text).toContain('Preserved local file:');
      const compressed = decode(content[2].image_url!);
      expect(compressed.mime).toBe('image/webp');
      expect(compressed.bytes.length).toBeLessThan(retained.length * 0.85);
      expect(await sharp(compressed.bytes).metadata()).toMatchObject({ width: 64, height: 48 });
      expect(await sharp(compressed.bytes).raw().toBuffer()).toEqual(await sharp(retained).raw().toBuffer());
    }, undefined, legacy, maxRequestBodyBytes);
  } finally {
    if (previous === undefined) delete process.env.XDT_REQUEST_SIZE_CONTROL_DISABLE;
    else process.env.XDT_REQUEST_SIZE_CONTROL_DISABLE = previous;
    await fs.rm(root, { recursive: true, force: true });
  }
});

// Unit: regression for budgeting original bytes after prepare. Forty repeated
// screenshots cross the real 32 MiB threshold before encoding; one cached encode
// keeps this minimal fixture inexpensive without lowering production limits.
it('budgets forty PNG images after real compression and preserves all of them', async () => {
  const png = await sharp({ create: { width: 512, height: 416, channels: 3, background: '#315678' } })
    .png({ compressionLevel: 0 }).toBuffer();
  const body = Buffer.from(JSON.stringify(bodyFor(Array(40).fill(uri(png, 'image/png')))));
  expect(body.length).toBeGreaterThan(32 << 20);
  const preserve = vi.fn(async () => { throw new Error('Compressed images fit without persistence'); });
  const result = await controlRequestSize(body, 'responses', {
    route: { providerId: 'openai', modelId: 'gpt-6-astra' },
    signal: new AbortController().signal,
    preprocessor: createInlineImagePreprocessor(() => true),
  }, preserve);
  expect(result!.bytes).toBeLessThan(32 << 20);
  expect(result!.removedImages).toBe(0);
  expect(preserve).not.toHaveBeenCalled();
  const images = (JSON.parse(result!.body.toString()) as Body).input[0].content.filter(item => item.type === 'input_image');
  expect(images).toHaveLength(40);
  for (const item of images) expect(decode(item.image_url!).mime).toBe('image/webp');
  expect(await sharp(decode(images[0].image_url!).bytes).raw().toBuffer()).toEqual(await sharp(png).raw().toBuffer());
});
