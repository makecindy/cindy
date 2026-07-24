import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.hoisted(() => vi.fn());
vi.mock('electron', () => ({ net: { fetch: fetchMock } }));

import { downloadVerifiedPlugin } from '../download';

const files: string[] = [];

afterEach(() => {
  fetchMock.mockReset();
  for (const file of files.splice(0)) fs.rmSync(file, { force: true });
});
function target(): string {
  const file = path.join(
    os.tmpdir(),
    `cindy-plugin-download-${process.pid}-${Date.now()}-${Math.random()}.cindy`,
  );
  files.push(file);
  return file;
}

function expected(bytes: Buffer) {
  return {
    sizeBytes: bytes.byteLength,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
  };
}

describe('downloadVerifiedPlugin', () => {
  it('writes only bytes matching the release size and SHA-256', async () => {
    const bytes = Buffer.from('verified plugin bytes');
    fetchMock.mockResolvedValue(
      new Response(bytes, {
        status: 200,
        headers: { 'content-length': String(bytes.byteLength) },
      }),
    );
    const file = target();

    await downloadVerifiedPlugin('https://downloads.example.test/a', expected(bytes), file);

    expect(fs.readFileSync(file)).toEqual(bytes);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://downloads.example.test/a',
      expect.objectContaining({ redirect: 'error', cache: 'no-store' }),
    );
  });

  it('rejects a SHA mismatch without writing the target', async () => {
    const bytes = Buffer.from('tampered');
    fetchMock.mockResolvedValue(new Response(bytes, { status: 200 }));
    const file = target();

    await expect(
      downloadVerifiedPlugin('https://downloads.example.test/a', {
        ...expected(bytes),
        sha256: '0'.repeat(64),
      }, file),
    ).rejects.toThrow('SHA-256');
    expect(fs.existsSync(file)).toBe(false);
  });

  it('stops when the stream exceeds the declared release size', async () => {
    const bytes = Buffer.from('larger-than-declared');
    fetchMock.mockResolvedValue(new Response(bytes, { status: 200 }));

    await expect(
      downloadVerifiedPlugin(
        'https://downloads.example.test/a',
        { sizeBytes: 3, sha256: '0'.repeat(64) },
        target(),
      ),
    ).rejects.toThrow('超过');
  });

  it('cancels the response body when Content-Length mismatches the release', async () => {
    const bytes = Buffer.from('mismatched length');
    const response = new Response(bytes, {
      status: 200,
      headers: { 'content-length': String(bytes.byteLength + 1) },
    });
    const cancel = vi.spyOn(response.body!, 'cancel');
    fetchMock.mockResolvedValue(response);

    await expect(
      downloadVerifiedPlugin(
        'https://downloads.example.test/a',
        expected(bytes),
        target(),
      ),
    ).rejects.toThrow('Content-Length');
    expect(cancel).toHaveBeenCalledOnce();
  });
});
