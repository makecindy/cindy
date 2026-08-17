import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { toClaudeSdkContent } from '../../../../../packages/maker-core/src/agents/claude-code/index';
import type { UserMessage } from '../../../../../packages/maker-core/src/types/common';

describe('Claude Code SDK input', () => {
  const tempDirs: string[] = [];

  async function createTempDir(): Promise<string> {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-claude-input-'));
    tempDirs.push(tempDir);
    return tempDir;
  }

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((tempDir) => fs.rm(tempDir, { recursive: true })));
  });

  it('inlines an original image while keeping file attachments as path refs', async () => {
    const tempDir = await createTempDir();
    const imagePath = path.join(tempDir, 'small.png');
    const imageBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    await fs.writeFile(imagePath, imageBytes);
    const imageResizer = {
      process: vi.fn(async (inputPath: string) => inputPath),
      validateBuffer: vi.fn(async () => true),
    };
    const content: UserMessage['content'] = [
      { type: 'text', text: 'Inspect these' },
      { type: 'file', path: 'E:\\repo\\large.txt', mimeType: 'text/plain' },
      { type: 'image', path: imagePath, mimeType: 'image/png' },
    ];

    expect(await toClaudeSdkContent(content, imageResizer)).toEqual([
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/png',
          data: imageBytes.toString('base64'),
        },
      },
      { type: 'text', text: '@"E:\\repo\\large.txt" Inspect these' },
    ]);
    expect(imageResizer.process).toHaveBeenCalledWith(imagePath);
  });

  it('keeps the original Host-managed URI visible when native image bytes are resized', async () => {
    const tempDir = await createTempDir();
    const imagePath = path.join(tempDir, 'managed-source.png');
    const resizedPath = path.join(tempDir, 'managed-resized.webp');
    const managedUrl = 'xdt-image://managed-session/managed.png';
    const resizedBytes = Buffer.from('RIFF0000WEBP', 'ascii');
    await fs.writeFile(resizedPath, resizedBytes);
    const imageResizer = {
      process: vi.fn(async () => resizedPath),
      validateBuffer: vi.fn(async () => true),
    };

    const result = await toClaudeSdkContent([
      { type: 'image', path: imagePath, managedUrl, mimeType: 'image/png' },
      { type: 'text', text: 'Edit this image' },
    ], imageResizer);

    expect(result).toEqual([
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/webp',
          data: resizedBytes.toString('base64'),
        },
      },
      {
        type: 'text',
        text: expect.stringContaining(JSON.stringify({ image: 1, uri: managedUrl })),
      },
    ]);
    expect(JSON.stringify(result)).not.toContain(imagePath);
    expect(JSON.stringify(result)).not.toContain(resizedPath);
  });

  it('uses the resized file format and bytes for the native image block', async () => {
    const tempDir = await createTempDir();
    const sourcePath = path.join(tempDir, 'large.png');
    const resizedPath = path.join(tempDir, 'large.webp');
    const resizedBytes = Buffer.from('RIFF0000WEBP', 'ascii');
    await fs.writeFile(resizedPath, resizedBytes);
    const imageResizer = {
      process: vi.fn(async () => resizedPath),
      validateBuffer: vi.fn(async () => true),
    };
    const content: UserMessage['content'] = [
      { type: 'image', path: sourcePath, mimeType: 'image/png' },
      { type: 'text', text: 'Read the image' },
    ];

    expect(await toClaudeSdkContent(content, imageResizer)).toEqual([
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/webp',
          data: resizedBytes.toString('base64'),
        },
      },
      { type: 'text', text: 'Read the image' },
    ]);
    expect(imageResizer.process).toHaveBeenCalledWith(sourcePath);
  });

  it('uses image bytes instead of a misleading extension or declared MIME type', async () => {
    const tempDir = await createTempDir();
    const imagePath = path.join(tempDir, 'misleading.png');
    const imageBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
    await fs.writeFile(imagePath, imageBytes);
    const imageResizer = {
      process: vi.fn(async () => imagePath),
      validateBuffer: vi.fn(async () => true),
    };
    const content: UserMessage['content'] = [
      { type: 'image', path: imagePath, mimeType: 'image/webp' },
      { type: 'text', text: 'Inspect this' },
    ];

    expect(await toClaudeSdkContent(content, imageResizer)).toEqual([
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/jpeg',
          data: imageBytes.toString('base64'),
        },
      },
      { type: 'text', text: 'Inspect this' },
    ]);
  });

  it('falls back to a quoted path when the final image cannot be read', async () => {
    const tempDir = await createTempDir();
    const missingPath = path.join(tempDir, 'missing.png');
    const imageResizer = {
      process: vi.fn(async () => missingPath),
      validateBuffer: vi.fn(async () => true),
    };
    const content: UserMessage['content'] = [
      { type: 'image', path: missingPath, mimeType: 'image/png' },
      { type: 'text', text: 'Inspect this' },
    ];

    expect(await toClaudeSdkContent(content, imageResizer)).toBe(
      `@"${missingPath}" Inspect this`,
    );
  });

  it('falls back to a quoted path when the final image is too large to embed', async () => {
    const tempDir = await createTempDir();
    const imagePath = path.join(tempDir, 'too-large.png');
    const imageBytes = Buffer.alloc(Math.floor((5 * 1024 * 1024) / 4) * 3 + 1);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(imageBytes);
    await fs.writeFile(imagePath, imageBytes);
    const imageResizer = {
      process: vi.fn(async () => imagePath),
      validateBuffer: vi.fn(async () => true),
    };
    const content: UserMessage['content'] = [
      { type: 'image', path: imagePath, mimeType: 'image/png' },
      { type: 'text', text: 'Inspect this' },
    ];

    expect(await toClaudeSdkContent(content, imageResizer)).toBe(
      `@"${imagePath}" Inspect this`,
    );
  });

  it('allows image data exactly at the encoded inline limit', async () => {
    const tempDir = await createTempDir();
    const imagePath = path.join(tempDir, 'inline-limit.png');
    const imageBytes = Buffer.alloc(Math.floor((5 * 1024 * 1024) / 4) * 3);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(imageBytes);
    await fs.writeFile(imagePath, imageBytes);
    const imageResizer = {
      process: vi.fn(async () => imagePath),
      validateBuffer: vi.fn(async () => true),
    };
    const content: UserMessage['content'] = [
      { type: 'image', path: imagePath, mimeType: 'image/png' },
    ];

    const result = await toClaudeSdkContent(content, imageResizer);

    expect(result).toEqual([
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/png',
          data: imageBytes.toString('base64'),
        },
      },
    ]);
  });

  it('keeps SSH image paths remote even when the same path exists on the desktop', async () => {
    const tempDir = await createTempDir();
    const imagePath = path.join(tempDir, 'remote.png');
    await fs.writeFile(
      imagePath,
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    const imageResizer = {
      process: vi.fn(async () => imagePath),
      validateBuffer: vi.fn(async () => true),
    };
    const content: UserMessage['content'] = [
      { type: 'image', path: imagePath, mimeType: 'image/png' },
      { type: 'text', text: 'Inspect this' },
    ];

    expect(await toClaudeSdkContent(content, imageResizer, false)).toBe(
      `@"${imagePath}" Inspect this`,
    );
    expect(imageResizer.process).not.toHaveBeenCalled();
  });

  it('does not duplicate mention chips already serialized in text', async () => {
    const content: UserMessage['content'] = [
      { type: 'text', text: 'Read @src/app.ts' },
      { type: 'mention', name: 'app.ts', path: 'src/app.ts', kind: 'file' },
    ];

    expect(await toClaudeSdkContent(content)).toBe('Read @src/app.ts');
  });

  it('quotes generated directory refs and preserves the trailing slash', async () => {
    const content: UserMessage['content'] = [
      { type: 'mention', name: 'My Dir', path: 'C:\\My Dir', kind: 'dir' },
    ];

    expect(await toClaudeSdkContent(content)).toBe('@"C:\\My Dir/"');
  });
});
