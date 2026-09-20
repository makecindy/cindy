import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { get } from 'node:http';
import { statEntry } from '@cindy/file-browser-core';
import { HTML_SNAPSHOT_CSP, withSnapshotHtmlCsp } from '@cindy/maker-shared/file-preview';
import {
  createHtmlPreview,
  copyPreviewFile,
  previewLocation,
  type PreviewSource,
} from '../html-preview';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
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
    stat: (root, rel) => statEntry(root, rel),
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
    await expect(copyPreviewFile(source, path.join(dir, 'short.html'), size - 1)).rejects.toThrow(
      'PREVIEW_CHANGED',
    );
    // Windows junctions need no file-symlink privilege. Both are rejected by
    // lstat before opening the target; POSIX keeps the file-symlink coverage.
    const link = path.join(dir, 'link.html');
    await fs.symlink(
      process.platform === 'win32' ? path.join(dir, 'dist') : source,
      link,
      process.platform === 'win32' ? 'junction' : 'file',
    );
    expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
    const open = vi.spyOn(fs, 'open');
    try {
      await expect(copyPreviewFile(link, path.join(dir, 'linked.html'), size))
        .rejects.toThrow('PREVIEW_CHANGED');
      expect(open).not.toHaveBeenCalled();
    } finally {
      open.mockRestore();
    }
  });
  it('serves requested resources and root-relative module assets through authenticated HTTP', async () => {
    const { dir, source, args } = await fixture();
    await fs.writeFile(path.join(dir, '.env'), 'fixture');
    const secondPage = '<script>window.authorScript = true;</script><a href="index.html">Back</a>';
    await fs.writeFile(path.join(dir, 'second.html'), secondPage);
    const xml =
      '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><body><p>XML</p></body></html>';
    await fs.writeFile(path.join(dir, 'xml.xhtml'), xml);
    const legacy = Buffer.from('<meta charset="windows-1252"><p>caf\xe9</p>', 'latin1');
    await fs.writeFile(path.join(dir, 'legacy.html'), legacy);
    const preview = await createHtmlPreview(args, source);
    cleanups.push(preview.close);
    const entry = await fetch(preview.url, { redirect: 'manual' });
    expect(entry.status).toBe(302);
    const cookie = entry.headers.get('set-cookie')!.split(';')[0];
    const origin = new URL(preview.url).origin;
    expect((await fetch(origin + '/.env', { headers: { Cookie: cookie } })).status).toBe(404);
    const html = await fetch(origin + '/index.html', { headers: { Cookie: cookie } });
    expect(await html.text()).toContain('/dist/app.js');
    expect(html.headers.get('content-security-policy')).toBe(HTML_SNAPSHOT_CSP);
    expect(html.headers.get('permissions-policy')).toBe('camera=(), microphone=(), geolocation=()');
    const second = await fetch(origin + '/second.html', { headers: { Cookie: cookie } });
    const secondBody = await second.text();
    expect(secondBody).toBe(withSnapshotHtmlCsp(secondPage));
    expect(Number(second.headers.get('content-length'))).toBe(Buffer.byteLength(secondBody));
    const xhtml = await fetch(origin + '/xml.xhtml', { headers: { Cookie: cookie } });
    expect(xhtml.headers.get('content-type')).toBe('application/xhtml+xml');
    expect(xhtml.headers.get('content-security-policy')).toBe(HTML_SNAPSHOT_CSP);
    expect(await xhtml.text()).toBe(xml);
    const encoded = await fetch(origin + '/legacy.html', { headers: { Cookie: cookie } });
    expect(encoded.headers.get('content-security-policy')).toBe(HTML_SNAPSHOT_CSP);
    expect(Buffer.from(await encoded.arrayBuffer())).toEqual(legacy);
    await fs.writeFile(path.join(dir, 'dist/app.js'), 'changed');
    const js = await fetch(origin + '/dist/app.js', { headers: { Cookie: cookie } });
    expect(js.headers.get('content-type')).toBe('text/javascript');
    expect(await js.text()).toBe('changed');
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
  it('guards cached HTML without rewriting the shared source cache', async () => {
    const { source, args } = await fixture();
    const original = await fs.readFile(args.absPath, 'utf8');
    const preview = await createHtmlPreview(args, {
      ...source,
      materialize: async (from) => from,
    });
    cleanups.push(preview.close);
    const entry = await fetch(preview.url, { redirect: 'manual' });
    const cookie = entry.headers.get('set-cookie')!.split(';')[0];
    const response = await fetch(new URL('/index.html', preview.url), {
      headers: { Cookie: cookie },
    });
    expect(await response.text()).toBe(withSnapshotHtmlCsp(original));
    expect(await fs.readFile(args.absPath, 'utf8')).toBe(original);
  });
  it('opens without enumerating siblings and isolates failed resource reads', async () => {
    const { args, source } = await fixture();
    const read = vi.fn(source.read);
    const stat = vi.fn(source.stat);
    const preview = await createHtmlPreview(args, { ...source, stat, read });
    cleanups.push(preview.close);
    expect(read).not.toHaveBeenCalled();
    expect(stat).toHaveBeenCalledTimes(1);
    expect(stat).toHaveBeenCalledWith(args.workdir, 'index.html');
    const initial = await fetch(preview.url, { redirect: 'manual' });
    const cookie = initial.headers.get('set-cookie')!.split(';')[0];
    const load = (p: string) => fetch(new URL(p, preview.url), { headers: { cookie } });
    read.mockRejectedValueOnce(new Error('offline'));
    expect((await load('/dist/app.js')).status).toBe(502);
    expect((await load('/index.html')).status).toBe(200);
    stat.mockResolvedValueOnce({ relPath: 'huge.bin', type: 'file', size: 101 * 1024 * 1024, mtimeMs: 0 });
    expect((await load('/huge.bin')).status).toBe(404);
    expect(read).toHaveBeenLastCalledWith(args.workdir, expect.objectContaining({ relPath: 'huge.bin' }), expect.any(AbortSignal));
    expect((await load('/index.html')).status).toBe(200);
    read.mockClear();
    expect((await load('/.hidden/secret')).status).toBe(404);
    expect(read).not.toHaveBeenCalled();
    stat.mockResolvedValueOnce({ relPath: '../secret', type: 'file', size: 1, mtimeMs: 0 });
    expect((await load('/other.txt')).status).toBe(404);
    expect(read).not.toHaveBeenCalled();
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


it('closes promptly and discards a shared read that finishes after cancellation', async () => {
  const { args, source } = await fixture();
  let finish!: (path: string) => void;
  let signal: AbortSignal | undefined;
  const materialize = vi.fn(source.materialize);
  const read = vi.fn((_root, _entry, currentSignal) => {
    signal = currentSignal;
    return new Promise<string>((resolve) => { finish = resolve; });
  });
  const preview = await createHtmlPreview(args, { ...source, read, materialize });
  cleanups.push(preview.close);
  const initial = await fetch(preview.url, { redirect: 'manual' });
  const cookie = initial.headers.get('set-cookie')!.split(';')[0];
  const response = fetch(new URL('/index.html', preview.url), { headers: { cookie } }).catch(() => null);
  await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
  await preview.close();
  expect(signal?.aborted).toBe(true);
  finish(args.absPath);
  await response;
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(materialize).not.toHaveBeenCalled();
});

it('serves metadata for a resource above 100 MiB without a preview size rejection', async () => {
  const { dir, args, source } = await fixture();
  const file = path.join(dir, 'large.bin');
  await fs.writeFile(file, '');
  await fs.truncate(file, 101 * 1024 * 1024);
  const preview = await createHtmlPreview(args, { ...source, materialize: async (from) => from });
  cleanups.push(preview.close);
  const initial = await fetch(preview.url, { redirect: 'manual' });
  const cookie = initial.headers.get('set-cookie')!.split(';')[0];
  const response = await fetch(new URL('/large.bin', preview.url), { method: 'HEAD', headers: { cookie } });
  expect(response.status).toBe(200);
  expect(Number(response.headers.get('content-length'))).toBe(101 * 1024 * 1024);
});

it('serializes resource copies so one preview cannot overlap 2 GiB materializations', async () => {
  const { dir, args, source } = await fixture();
  await fs.writeFile(path.join(dir, 'other.bin'), 'payload');
  let active = 0;
  let maxActive = 0;
  const materialize = vi.fn(async (from: string, to: string) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 40));
    active -= 1;
    await fs.copyFile(from, to);
    return to;
  });
  const preview = await createHtmlPreview(args, { ...source, materialize });
  cleanups.push(preview.close);
  const initial = await fetch(preview.url, { redirect: 'manual' });
  const cookie = initial.headers.get('set-cookie')!.split(';')[0];
  const load = (p: string) => fetch(new URL(p, preview.url), { headers: { cookie } });
  const [html, other, repeat] = await Promise.all([
    load('/index.html'),
    load('/other.bin'),
    load('/index.html?i=1'),
  ]);
  expect(html.status).toBe(200);
  expect(other.status).toBe(200);
  expect(repeat.status).toBe(200);
  expect(maxActive).toBe(1);
  expect(materialize).toHaveBeenCalledTimes(2);
});
