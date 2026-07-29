/**
 * imageRefParseUserContent.test.ts
 * ---------------------------------------------------------------------------
 * Regression tests for `parseUserContent` (apps/desktop/src/renderer/lib/imageRef.ts).
 *
 * Bug context (round 1): historical user messages were rendered as raw JSON
 * strings in the chat bubble after the localDb mapper started JSON.parse-ing
 * the TEXT column back into objects/arrays. parseUserContent's old defensive
 * branch blindly stringified non-string input, surfacing the parsed object
 * as text.
 *
 * Bug context (round 2): non-image file attachments (.txt / .pdf) on user
 * messages were never persisted to the DB at all — the chip vanished after
 * a restart. Fixed by extending UserMessageContent with a `files: FileRef[]`
 * field and threading it through stringify / parse / mapServerMessages.
 *
 * These tests pin down the type-dispatched contract (string / array / object
 * / unknown fallback) for both `images` and `files` so neither regression
 * can reappear silently.
 */

import { describe, it, expect } from 'vitest';
import {
  parseUserContent,
  stringifyUserContent,
  type ImageRef,
  type FileRef,
  type PastedTextRange,
  type SlashCommandRange,
} from '@/lib/imageRef';

const ATTACHMENT_SHA256 = 'a'.repeat(64);

const validImage: ImageRef = {
  url: 'xdt-image://session-abc/img-001.png',
  mimeType: 'image/png',
  originalName: 'screenshot.png',
};

const validFile: FileRef = {
  name: 'notes.txt',
  path: '/Users/sam/Desktop/notes.txt',
};

const validFile2: FileRef = {
  name: 'spec.pdf',
  path: '/Users/sam/Documents/spec.pdf',
};

// ── Branch 1: string ────────────────────────────────────────────────────────

describe('parseUserContent — string input', () => {
  it('returns plain text untouched (legacy non-JSON content)', () => {
    expect(parseUserContent('hello world')).toEqual({
      text: 'hello world',
      images: [],
      files: [],
    });
  });

  it('returns empty text for empty string', () => {
    expect(parseUserContent('')).toEqual({ text: '', images: [], files: [] });
  });

  it('parses a stringified {text, images} payload', () => {
    const raw = stringifyUserContent('你好', [validImage]);
    expect(parseUserContent(raw)).toEqual({
      text: '你好',
      images: [validImage],
      files: [],
    });
  });

  it('parses a stringified {text, images} with empty images', () => {
    const raw = stringifyUserContent('only text', []);
    expect(parseUserContent(raw)).toEqual({
      text: 'only text',
      images: [],
      files: [],
    });
  });

  it('parses a stringified SDK content-block array', () => {
    const raw = JSON.stringify([
      { type: 'text', text: '你好,' },
      { type: 'text', text: ' world' },
      { type: 'image', source: { type: 'base64', data: '...' } },
    ]);
    expect(parseUserContent(raw)).toEqual({
      text: '你好, world',
      images: [],
      files: [],
    });
  });

  it('treats malformed JSON starting with { as plain text', () => {
    expect(parseUserContent('{not valid json')).toEqual({
      text: '{not valid json',
      images: [],
      files: [],
    });
  });

  it('treats malformed JSON starting with [ as plain text', () => {
    expect(parseUserContent('[broken')).toEqual({
      text: '[broken',
      images: [],
      files: [],
    });
  });

  it('does not attempt JSON parse for strings not starting with { or [', () => {
    // A string that happens to contain { later should NOT trigger parsing.
    expect(parseUserContent('hello {there}')).toEqual({
      text: 'hello {there}',
      images: [],
      files: [],
    });
  });

  it('filters out invalid image refs from a parsed string payload', () => {
    const raw = JSON.stringify({
      text: 'mixed',
      images: [
        validImage,
        { url: 'http://wrong-protocol.com/x.png', mimeType: 'image/png', originalName: 'x.png' },
        { url: 'xdt-image://s/ok.png' /* missing mimeType/originalName */ },
        null,
        'not-an-object',
      ],
    });
    expect(parseUserContent(raw)).toEqual({
      text: 'mixed',
      images: [validImage],
      files: [],
    });
  });

  // ── new: files persistence on string payloads ──────────────────────────────

  it('parses a stringified {text, images, files} payload (full triple)', () => {
    const raw = stringifyUserContent('看下这个文件', [validImage], [validFile]);
    expect(parseUserContent(raw)).toEqual({
      text: '看下这个文件',
      images: [validImage],
      files: [validFile],
    });
  });

  it('parses a stringified {text, images, files} payload with empty files', () => {
    const raw = stringifyUserContent('still has file slot', [], []);
    expect(parseUserContent(raw)).toEqual({
      text: 'still has file slot',
      images: [],
      files: [],
    });
  });
});

