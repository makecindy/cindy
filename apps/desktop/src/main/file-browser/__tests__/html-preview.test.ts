import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { get } from 'node:http';
import { listDir } from '@cindy/file-browser-core';
import { createHtmlPreview, copyPreviewFile, previewLocation, type PreviewSource } from '../html-preview';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-preview-test-'));
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.mkdir(path.join(dir, 'dist'));
  await fs.writeFile(
    path.join(dir, 'index.html'),
    '<script type="module" src="/dist/app.js"></script>',
  );
  await fs.writeFile(path.join(dir, 'dist/app.js'), 'export const test = true;');
  const source: PreviewSource = {
    list: (root, rel) => listDir(root, rel),
    read: async (root, entry) => path.join(root, entry.relPath),
    materialize: async (from, to) => {
      await fs.copyFile(from, to);
      return to;
    },
  };
  return {
    dir,
    source,
    args: {
      origin: { kind: 'local' as const },
      workdir: dir,
      absPath: path.join(dir, 'index.html'),
    },
  };
}
describe('directory HTML preview', () => {
  it('bounds copies and refuses links instead of reading their targets', async () => {
    const { dir } = await fixture();
    const source = path.join(dir, 'index.html');
    const size = (await fs.stat(source)).size;
    const dest = path.join(dir, 'copy.html');
    await copyPreviewFile(source, dest, size);
    expect(await fs.readFile(dest, 'utf8')).toBe(await fs.readFile(source, 'utf8'));
    await expect(copyPreviewFile(source, path.join(dir, 'short.html'), size - 1)).rejects.toThrow('PREVIEW_CHANGED');
    await fs.symlink(source, path.join(dir, 'link.html'));
    await expect(copyPreviewFile(path.join(dir, 'link.html'), path.join(dir, 'linked.html'), size)).rejects.toThrow();
  });
  it('serves a complete immutable tree and root-relative module assets through authenticated HTTP', async () => {
    const { dir, source, args } = await fixture();
    await fs.writeFile(path.join(dir, '.env'), 'fixture');
    const preview = await createHtmlPreview(args, source);
    cleanups.push(preview.close);
    const entry = await fetch(preview.url, { redirect: 'manual' });
    expect(entry.status).toBe(302);
    const cookie = entry.headers.get('set-cookie')!.split(';')[0];
    const origin = new URL(preview.url).origin;
    expect((await fetch(origin + '/.env', { headers: { Cookie: cookie } })).status).toBe(404);
    const html = await fetch(origin + '/index.html', { headers: { Cookie: cookie } });
    expect(await html.text()).toContain('/dist/app.js');
    await fs.writeFile(path.join(dir, 'dist/app.js'), 'changed');
    const js = await fetch(origin + '/dist/app.js', { headers: { Cookie: cookie } });
    expect(js.headers.get('content-type')).toBe('text/javascript');
    expect(await js.text()).toBe('export const test = true;');
    expect((await fetch(origin + '/dist/app.js')).status).toBe(403);
    expect(
      (
        await fetch(origin + '/dist/app.js', {
          headers: { Cookie: cookie, Origin: 'https://evil.test' },
        })
      ).status,
    ).toBe(403);
    const badHostStatus = await new Promise<number | undefined>((resolve, reject) => {
      get(origin + '/dist/app.js', { headers: { Cookie: cookie, Host: 'evil.test' } }, (res) => {
        res.resume();
        resolve(res.statusCode);
      }).on('error', reject);
    });
    expect(badHostStatus).toBe(403);
    expect((await fetch(origin + '/%2e%2e/secret', { headers: { Cookie: cookie } })).status).toBe(
      404,
    );
    expect(
      (await fetch(origin + '/index.html', { method: 'POST', headers: { Cookie: cookie } })).status,
    ).toBe(405);
  });
  it('does not open a partial snapshot on transfer failure or excessive size', async () => {
    const { args, source } = await fixture();
    await expect(
      createHtmlPreview(args, {
        ...source,
        read: async () => {
          throw new Error('offline');
        },
      }),
    ).rejects.toThrow('offline');
    await expect(
      createHtmlPreview(args, {
        ...source,
        list: async () => [
          {
            name: 'index.html',
            relPath: 'index.html',
            type: 'file',
            size: 101 * 1024 * 1024,
            mtimeMs: 0,
          },
        ],
      }),
    ).rejects.toThrow('PREVIEW_TOO_LARGE');
  });
  it('rejects untrusted remote entries before reading any files', async () => {
    const { args, source } = await fixture();
    await expect(
      createHtmlPreview(args, {
        ...source,
        list: async () => [
          { name: '../secret', relPath: '../secret', type: 'file', size: 1, mtimeMs: 0 },
        ],
      }),
    ).rejects.toThrow('BAD_ARGS');
  });
  it('keeps Windows remote roots separate from the controller OS and confines SSH', () => {
    expect(
      previewLocation({
        origin: { kind: 'device', deviceId: 'device' },
        workdir: 'C:\\repo',
        absPath: 'C:\\repo\\out\\index.html',
      }),
    ).toEqual({ root: 'C:\\repo\\out', entry: 'index.html' });
    expect(() =>
      previewLocation({
        origin: { kind: 'ssh', remoteHostId: 'ssh' },
        workdir: '/repo',
        absPath: '/outside/index.html',
      }),
    ).toThrow('OUTSIDE_WORKDIR');
  });
});
