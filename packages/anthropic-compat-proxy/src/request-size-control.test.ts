import { win32 } from 'node:path';
import { describe, expect, it } from 'vitest';
import { controlRequestSize, requestSizeBudgetAfterRejection, type InlineImagePreprocessor } from './request-size-control.js';
import { classifyRequestSizeError } from './request-size-errors.js';

/**
 * 测试价值
 * - 生产入口与可观察结果：controlRequestSize，验证代理发出的 wire body、替换文本、预算错误和稳定前缀。
 * - Bug／规则依据：长历史图片导致 413；请求大小控制的 32/14MiB、图数上限与前缀缓存契约。
 * - 现有覆盖缺口：旧 recovery 只在溢出后顺序挪图，未覆盖三种 wire、assistant 回合、预处理和快速路径。
 * - 最小失败输入：一张 data URL、一个 tool_result 或 51 张微图，配合小型表驱动预算；tier：unit。
 * - 实测耗时：单独运行本文件约 0.4s（Vitest，含收集）。
 */

const imageData = (value: number, bytes = 400) => Buffer.alloc(bytes, value).toString('base64');
const preserve = async (_bytes: Buffer, _mime: string, index: number) => `/tmp/recovered-${index}.png`;

// PR #10663: file/document occurrences must not enter image-only preprocessing,
// count caps or single-image caps. Unit tier; 51 PDFs plus one small PNG fit the
// byte budget and must remain byte-identical in both native file representations.
it.each(['responses', 'anthropic'] as const)('keeps PDFs outside image limits and preprocessing in %s', async format => {
  const pdf = Buffer.from('%PDF-' + 'x'.repeat(1100)).toString('base64');
  const png = imageData(1, 100);
  const blocks = [
    ...Array.from({ length: 51 }, () => format === 'responses'
      ? { type: 'input_file', file_data: `data:application/pdf;base64,${pdf}` }
      : { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdf } }),
    format === 'responses' ? { type: 'input_image', image_url: `data:image/png;base64,${png}` }
      : { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } },
  ];
  const raw = Buffer.from(JSON.stringify({ [format === 'responses' ? 'input' : 'messages']: [{ role: 'user', content: blocks }] }));
  const prepared: string[] = [];
  const tightened: string[] = [];
  const omitted: string[] = [];
  const preprocessor: InlineImagePreprocessor = {
    prepare: async input => { prepared.push(input.mimeType); return null; },
    tighten: async input => { tightened.push(input.mimeType); return null; },
  };
  for (const singleImageMaxBytes of [undefined, 1000]) {
    const result = await controlRequestSize(raw, format, { modelFamily: 'gpt', singleImageMaxBytes, preprocessor }, async (_bytes, mime) => {
      omitted.push(mime); return '/tmp/file.pdf';
    });
    expect((result?.body ?? raw).equals(raw)).toBe(true);
  }
  expect(prepared).toEqual(['image/png', 'image/png']);
  expect(tightened).toEqual([]);
  expect(omitted).toEqual([]);
  // A real image-count crossing must skip the PDFs rather than remove them on
  // its way to the oldest images. Keep their original prefix bytes untouched.
  const crowded = Buffer.from(JSON.stringify({ [format === 'responses' ? 'input' : 'messages']: [{ role: 'user',
    content: [...blocks, ...Array.from({ length: 50 }, () => blocks.at(-1)!)],
  }] }));
  const result = await controlRequestSize(crowded, format, { modelFamily: 'gpt', preprocessor }, async (_bytes, mime) => {
    omitted.push(mime); return '/tmp/image.png';
  });
  expect(result).toMatchObject({ imageCount: 51, removedImages: 29 });
  expect(omitted).toEqual(Array.from({ length: 29 }, () => 'image/png'));
  const firstImage = crowded.indexOf(Buffer.from(JSON.stringify(blocks.at(-1))));
  expect(firstImage).toBeGreaterThan(0);
  expect(result!.body.subarray(0, firstImage).equals(crowded.subarray(0, firstImage))).toBe(true);
});