// ── Branch 2: array (SDK-native content blocks) ────────────────────────────

describe('parseUserContent — array input (SDK content blocks)', () => {
  it('concatenates text blocks', () => {
    const blocks = [
      { type: 'text', text: '你好' },
      { type: 'text', text: '世界' },
    ];
    expect(parseUserContent(blocks)).toEqual({
      text: '你好世界',
      images: [],
      files: [],
    });
  });

  it('drops image blocks but keeps text blocks', () => {
    const blocks = [
      { type: 'text', text: 'before ' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'xxx' } },
      { type: 'text', text: 'after' },
    ];
    expect(parseUserContent(blocks)).toEqual({
      text: 'before after',
      images: [],
      files: [],
    });
  });

  it('returns empty text for empty array', () => {
    expect(parseUserContent([])).toEqual({ text: '', images: [], files: [] });
  });

  it('restores persisted IM image blocks from cindy-media URLs', () => {
    const url = `cindy-media://blobs/${ATTACHMENT_SHA256}.png`;
    const blocks = [
      {
        type: 'image',
        path: 'C:\\Users\\User\\wechat-image.png',
        mimeType: 'image/png',
        url,
      },
    ];
    expect(parseUserContent(blocks)).toEqual({
      text: '',
      images: [{ url, mimeType: 'image/png', originalName: 'wechat-image.png' }],
      files: [],
    });
  });

  it('returns empty text for array of only image blocks', () => {
    const blocks = [{ type: 'image', source: {} }];
    expect(parseUserContent(blocks)).toEqual({ text: '', images: [], files: [] });
  });

  it('skips malformed blocks (null, primitives, missing fields)', () => {
    const blocks = [
      null,
      'not-an-object',
      42,
      { type: 'text' /* missing text */ },
      { type: 'text', text: 'kept' },
      { type: 'unknown', text: 'dropped' },
    ];
    expect(parseUserContent(blocks)).toEqual({
      text: 'kept',
      images: [],
      files: [],
    });
  });

  it('restores legacy IM file blocks', () => {
    const blocks = [
      { type: 'text', text: 'hi' },
      { type: 'document', source: { type: 'base64', data: '...' } },
      { type: 'file', name: 'x.txt', path: '/x' },
    ];
    expect(parseUserContent(blocks)).toEqual({
      text: 'hi',
      images: [],
      files: [{ name: 'x.txt', path: '/x' }],
    });
  });
});

// ── Branch 3: object ({text, images, files} already parsed) ────────────────

