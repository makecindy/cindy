import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('electron', () => ({ net: { request: mocks.request } }));

import { executeOnce } from '../transport';

it('removes corrupt size-mismatch sidecars and permits a fresh retry', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'download-size-test-'));
  const targetPath = path.join(root, 'artifact');
  const expectedBody = Buffer.from('valid body');
  let body = Buffer.from('short');
  const requests: Array<Record<string, string>> = [];
  mocks.request.mockImplementation(() => {
    const request = new EventEmitter() as EventEmitter & {
      setHeader: (key: string, value: string) => void;
      end: () => void;
      abort: () => void;
    };
    const headers: Record<string, string> = {};
    requests.push(headers);
    request.setHeader = (key, value) => {
      headers[key] = value;
    };
    request.abort = vi.fn();
    request.end = () =>
      queueMicrotask(() => {
        const response = Object.assign(new EventEmitter(), { statusCode: 200, headers: {} });
        request.emit('response', response);
        response.emit('data', body);
        response.emit('end');
      });
    return request;
  });
  const context = () => ({
    opts: {
      url: 'https://example.invalid/artifact',
      targetPath,
      expectedSize: expectedBody.length,
      sha256: createHash('sha256').update(expectedBody).digest('hex'),
    },
    logger: {},
    resumedFromBytes: 0,
  });
  try {
    await expect(executeOnce(context())).rejects.toMatchObject({ code: 'CHECKSUM' });
    for (const file of [targetPath, targetPath + '.part', targetPath + '.meta.json']) {
      await expect(fs.stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
    }
    body = expectedBody;
    await expect(executeOnce(context())).resolves.toMatchObject({ size: expectedBody.length });
    expect(requests).toEqual([{}, {}]);
    expect(await fs.readFile(targetPath)).toEqual(expectedBody);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
