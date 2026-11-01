import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
vi.mock('../../cindy-media/ledger.js', () => ({ ghostCanRead: vi.fn(async () => false) }));
import { createPluginFileAccess } from '../pluginFileAccess.js';

// A2 production file reader: Range bytes and rejecting changed paths cannot be
// covered by the pure virtual server fixture. Separate file for isolated disk IO.
// Minimum failures: suffix Range, unowned media hash, symlink in the final component.
// Tier: unit, mkdtemp only, no processes or network; cleanup after every case.
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'plugin-app-file-'));
  roots.push(root);
  const file = path.join(root, 'data.txt');
  await writeFile(file, '0123456789');
  let resolve = file;
  const access = createPluginFileAccess({
    libraryPath: async (instance, relativePath) =>
      instance === 'plugin' && relativePath === 'data.txt' ? resolve : null,
    libraryMime: () => 'text/plain',
  });
  return {
    access,
    root,
    file,
    replace: (value: string) => {
      resolve = value;
    },
  };
}
it('reads metadata and suffix Range from the verified file handle', async () => {
  const { access } = await fixture();
  expect(await access.describe('plugin', 'library:data.txt')).toEqual({
    size: 10,
    mimeType: 'text/plain',
  });
  const response = await access.read(
    'plugin',
    'library:data.txt',
    new Request('https://card/file', { headers: { Range: 'bytes=-3' } }),
  );
  expect(response.status).toBe(206);
  expect(await response.text()).toBe('789');
  expect(response.headers.get('Content-Range')).toBe('bytes 7-9/10');
});
it('does not read another plugin, an arbitrary URL or an unowned media hash', async () => {
  const { access } = await fixture();
  for (const [instance, uri] of [
    ['other', 'library:data.txt'],
    ['plugin', 'file:///data.txt'],
    ['plugin', `cindy-media://blobs/${'a'.repeat(64)}.png`],
  ]) {
    expect(await access.describe(instance, uri)).toBeNull();
    expect((await access.read(instance, uri, new Request('https://card/file'))).status).toBe(404);
  }
});
it('rejects deleted files and symlink replacements instead of following them', async () => {
  const { access, root, file } = await fixture();
  await rm(file);
  expect(await access.describe('plugin', 'library:data.txt')).toBeNull();
  const other = path.join(root, 'other.txt');
  await writeFile(other, 'private');
  await symlink(other, file);
  expect(await access.describe('plugin', 'library:data.txt')).toBeNull();
});