describe('parseUserContent — object input ({text, images, files})', () => {
  it('reads text and validates images on a typed object', () => {
    const obj = { text: 'hi', images: [validImage] };
    expect(parseUserContent(obj)).toEqual({
      text: 'hi',
      images: [validImage],
      files: [],
    });
  });

  it('coerces non-array images field to empty list', () => {
    const obj = { text: 'hi', images: 'not-an-array' };
    expect(parseUserContent(obj)).toEqual({ text: 'hi', images: [], files: [] });
  });

  it('handles object without images field', () => {
    const obj = { text: 'hi' };
    expect(parseUserContent(obj)).toEqual({ text: 'hi', images: [], files: [] });
  });

  it('filters invalid image refs in a typed object', () => {
    const obj = {
      text: 'hi',
      images: [
        validImage,
        { url: 'http://wrong/x.png', mimeType: 'image/png', originalName: 'x.png' },
      ],
    };
    expect(parseUserContent(obj)).toEqual({
      text: 'hi',
      images: [validImage],
      files: [],
    });
  });

  it('falls back to JSON.stringify for unknown object shapes', () => {
    // No `text` field — preserve old defensive behaviour as a last resort.
    const obj = { foo: 'bar', baz: 1 };
    expect(parseUserContent(obj)).toEqual({
      text: '{"foo":"bar","baz":1}',
      images: [],
      files: [],
    });
  });

  // ── new: files extraction on object inputs ────────────────────────────────

  it('extracts files from object input', () => {
    const obj = { text: 'with file', images: [], files: [validFile] };
    expect(parseUserContent(obj)).toEqual({
      text: 'with file',
      images: [],
      files: [validFile],
    });
  });

  it('extracts both images and files together', () => {
    const obj = { text: 'both', images: [validImage], files: [validFile, validFile2] };
    expect(parseUserContent(obj)).toEqual({
      text: 'both',
      images: [validImage],
      files: [validFile, validFile2],
    });
  });

  it('preserves valid attachment integrity metadata', () => {
    const image = { ...validImage, size: 128, sha256: ATTACHMENT_SHA256 };
    const file = { ...validFile, size: 256, sha256: ATTACHMENT_SHA256 };

    expect(parseUserContent({ text: 'integrity', images: [image], files: [file] })).toEqual({
      text: 'integrity',
      images: [image],
      files: [file],
    });
  });

  it('filters out invalid file refs', () => {
    const obj = {
      text: 'mixed files',
      images: [],
      files: [
        validFile,
        { name: 1, path: '/x' }, // name not string
        { name: 'a.txt' /* missing path */ },
        { path: '/y' /* missing name */ },
        null,
        'not-an-object',
        42,
      ],
    };
    expect(parseUserContent(obj)).toEqual({
      text: 'mixed files',
      images: [],
      files: [validFile],
    });
  });

  it('treats non-array files field as empty', () => {
    const obj = { text: 'hi', images: [], files: 'not-an-array' };
    expect(parseUserContent(obj)).toEqual({ text: 'hi', images: [], files: [] });
  });

  // ── mobile schema drift: `name` instead of `originalName` ─────────────────

  it('accepts mobile-persisted image refs using `name` and normalises to originalName', () => {
    // Historical apps/mobile buildAttachmentPersistImageRefs wrote `name`
    // instead of `originalName`; those refs were silently filtered and the
    // image never rendered on desktop. Stored messages must keep working.
    const mobileRef = {
      url: 'xdt-image://session-abc/49c4c61b-1783422697036.jpg',
      name: '85070F33.jpg',
      mimeType: 'image/jpeg',
    };
    const obj = { text: '你看看这个对吗', images: [mobileRef], files: [] };
    expect(parseUserContent(obj)).toEqual({
      text: '你看看这个对吗',
      images: [
        {
          url: 'xdt-image://session-abc/49c4c61b-1783422697036.jpg',
          mimeType: 'image/jpeg',
          originalName: '85070F33.jpg',
        },
      ],
      files: [],
    });
  });

  it('prefers originalName over name when both are present', () => {
    const ref = {
      url: 'xdt-image://s/a.png',
      originalName: 'primary.png',
      name: 'secondary.png',
      mimeType: 'image/png',
    };
    const result = parseUserContent({ text: 'both fields', images: [ref] });
    expect(result.images).toEqual([
      { url: 'xdt-image://s/a.png', mimeType: 'image/png', originalName: 'primary.png' },
    ]);
  });

  it('still rejects image refs with neither originalName nor name', () => {
    const ref = { url: 'xdt-image://s/a.png', mimeType: 'image/png' };
    expect(parseUserContent({ text: 'no name', images: [ref] })).toEqual({
      text: 'no name',
      images: [],
      files: [],
    });
  });

  it('legacy {text, images} object still parses (files defaults to [])', () => {
    // Historical messages persisted before round-2 fix won't have a `files`
    // field. Make sure they don't blow up — files is just `[]`.
    const obj = { text: 'old message', images: [validImage] };
    expect(parseUserContent(obj)).toEqual({
      text: 'old message',
      images: [validImage],
      files: [],
    });
  });
});

// ── Branch 4: defensive fallback (null / undefined / primitives) ───────────

describe('parseUserContent — fallback for null/undefined/primitives', () => {
  it('returns empty text for null', () => {
    expect(parseUserContent(null)).toEqual({ text: '', images: [], files: [] });
  });

  it('returns empty text for undefined', () => {
    expect(parseUserContent(undefined)).toEqual({ text: '', images: [], files: [] });
  });

  it('coerces numbers to string text', () => {
    expect(parseUserContent(42)).toEqual({ text: '42', images: [], files: [] });
  });

  it('coerces booleans to string text', () => {
    expect(parseUserContent(true)).toEqual({ text: 'true', images: [], files: [] });
  });
});

// ── Round-trip: stringifyUserContent → JSON.parse → parseUserContent ──────

