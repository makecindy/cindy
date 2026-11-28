import { describe, expect, it } from 'vitest';

import {
  createInvalidImageBlockNoticeTransform,
  hasCompleteImageContainer,
  INVALID_IMAGE_BLOCK_NOTICE,
} from '../invalid-image-block-notice.js';

const VALID_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAAEAAQDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDi6KKK+ZP3E//Z',
  'base64',
);
const VALID_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAE0lEQVR4nGNkYPjPAANMcBZeDgAx0wEH1s7nlgAAAABJRU5ErkJggg==',
  'base64',
);

function dataUrl(bytes: Buffer, mime = 'image/jpeg'): string {
  return `data:${mime};base64,${bytes.toString('base64')}`;
}

function bodyWithToolOutput(imageUrl: string): Record<string, unknown> {
  return {
    model: 'deepseek/deepseek-v4.1-flash',
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'check this' }] },
      {
        type: 'custom_tool_call_output',
        call_id: 'call_shot',
        output: [
          { type: 'input_text', text: 'Script completed' },
          { type: 'input_image', image_url: imageUrl, detail: 'high' },
        ],
      },
    ],
  };
}

describe('invalid image block notice', () => {
  const transform = createInvalidImageBlockNoticeTransform();

  it('recognises complete containers and rejects truncated ones', () => {
    expect(hasCompleteImageContainer(VALID_JPEG)).toBe(true);
    expect(hasCompleteImageContainer(Buffer.concat([VALID_JPEG, Buffer.from('cameralbum!')]))).toBe(true);
    expect(hasCompleteImageContainer(VALID_JPEG.subarray(0, VALID_JPEG.length - 2))).toBe(false);
    expect(hasCompleteImageContainer(VALID_PNG)).toBe(true);
    expect(hasCompleteImageContainer(VALID_PNG.subarray(0, VALID_PNG.length - 12))).toBe(false);
  });

  it('replaces a truncated tool-result image with text and keeps the call pairing', () => {
    const truncated = VALID_JPEG.subarray(0, VALID_JPEG.length - 2);
    const output = transform(bodyWithToolOutput(dataUrl(truncated)));
    expect(output).not.toBeNull();
    const json = JSON.stringify(output);
    expect(json).toContain('call_shot');
    expect(json).toContain(INVALID_IMAGE_BLOCK_NOTICE);
    expect(json).not.toContain(';base64,');
    const toolOutput = (output as Record<string, unknown>).input as Record<string, unknown>[];
    expect(toolOutput[1].output).toEqual([
      { type: 'input_text', text: 'Script completed' },
      { type: 'input_text', text: INVALID_IMAGE_BLOCK_NOTICE },
    ]);
  });

  it('replaces a truncated PNG in ordinary user content', () => {
    const truncated = VALID_PNG.subarray(0, VALID_PNG.length - 12);
    const body = {
      input: [
        {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: 'screenshot' },
            { type: 'input_image', image_url: dataUrl(truncated, 'image/png') },
          ],
        },
      ],
    };
    const output = transform(body);
    expect(JSON.stringify(output)).toContain(INVALID_IMAGE_BLOCK_NOTICE);
    expect(JSON.stringify(output)).not.toContain(';base64,');
  });

  it('leaves valid images, trailing metadata, remote URLs and non-image blocks alone', () => {
    expect(transform(bodyWithToolOutput(dataUrl(VALID_JPEG)))).toBeNull();
    expect(
      transform(bodyWithToolOutput(dataUrl(Buffer.concat([VALID_JPEG, Buffer.from('cameralbum!')])))),
    ).toBeNull();
    expect(transform(bodyWithToolOutput('https://example.com/shot.jpg'))).toBeNull();
    expect(
      transform({
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
      }),
    ).toBeNull();
  });

  it('drops a bad image_url from a non-input_image object but keeps sibling metadata', () => {
    const truncated = VALID_JPEG.subarray(0, VALID_JPEG.length - 2);
    const body = {
      input: [
        {
          type: 'custom_tool_call_output',
          call_id: 'call_meta',
          output: { type: 'tool_meta', caption: 'login screen', image_url: dataUrl(truncated) },
        },
      ],
    };
    const output = transform(body);
    expect(JSON.stringify(output)).toContain('login screen');
    expect(JSON.stringify(output)).toContain('call_meta');
    expect(JSON.stringify(output)).not.toContain(';base64,');
  });
});