describe('request size control', () => {
  it('classifies nested provider size errors after decoding', () => {
    expect(classifyRequestSizeError('{"error":{"message":"Exceeded maximum number of images (50) allowed"}}')).toMatchObject({ kind: 'image-count', limitCount: 50 });
    expect(classifyRequestSizeError('image exceeds 5 MB maximum: 7473812 bytes')).toMatchObject({ kind: 'single-image-too-large', limitBytes: 5 * 1024 * 1024 });
    expect(classifyRequestSizeError('Request size is too large. Max size is 100 MB')).toMatchObject({ kind: 'request-too-large', limitBytes: 100 * 1024 * 1024 });
    expect(classifyRequestSizeError('Input is too long.')).toMatchObject({ kind: 'context-too-long' });
    const nested = (message: string, code: string) => JSON.stringify({ error: {
      message: `litellm.BadRequestError: NovaException - ${JSON.stringify({ error: { message, type: 'invalid_request_error', param: null, code: 'provider_invalid_request' } })}`,
      type: null, param: null, code,
    } });
    expect(classifyRequestSizeError(nested('Exceeded maximum number of images (50) allowed in the request.', '400')))
      .toEqual({ kind: 'image-count', limitCount: 50 });
    expect(classifyRequestSizeError(nested('The request exceeds the maximum allowed size.', '413')))
      .toEqual({ kind: 'request-too-large' });
    expect(classifyRequestSizeError('{"error":"Request size is too large. Max size is 100 MB"}'))
      .toEqual({ kind: 'request-too-large', limitBytes: 100 * 1024 * 1024 });
    expect(classifyRequestSizeError('invalid_request_error: messages.8.content.0.tool_result.content.0.image.source.base64: image exceeds 5 MB maximum: 7473812 bytes > 5242880 bytes'))
      .toEqual({ kind: 'single-image-too-large', limitBytes: 5 * 1024 * 1024 });
    expect(classifyRequestSizeError('The request exceeds the maximum allowed size of 1.5 MB'))
      .toEqual({ kind: 'request-too-large', limitBytes: 1.5 * 1024 * 1024 });
    expect(classifyRequestSizeError('Max size is 1,024 KB')).toEqual({ kind: 'request-too-large', limitBytes: 1024 * 1024 });
    expect(classifyRequestSizeError('Exceeded maximum number of images (50). Max size is 32000 bytes'))
      .toEqual({ kind: 'image-count', limitCount: 50, limitBytes: 32000 });
    expect(classifyRequestSizeError('prompt is too long: 1,008,214 tokens > 1,000,000 maximum')).toEqual({ kind: 'context-too-long' });
    expect(classifyRequestSizeError('unsupported image')).toEqual({ kind: 'other' });
    expect(classifyRequestSizeError('unsupported image format')).toEqual({ kind: 'unsupported-image-format' });
    expect(classifyRequestSizeError('only supports text modality')).toEqual({ kind: 'unsupported-image' });
  });
  // PR #10663 CodeQL js/polynomial-redos: only classify a bounded error prefix.
  // Unit tier; the old implementation picked up a limit after the 4K window.
  it('classifies only a bounded prefix of an upstream error', () => {
    expect(classifyRequestSizeError('x'.repeat(4096) + 'Too many images (50)')).toEqual({ kind: 'other' });
  });
  // The old overlapping non-digit repetitions could repeatedly scan these
  // keyword-rich suffixes. Assert the result, not machine-dependent elapsed time.
  it('returns other for a 100 KiB adversarial error without digits', () => {
    const text = 'image maximum request exceeds '.repeat(4000).slice(0, 100 * 1024);
    expect(classifyRequestSizeError(text)).toEqual({ kind: 'other' });
  });
  it('keeps a small request byte-for-byte on the quick path', async () => {
    const raw = Buffer.from(JSON.stringify({ input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }] }));
    expect(await controlRequestSize(raw, 'responses', { triggerBytes: 100, targetBytes: 50 }, preserve)).toBeNull();
  });

  it('replays Responses history oldest-first and traverses tool output without rewriting the prefix', async () => {
    const body = {
      prefix: 'keep-this-prefix',
      input: [
        { role: 'user', content: [{ type: 'input_image', image_url: `data:image/png;base64,${imageData(1)}` }] },
        { type: 'reasoning', summary: [] },
        { type: 'function_call_output', output: [{ type: 'input_image', image_url: `data:image/png;base64,${imageData(2)}` }] },
        { role: 'user', content: [{ type: 'input_image', image_url: `data:image/png;base64,${imageData(3)}` }] },
      ],
    };
    const raw = Buffer.from(JSON.stringify(body));
    const result = await controlRequestSize(raw, 'responses', { triggerBytes: raw.length - 1, targetBytes: raw.length - 250 }, preserve);
    expect(result?.removedImages).toBeGreaterThan(0);
    const prefixBytes = Buffer.byteLength('{"prefix":"keep-this-prefix","input":[');
    expect(result?.body.subarray(0, prefixBytes)).toEqual(raw.subarray(0, prefixBytes));
    const parsed = JSON.parse(result!.body.toString()) as { input: Array<{ content: Array<{ type: string; text?: string }> }> };
    expect(parsed.input[0].content[0].type).toBe('input_text');
    expect(parsed.input[0].content[0].text).toContain('/tmp/recovered-0.png');
  });

  it('supports Anthropic tool_result and Chat Completions image shapes', async () => {
    const anthropic = Buffer.from(JSON.stringify({ messages: [
      { role: 'user', content: [{ type: 'tool_result', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: imageData(1) } }] }] },
    ] }));
    const chat = Buffer.from(JSON.stringify({ messages: [
      { role: 'user', content: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${imageData(2)}` } }] },
    ] }));
    expect((await controlRequestSize(anthropic, 'anthropic', { triggerBytes: anthropic.length - 1, targetBytes: anthropic.length - 100 }, preserve))?.body.toString()).toContain('recovered-0');
    expect((await controlRequestSize(chat, 'chat', { triggerBytes: chat.length - 1, targetBytes: chat.length - 100 }, preserve))?.body.toString()).toContain('recovered-0');
  });

  it('enforces GPT and Claude image count caps and keeps the newest images', async () => {
    const input = Array.from({ length: 51 }, (_, i) => ({ role: 'user', content: [{ type: 'input_image', image_url: `data:image/png;base64,${imageData(i, 1)}` }] }));
    const raw = Buffer.from(JSON.stringify({ input }));
    const result = await controlRequestSize(raw, 'responses', { modelFamily: 'gpt', triggerBytes: 32 * 1024 * 1024, targetBytes: 14 * 1024 * 1024 }, preserve);
    const parsed = JSON.parse(result!.body.toString()) as { input: Array<{ content: Array<{ type: string }> }> };
    expect(parsed.input.filter(item => item.content[0].type === 'input_image')).toHaveLength(22);
    expect(parsed.input.at(-1)?.content[0].type).toBe('input_image');
    expect(parsed.input[0]?.content[0].type).toBe('input_text');
  });

  it.each([
    ['gpt', 50, 50],
    ['claude', 100, 100],
  ] as const)('does not trim at the family boundary: %s', async (modelFamily, count, expected) => {
    const input = Array.from({ length: count }, (_, i) => ({ role: 'user', content: [{ type: 'input_image', image_url: `data:image/png;base64,${imageData(i, 1)}` }] }));
    const raw = Buffer.from(JSON.stringify({ input }));
    const result = await controlRequestSize(raw, 'responses', { modelFamily, triggerBytes: 32 * 1024 * 1024, targetBytes: 14 * 1024 * 1024 }, preserve);
    expect(result).toBeNull();
    expect(input).toHaveLength(expected);
  });

  it('uses the reply order before the removal point in the placeholder', async () => {
    const body = { input: [
      { role: 'user', content: [{ type: 'input_image', image_url: `data:image/png;base64,${imageData(1)}` }] },
      { role: 'assistant', content: [{ type: 'output_text', text: 'seen' }] },
      { role: 'user', content: [{ type: 'input_image', image_url: `data:image/png;base64,${imageData(2)}` }] },
    ] };
    const raw = Buffer.from(JSON.stringify(body));
    const result = await controlRequestSize(raw, 'responses', { triggerBytes: raw.length - 1, targetBytes: raw.length - 150 }, preserve);
    expect(result?.body.toString()).toContain('An assistant response occurred before this media was removed.');
  });

  it('uses compressed bytes for the budget through the injected preprocessor', async () => {
    let calls = 0;
    const preprocessor: InlineImagePreprocessor = {
      async prepare({ bytes }) {
        calls++;
        return calls === 1 ? { bytes: bytes.subarray(0, 2), mimeType: 'image/webp', width: 1, height: 1, changed: true, cacheKey: 'fake' } : null;
      },
    };
    const raw = Buffer.from(JSON.stringify({ input: [{ role: 'user', content: [{ type: 'input_image', image_url: `data:image/png;base64,${imageData(8, 31)}` }] }] }));
    const result = await controlRequestSize(raw, 'responses', { triggerBytes: raw.length + 1, targetBytes: raw.length + 1, preprocessor, route: { modelId: 'cache-test' } }, preserve);
    expect(result?.removedImages).toBe(0);
    expect(result?.body.toString()).toContain('image/webp');
    expect(result?.parsedBody).toEqual(JSON.parse(result!.body.toString()));
    const repeated = await controlRequestSize(raw, 'responses', { triggerBytes: raw.length + 1, targetBytes: raw.length + 1, preprocessor, route: { modelId: 'cache-test' } }, preserve);
    expect(repeated).toBeNull();
    expect(calls).toBe(2);
  });

  // Format rejection previously discarded a valid PNG because it was larger than
  // WebP. Unit: one inline image; existing preprocessing tests only shrink bytes.
  it.each([
    { deniedMimeTypes: [], mimeType: 'image/png', accepted: false },
    { deniedMimeTypes: ['image/webp'], mimeType: 'image/png', accepted: true },
    { deniedMimeTypes: ['image/webp'], mimeType: 'image/webp', accepted: false },
    { deniedMimeTypes: ['image/webp', 'image/png'], mimeType: 'image/png', accepted: false },
  ])('accepts larger prepared bytes only to repair a rejected format: %j', async ({ deniedMimeTypes, mimeType, accepted }) => {
    const raw = Buffer.from(JSON.stringify({ input: [{ role: 'user', content: [
      { type: 'input_image', image_url: `data:image/webp;base64,${imageData(1, 10)}` },
    ] }] }));
    const output = Buffer.alloc(20, 2);
    const result = await controlRequestSize(raw, 'responses', {
      allowRemoval: false,
      route: { deniedMimeTypes },
      preprocessor: { async prepare() {
        return { bytes: output, mimeType, width: 1, height: 1, changed: true, cacheKey: 'format-retry' };
      } },
    }, preserve);
    if (accepted) {
      expect(result?.body.toString()).toContain(`data:image/png;base64,${output.toString('base64')}`);
      expect(result?.removedImages).toBe(0);
      expect(result!.body.length).toBeGreaterThan(raw.length);
    } else {
      expect(result).toBeNull();
    }
  });

  it('passes original bytes to tighten even after prepare returns an intermediate image', async () => {
    const original = Buffer.alloc(400, 9);
    let tightenedInput: Buffer | undefined;
    const preprocessor: InlineImagePreprocessor = {
      async prepare({ bytes }) { return { bytes: bytes.subarray(0, 100), mimeType: 'image/jpeg', width: 1, height: 1, changed: true, cacheKey: 'prepare' }; },
      async tighten({ bytes }) { tightenedInput = bytes; return { bytes: bytes.subarray(0, 20), mimeType: 'image/jpeg', width: 1, height: 1, changed: true, cacheKey: 'tighten' }; },
    };
    const raw = Buffer.from(JSON.stringify({ input: [{ role: 'user', content: [{ type: 'input_image', image_url: `data:image/png;base64,${original.toString('base64')}` }] }] }));
    await controlRequestSize(raw, 'responses', { triggerBytes: raw.length + 1, targetBytes: raw.length + 1, singleImageMaxBytes: 10, preprocessor }, preserve);
    expect(tightenedInput).toEqual(original);
  });

  it('preserves the exact existing prefix when the same history gets a new suffix', async () => {
    const history = { input: [{ role: 'user', content: [{ type: 'input_image', image_url: `data:image/png;base64,${imageData(5)}` }] }] };
    const first = Buffer.from(JSON.stringify(history));
    const extended = Buffer.from(JSON.stringify({ ...history, input: [...history.input, { role: 'user', content: [{ type: 'input_text', text: 'new' }] }] }));
    const firstResult = await controlRequestSize(first, 'responses', { triggerBytes: first.length - 1, targetBytes: first.length - 100 }, preserve);
    const extendedResult = await controlRequestSize(extended, 'responses', { triggerBytes: first.length - 1, targetBytes: first.length - 100 }, preserve);
    const stablePrefixLength = firstResult!.body.indexOf(Buffer.from('}]}')) + 3;
    expect(stablePrefixLength).toBeGreaterThan(0);
    expect(extendedResult?.body.subarray(0, stablePrefixLength)).toEqual(firstResult!.body.subarray(0, stablePrefixLength));
  });

  it('fails locally when text alone cannot fit after all images are removed', async () => {
    const raw = Buffer.from(JSON.stringify({ instructions: 'x'.repeat(200), input: [{ role: 'user', content: [{ type: 'input_image', image_url: `data:image/png;base64,${imageData(1, 30)}` }] }] }));
    await expect(controlRequestSize(raw, 'responses', { triggerBytes: 100, targetBytes: 10 }, preserve)).rejects.toThrow('REQUEST_TEXT_TOO_LARGE');
  });

  it('rejects a text-only request that crosses the trigger locally', async () => {
    const raw = Buffer.from(JSON.stringify({ input: [{ role: 'user', content: [{ type: 'input_text', text: 'x'.repeat(200) }] }] }));
    await expect(controlRequestSize(raw, 'responses', { triggerBytes: 100, targetBytes: 50 }, preserve)).rejects.toThrow('REQUEST_TEXT_TOO_LARGE');
  });
});

it('allows replayed history to grow above the target without crossing the trigger again', async () => {
  const raw = Buffer.from(JSON.stringify({ input: Array.from({ length: 100 }, (_, i) => ({ role: 'user', content: [{ type: 'input_image', image_url: `data:image/png;base64,${imageData(i, 7680)}` }] })) }));
  const result = await controlRequestSize(raw, 'responses', { triggerBytes: 320_000, targetBytes: 140_000 }, preserve);
  expect(result?.body.length).toBeLessThanOrEqual(320_000);
  expect(result?.body.length).toBeGreaterThan(140_000);
  expect(result?.parsedBody).toEqual(JSON.parse(result!.body.toString()));
});

// Developer's production-code simulation: compression updated only one of the
// byte counters, and whole-request image counts trimmed every appended image.
// Unit tier, 40 x 4 KiB encoded images scales the 40 x 1 MiB reproduction.
const replayHistory = (count: number, encodedBytes: number | ((index: number) => number) = 4096) => Buffer.from(JSON.stringify({
  input: Array.from({ length: count }, (_, index) => ({ id: index, role: 'user', content: [
    { type: 'input_image', image_url: `data:image/png;base64,${imageData(index, (typeof encodedBytes === 'function' ? encodedBytes(index) : encodedBytes) * 3 / 4)}` },
  ] })),
}));
const shrinkForReplay: InlineImagePreprocessor = {
  async prepare({ bytes }) {
    return { bytes: bytes.subarray(0, Math.floor(bytes.length * 0.34)), mimeType: 'image/webp',
      width: 10, height: 10, changed: true, cacheKey: 'replay-fixture' };
  },
};
const inlineCount = (body: Buffer) => (body.toString().match(/"type":"(?:input_image|image|image_url)"/g) ?? []).length;

it.each([['responses', 40], ['responses', 80], ['anthropic', 40], ['anthropic', 80], ['chat', 40], ['chat', 80]] as const)(
  'replays the same compressed bytes regardless of preprocessing order (%s, %i images)', async (format, count) => {
  let raw = replayHistory(count, count === 40 ? 4096 : index => index < 51 ? 4 : 16384);
  if (format !== 'responses') {
    const input = JSON.parse(raw.toString()).input as Array<{ id: number; role: string; content: Array<{ image_url: string }> }>;
    raw = Buffer.from(JSON.stringify({ messages: input.map(item => ({ ...item, content: item.content.map(image => format === 'chat'
      ? { type: 'image_url', image_url: { url: image.image_url } }
      : { type: 'image', source: { type: 'base64', media_type: 'image/png', data: image.image_url.split(',')[1] } }) })) }));
  }
  const compressed = await controlRequestSize(raw, format, { preprocessor: shrinkForReplay, allowRemoval: false }, preserve);
  const policy = { triggerBytes: 32 * 4096, targetBytes: 14 * 4096, modelFamily: 'gpt' as const };
  const removedInline: number[] = [];
  const removedBefore: number[] = [];
  const withPreprocessor = await controlRequestSize(raw, format, { ...policy, preprocessor: shrinkForReplay }, async (bytes, mime, index) => {
    removedInline.push(index); return preserve(bytes, mime, index);
  });
  const precompressed = await controlRequestSize(compressed!.body, format, policy, async (bytes, mime, index) => {
    removedBefore.push(index); return preserve(bytes, mime, index);
  });
  expect(removedInline).toEqual(removedBefore);
  expect(withPreprocessor!.body).toEqual(precompressed?.body ?? compressed!.body);
  expect(withPreprocessor!.body.length).toBeLessThanOrEqual(policy.triggerBytes);
  if (count === 40) {
    expect(removedInline).toEqual([]);
    expect(inlineCount(withPreprocessor!.body)).toBe(40);
  } else {
    // First 51 tiny images cross the count cap; the later large images cross
    // the byte budget even after compression. Both removals share one replay.
    expect(removedInline.length).toBeGreaterThan(29);
    expect(withPreprocessor!.body).not.toEqual(compressed!.body);
  }
});

it.each([
  ['gpt', [[51, 22], [52, 23], [53, 24], [79, 50], [80, 22]]],
  ['claude', [[101, 44], [102, 45]]],
] as const)('replays %s count crossings without rewriting the prefix on every append', async (modelFamily, sequence) => {
  let previous: Buffer | undefined;
  let removedPrefix: Buffer | undefined;
  for (const [count, expected] of sequence) {
    const raw = replayHistory(count, 4);
    const result = await controlRequestSize(raw, 'responses', { modelFamily }, preserve);
    const body = result?.body ?? raw;
    expect(inlineCount(body), `history with ${count} images`).toBe(expected);
    if (previous && count !== 80) {
      // Both frames have the same already-emitted input items; only the closing
      // array/object delimiters move when another item is appended.
      expect(body.subarray(0, previous.length - 2)).toEqual(previous.subarray(0, -2));
    }
    if (!removedPrefix) {
      const boundary = body.indexOf(Buffer.from(`{"id":${count - expected},`));
      expect(boundary).toBeGreaterThan(0);
      removedPrefix = body.subarray(0, boundary);
    }
    // The second count crossing can replace more images, but must preserve the
    // bytes of placeholders already emitted at the first crossing.
    expect(body.subarray(0, removedPrefix.length)).toEqual(removedPrefix);
    previous = body;
  }
});

// Regression from real CC/Pi retries: learned limits are replay thresholds,
// never a request to shrink every subsequent body by another 44% (unit tier).
it('leaves a small image request byte-identical under its learned trigger', async () => {
  const raw = replayHistory(1, 4096);
  const result = await controlRequestSize(raw, 'responses', {
    triggerBytes: 10_000, targetBytes: 4400, reason: 'learned',
  }, preserve);
  expect(result?.body ?? raw).toEqual(raw);
  expect(result?.removedImages ?? 0).toBe(0);
});

// A single-image rejection must not remove other, smaller images as a side
// effect of treating the image's byte limit as a whole-request byte budget.
it('removes only images still above their learned single-image limit', async () => {
  const raw = Buffer.from(JSON.stringify({ input: [{ role: 'user', content: [
    { type: 'input_image', image_url: `data:image/png;base64,${imageData(1, 4000)}` },
    { type: 'input_image', image_url: `data:image/png;base64,${imageData(2, 800)}` },
    { type: 'input_image', image_url: `data:image/png;base64,${imageData(3, 800)}` },
  ] }] }));
  const result = await controlRequestSize(raw, 'responses', { singleImageMaxBytes: 1000, reason: 'learned' }, preserve);
  const content = JSON.parse(result!.body.toString()).input[0].content;
  expect(result!.removedImages).toBe(1);
  expect(content[0].type).toBe('input_text');
  expect(content.slice(1)).toEqual(JSON.parse(raw.toString()).input[0].content.slice(1));
});

// Rule selection is a production pure entry point: an advertised limit can be
// below actual wire bytes yet above our current trigger. Its target must not
// loosen the default 14 MiB window or a stricter previously learned window.
it('never loosens effective trigger or target when interpreting a rejection limit', () => {
  const MiB = 1024 * 1024;
  const error = { kind: 'request-too-large' as const, limitBytes: 40 * MiB };
  const actual = { bytes: 60 * MiB, images: 3 };
  expect(requestSizeBudgetAfterRejection(undefined, error, actual, 'gpt'))
    .toMatchObject({ triggerBytes: 32 * MiB, targetBytes: 14 * MiB });
  expect(requestSizeBudgetAfterRejection({ triggerBytes: 16 * MiB, targetBytes: 6 * MiB }, error, actual, 'gpt'))
    .toMatchObject({ triggerBytes: 16 * MiB, targetBytes: 6 * MiB });
  const equalLimit = requestSizeBudgetAfterRejection(undefined, { kind: 'request-too-large', limitBytes: 14 * MiB }, { bytes: 14 * MiB, images: 3 }, 'gpt');
  expect(equalLimit.triggerBytes).toBe(Math.floor(14 * MiB * 0.44));
  expect(equalLimit.targetBytes).toBe(Math.floor(equalLimit.triggerBytes! * 0.44));
  // Each dimension decides independently whether its advertised limit explains rejection.
  expect(requestSizeBudgetAfterRejection(undefined, { kind: 'image-count', limitCount: 100, limitBytes: 32000 }, { bytes: 100000, images: 60 }, 'other'))
    .toMatchObject({ triggerBytes: 32000, targetBytes: 14080, triggerImages: 26, targetImages: 11 });
  expect(requestSizeBudgetAfterRejection(undefined, { kind: 'image-count', limitCount: 50, limitBytes: 200000 }, { bytes: 100000, images: 60 }, 'other'))
    .toMatchObject({ triggerBytes: 44000, targetBytes: 19360, triggerImages: 50, targetImages: 22 });
});

// The production/main placeholder carries a JSON string literal, not a raw
// filename. Decode that literal before comparing platform-native paths.
it.each([
  win32.join('C:\\Users', 'User Name', 'media', '截图.png'),
  win32.join('\\\\server\\share', 'media', 'image.png'),
  '/Users/example/My Files/media/image.png',
])('round-trips the quoted path in a media placeholder: %s', async localPath => {
  const raw = Buffer.from(JSON.stringify({ input: [{ role: 'user', content: [
    { type: 'input_image', image_url: `data:image/png;base64,${imageData(1, 4000)}` },
  ] }] }));
  const result = await controlRequestSize(raw, 'responses', { triggerBytes: 1024, targetBytes: 512 }, async () => localPath);
  const text = JSON.parse(result!.body.toString()).input[0].content[0].text as string;
  const quoted = /Preserved local file: ("(?:\\.|[^"\\])*")\./.exec(text)?.[1];
  expect(quoted).toBe(JSON.stringify(localPath));
  expect(JSON.parse(quoted!)).toBe(localPath);
});
