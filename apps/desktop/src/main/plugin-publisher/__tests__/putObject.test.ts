import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { PluginPublisherPutError, putLocalFile } from '../putObject.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

async function openTemp(bytes = Buffer.from('cindy-package')) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-publisher-put-'));
  tempDirs.push(dir);
  const filePath = path.join(dir, 'pkg.cindy');
  await fs.writeFile(filePath, bytes);
  return { handle: await fs.open(filePath, 'r'), sizeBytes: bytes.length };
}

const headers = {
  'Content-Type': 'application/octet-stream',
  'x-oss-forbid-overwrite': 'true',
};

describe('putLocalFile', () => {
  it('sets Content-Length and rejects 3xx', async () => {
    const { handle, sizeBytes } = await openTemp();
    const requestImpl = vi.fn(async (_url: string, init: { headers?: Record<string, string> }) => {
      expect(init.headers?.['content-length']).toBe(String(sizeBytes));
      expect(init.headers?.['Content-Type']).toBe('application/octet-stream');
      expect(init.headers?.['x-oss-forbid-overwrite']).toBe('true');
      return {
        statusCode: 302,
        body: { dump: async () => undefined },
      };
    });
    try {
      await expect(
        putLocalFile(handle, {
          putUrl: 'https://bucket.example.test/object',
          headers,
          sizeBytes,
          requestImpl: requestImpl as never,
          resolveDispatcher: async () => undefined,
        }),
      ).rejects.toMatchObject({ disposition: 'retry_same_url', status: 302 });
    } finally {
      await handle.close();
    }
  });

  it('treats 409 as already uploaded', async () => {
    const { handle, sizeBytes } = await openTemp();
    try {
      await expect(
        putLocalFile(handle, {
          putUrl: 'https://bucket.example.test/object',
          headers,
          sizeBytes,
          requestImpl: async () =>
            ({
              statusCode: 409,
              body: { dump: async () => undefined },
            }) as never,
          resolveDispatcher: async () => undefined,
        }),
      ).resolves.toEqual({ bytesSent: sizeBytes });
    } finally {
      await handle.close();
    }
  });

  it('commits the same upload after 5xx', async () => {
    const { handle, sizeBytes } = await openTemp();
    try {
      await expect(
        putLocalFile(handle, {
          putUrl: 'https://bucket.example.test/object',
          headers,
          sizeBytes,
          requestImpl: async () =>
            ({
              statusCode: 500,
              body: { dump: async () => undefined },
            }) as never,
          resolveDispatcher: async () => undefined,
        }),
      ).rejects.toMatchObject({ disposition: 'commit_same_upload', status: 500 });
    } finally {
      await handle.close();
    }
  });

  it('aborts a stall after queued bytes as commit_same_upload', async () => {
    const { handle, sizeBytes } = await openTemp();
    let now = 1_000;
    try {
      await expect(
        putLocalFile(handle, {
          putUrl: 'https://bucket.example.test/object',
          headers,
          sizeBytes,
          stallTimeoutMs: 20,
          now: () => now,
          requestImpl: async (_url, init) => {
            // Do not consume body: queued bytes would flip this to commit_same_upload.
            await new Promise<void>((_resolve, reject) => {
              const timer = setInterval(() => {
                now += 30;
              }, 5);
              const signal = (init as { signal?: AbortSignal }).signal;
              signal?.addEventListener(
                'abort',
                () => {
                  clearInterval(timer);
                  reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
                },
                { once: true },
              );
            });
            return { statusCode: 200, body: { dump: async () => undefined } };
          },
          resolveDispatcher: async () => undefined,
        }),
      ).rejects.toMatchObject({ disposition: 'commit_same_upload' });
    } finally {
      await handle.close();
    }
  });

  it('delivers the full file after a delayed dispatcher resolve', async () => {
    const payload = Buffer.alloc(256 * 1024);
    payload[0] = 0xab;
    payload[payload.length - 1] = 0xcd;
    const { handle, sizeBytes } = await openTemp(payload);
    const received: Buffer[] = [];
    let queued = 0;
    try {
      const result = await putLocalFile(handle, {
        putUrl: 'https://bucket.example.test/object',
        headers,
        sizeBytes,
        requestImpl: async (_url, init) => {
          expect(Buffer.isBuffer(init.body)).toBe(false);
          expect(queued).toBeLessThan(sizeBytes);
          for await (const chunk of init.body) {
            received.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          }
          return {
            statusCode: 200,
            body: { dump: async () => undefined },
          };
        },
        onBytes: (bytesSent) => {
          queued = bytesSent;
        },
        resolveDispatcher: async () => {
          await new Promise((resolve) => setTimeout(resolve, 20));
          return undefined;
        },
      });
      const body = Buffer.concat(received);
      expect(result.bytesSent).toBe(sizeBytes);
      expect(body.length).toBe(sizeBytes);
      expect(body[0]).toBe(0xab);
      expect(body[body.length - 1]).toBe(0xcd);
    } finally {
      await handle.close();
    }
  });

  it('treats cancel after queued bytes as uncertain', async () => {
    const { handle, sizeBytes } = await openTemp(Buffer.alloc(128 * 1024, 1));
    const controller = new AbortController();
    try {
      await expect(
        putLocalFile(handle, {
          putUrl: 'https://bucket.example.test/object',
          headers,
          sizeBytes,
          signal: controller.signal,
          requestImpl: async (_url, init) => {
            const body = init.body;
            body?.once('data', () => controller.abort());
            await new Promise<void>((_resolve, reject) => {
              (init as { signal?: AbortSignal }).signal?.addEventListener(
                'abort',
                () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
                { once: true },
              );
            });
            return { statusCode: 200, body: { dump: async () => undefined } };
          },
          resolveDispatcher: async () => undefined,
        }),
      ).rejects.toMatchObject({ disposition: 'cancelled_uncertain' });
    } finally {
      await handle.close();
    }
  });

  it('treats cancel before any queued bytes as incomplete', async () => {
    const { handle, sizeBytes } = await openTemp(Buffer.alloc(128 * 1024, 1));
    const controller = new AbortController();
    try {
      await expect(
        putLocalFile(handle, {
          putUrl: 'https://bucket.example.test/object',
          headers,
          sizeBytes,
          signal: controller.signal,
          requestImpl: async (_url, init) => {
            controller.abort();
            const signal = (init as { signal?: AbortSignal }).signal;
            if (signal?.aborted) {
              throw Object.assign(new Error('aborted'), { name: 'AbortError' });
            }
            await new Promise<void>((_resolve, reject) => {
              signal?.addEventListener(
                'abort',
                () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
                { once: true },
              );
            });
            return { statusCode: 200, body: { dump: async () => undefined } };
          },
          resolveDispatcher: async () => undefined,
        }),
      ).rejects.toMatchObject({ disposition: 'cancelled_incomplete' });
    } finally {
      await handle.close();
    }
  });
});