describe('parseUserContent — round-trip with localDb mapper simulation', () => {
  it('round-trips long-paste display ranges without adding markers to text', () => {
    const text = 'before long pasted text after';
    const ranges: PastedTextRange[] = [{ start: 7, end: 23, display: 'Pasted text (1 line)' }];
    const persisted = stringifyUserContent(text, [], [], false, ranges);

    expect(parseUserContent(JSON.parse(persisted))).toEqual({
      text,
      images: [],
      files: [],
      pastedTextRanges: ranges,
    });
    expect(JSON.parse(persisted).text).toBe(text);
  });

  it('drops malformed or overlapping long-paste ranges as one invalid set', () => {
    const parsed = parseUserContent({
      text: 'abcdef',
      images: [],
      files: [],
      pastedTextRanges: [
        { start: 1, end: 4, display: 'first' },
        { start: 3, end: 5, display: 'overlap' },
      ],
    });

    expect(parsed.pastedTextRanges).toBeUndefined();
  });

  it('round-trips exact slash ranges, including an explicit empty set', () => {
    const text = '/git then /help';
    const ranges: SlashCommandRange[] = [
      { start: 0, end: 4 },
      { start: 10, end: 15 },
    ];

    expect(
      parseUserContent(JSON.parse(stringifyUserContent(text, [], [], false, [], ranges))),
    ).toMatchObject({ text, slashCommandRanges: ranges });
    expect(
      parseUserContent(JSON.parse(stringifyUserContent('/unknown', [], [], false, [], []))),
    ).toMatchObject({ text: '/unknown', slashCommandRanges: [] });
  });

  it('round-trips structured reference metadata without changing bubble text', () => {
    const href = 'cindy://session/session-a?message=message-a';
    const text = `inspect ${href}`;
    const references = [{
      kind: 'message' as const,
      start: text.indexOf(href),
      end: text.length,
      href,
      sessionId: 'session-a',
      messageClientId: 'message-a',
      text: 'Complete target message body',
    }];
    const persisted = stringifyUserContent(text, [], [], false, [], [], [], references);

    expect(parseUserContent(JSON.parse(persisted))).toMatchObject({
      text,
      agentReferences: references,
    });
    expect(JSON.parse(persisted)).toMatchObject({ text, agentReferences: references });
  });

  it('drops malformed slash ranges so corrupted history uses legacy compatibility', () => {
    const parsed = parseUserContent({
      text: 'not-a-command',
      images: [],
      files: [],
      slashCommandRanges: [{ start: 0, end: 3 }],
    });

    expect(parsed.slashCommandRanges).toBeUndefined();
  });

  it('handles text-only content round-tripped through messageToCamel', () => {
    // Simulate: stringifyUserContent saves to DB → messageToCamel JSON.parses back.
    const persisted = stringifyUserContent('repeat after me', []);
    const afterMapper: unknown = JSON.parse(persisted);
    expect(parseUserContent(afterMapper)).toEqual({
      text: 'repeat after me',
      images: [],
      files: [],
    });
  });

  it('handles content with images round-tripped through messageToCamel', () => {
    const persisted = stringifyUserContent('with picture', [validImage]);
    const afterMapper: unknown = JSON.parse(persisted);
    expect(parseUserContent(afterMapper)).toEqual({
      text: 'with picture',
      images: [validImage],
      files: [],
    });
  });

  it('does NOT surface raw JSON in the rendered text (regression guard)', () => {
    // The exact failure mode: an object payload landed in the renderer and was
    // stringified into the bubble. Now the text field must be the user's input.
    const persisted = stringifyUserContent('你好', []);
    const afterMapper: unknown = JSON.parse(persisted);
    const result = parseUserContent(afterMapper);
    expect(result.text).toBe('你好');
    expect(result.text).not.toContain('{');
    expect(result.text).not.toContain('"text"');
  });

  it('handles SDK array content round-tripped (cloud migration path)', () => {
    const persisted = JSON.stringify([{ type: 'text', text: '历史消息' }]);
    const afterMapper: unknown = JSON.parse(persisted);
    expect(parseUserContent(afterMapper)).toEqual({
      text: '历史消息',
      images: [],
      files: [],
    });
  });

  // ── new: round-trip triple guards (text + image + file) ───────────────────

  it('round-trip: text + image + file survives stringify+parse (full triple)', () => {
    // The full happy path: every field has data. After persist+restart the
    // chip and the image and the text all come back identically.
    const persisted = stringifyUserContent('完整三元组', [validImage], [validFile]);
    const afterMapper: unknown = JSON.parse(persisted);
    expect(parseUserContent(afterMapper)).toEqual({
      text: '完整三元组',
      images: [validImage],
      files: [validFile],
    });
  });

  it('round-trip: text + file only (no image) — adventurer .txt scenario', () => {
    // This is the EXACT case the adventurer hit: attach a .txt file, send,
    // restart. The chip MUST be back. If this test ever fails, the round-2
    // bug has regressed.
    const persisted = stringifyUserContent('看下这个文件', [], [validFile]);
    const afterMapper: unknown = JSON.parse(persisted);
    const result = parseUserContent(afterMapper);
    expect(result.text).toBe('看下这个文件');
    expect(result.images).toEqual([]);
    expect(result.files).toEqual([validFile]);
  });

  it('round-trip: invalid file shapes get filtered after parse', () => {
    // Simulate someone (a buggy future writer) shipping a malformed file ref
    // through DB. The reader must defensively drop it, not throw.
    const malformed = JSON.stringify({
      text: 'defensive',
      images: [],
      files: [validFile, { name: 'no-path.txt' }, null, 'oops'],
    });
    const afterMapper: unknown = JSON.parse(malformed);
    expect(parseUserContent(afterMapper)).toEqual({
      text: 'defensive',
      images: [],
      files: [validFile],
    });
  });
});

