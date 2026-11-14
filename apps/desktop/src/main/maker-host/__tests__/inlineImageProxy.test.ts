import { createServer } from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { expect, it, vi } from 'vitest';
import { createAnthropicCompatProxy, controlRequestSize, type ImageRouteInfo } from '@cindy/anthropic-compat-proxy';
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

async function throughProxy(route: ImageRouteInfo, run: (send: (body: Body) => Promise<Body>, encode: ReturnType<typeof vi.fn<typeof compressImageBuffer>>, prepareCalls: () => number) => Promise<void>) {
  const received: Body[] = [];
  const upstream = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    received.push(JSON.parse(Buffer.concat(chunks).toString()));
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
    requestSizeController: {
      format: () => 'responses', route: () => route, preprocessor,
      control: (body, format, policy) => controlRequestSize(body, format, { route: policy.route, signal: policy.signal, preprocessor }, async () => { throw new Error('Small request must not preserve images'); }),
    },
  });
  try {
    await run(async body => {
      const response = await fetchOverTestConnections(`${proxy.url}/v1/responses`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      expect(response.status).toBe(200);
      await response.text();
      return received.at(-1)!;
    }, encode, () => prepare.mock.calls.length);
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
])('compresses ordinary responses images for $providerId without lowering thresholds', async route => {
  const png = await sharp({ create: { width: 128, height: 96, channels: 3, background: '#406080' } }).png({ compressionLevel: 0 }).toBuffer();
  const jpeg = await sharp({ create: { width: 128, height: 96, channels: 3, background: '#708090' } }).withMetadata().jpeg({ quality: 100 }).toBuffer();
  const tiny = await sharp({ create: { width: 1, height: 1, channels: 3, background: 'black' } }).jpeg({ quality: 90, mozjpeg: true, chromaSubsampling: '4:4:4' }).toBuffer();
  const original = bodyFor([uri(png, 'image/png'), uri(jpeg, 'image/jpeg'), uri(tiny, 'image/jpeg')]);
  await throughProxy(route, async send => {
    const result = await send(original);
    const content = result.input[0].content;
    const compressedPng = decode(content[1].image_url!);
    expect(compressedPng.mime).toBe(route.providerId === 'openai' ? 'image/webp' : 'image/png');
    expect(compressedPng.bytes.length).toBeLessThanOrEqual(png.length * 0.85);
    expect(await sharp(compressedPng.bytes).raw().toBuffer()).toEqual(await sharp(png).raw().toBuffer());
    const compressedJpeg = decode(content[2].image_url!);
    expect(compressedJpeg.mime).toBe('image/jpeg');
    expect(compressedJpeg.bytes.length).toBeLessThanOrEqual(jpeg.length * 0.85);
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