describe('parseUserContent annotation metadata passthrough (non-destructive annotations)', () => {
  const base = {
    url: 'xdt-image://s/burned.png',
    mimeType: 'image/png',
    originalName: 'burned.png',
  };
  const strokes = [
    {
      points: [
        { x: 0.1, y: 0.2 },
        { x: 0.3, y: 0.4 },
      ],
    },
  ];

  it('carries valid annotationSourceUrl + annotationStrokes through parsing', () => {
    const content = JSON.stringify({
      text: 'hi',
      images: [
        { ...base, annotationSourceUrl: 'xdt-image://s/orig.png', annotationStrokes: strokes },
      ],
      files: [],
    });
    const parsed = parseUserContent(content);
    expect(parsed.images[0].annotationSourceUrl).toBe('xdt-image://s/orig.png');
    expect(parsed.images[0].annotationStrokes).toEqual(strokes);
  });

  it('drops annotation fields as a pair when strokes are malformed', () => {
    const content = JSON.stringify({
      text: 'hi',
      images: [
        {
          ...base,
          annotationSourceUrl: 'xdt-image://s/orig.png',
          annotationStrokes: [{ points: [{ x: 'bad', y: 0 }] }],
        },
      ],
      files: [],
    });
    const parsed = parseUserContent(content);
    expect(parsed.images[0].annotationSourceUrl).toBeUndefined();
    expect(parsed.images[0].annotationStrokes).toBeUndefined();
    expect(parsed.images[0].url).toBe(base.url);
  });

  it('drops annotation fields (without throwing) when a stroke point is null', () => {
    const content = JSON.stringify({
      text: 'hi',
      images: [
        {
          ...base,
          annotationSourceUrl: 'xdt-image://s/orig.png',
          annotationStrokes: [{ points: [null, { x: 0.1, y: 0.2 }] }],
        },
      ],
      files: [],
    });
    const parsed = parseUserContent(content);
    expect(parsed.images[0].url).toBe(base.url);
    expect(parsed.images[0].annotationSourceUrl).toBeUndefined();
    expect(parsed.images[0].annotationStrokes).toBeUndefined();
  });

  it('drops annotation fields when the source url is not an xdt-image url', () => {
    const content = JSON.stringify({
      text: 'hi',
      images: [{ ...base, annotationSourceUrl: 'file:///etc/x.png', annotationStrokes: strokes }],
      files: [],
    });
    const parsed = parseUserContent(content);
    expect(parsed.images[0].annotationSourceUrl).toBeUndefined();
  });
});

describe('parseUserContent session reference metadata', () => {
  it('round-trips range, actual message count and truncation without localizing content', () => {
    const sessionReferences = [
      {
        sessionId: 'session-linked',
        messageClientId: 'message-anchor',
        range: 'around-anchor' as const,
        messageCount: 9,
        truncated: true,
      },
    ];
    const persisted = stringifyUserContent(
      'See the linked session',
      [],
      [],
      false,
      sessionReferences,
    );

    expect(parseUserContent(persisted)).toEqual({
      text: 'See the linked session',
      images: [],
      files: [],
      sessionReferences,
    });
    expect(persisted).not.toContain('Around linked message');
    expect(persisted).not.toContain('truncated messages');
  });

  it('drops malformed metadata without affecting the user message', () => {
    expect(
      parseUserContent({
        text: 'Still visible',
        images: [],
        files: [],
        sessionReferences: [
          { sessionId: 'session-linked', range: 'recent', messageCount: -1, truncated: false },
        ],
      }),
    ).toEqual({ text: 'Still visible', images: [], files: [] });
  });
});
