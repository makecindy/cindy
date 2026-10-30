import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { InstalledGhost } from '../../../shared/ghost.js';
import { listMobilePageFiles, readMobilePageChunk } from '../mobilePageAssets.js';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-mobile-plugin-assets-'));
  roots.push(dir);
  await fs.writeFile(path.join(dir, 'panel.html'), '<html>first</html>');
  return { dir } as InstalledGhost;
}
describe('mobile page package snapshot', () => {
  it('reads its original page and rejects a same-length edit between chunks', async () => {
    const ghost = await fixture();
    const [file] = await listMobilePageFiles(ghost, 'panel.html');
    const value = await readMobilePageChunk(ghost, file, 0);
    expect(Buffer.from(value.base64, 'base64').toString()).toBe('<html>first</html>');
    await fs.writeFile(path.join(ghost.dir, 'panel.html'), '<html>other</html>');
    await expect(readMobilePageChunk(ghost, file, 0)).rejects.toThrow('PLUGIN_ASSET_CHANGED');
  });
  it('does not follow a file replaced by an external link', async () => {
    const ghost = await fixture();
    const [file] = await listMobilePageFiles(ghost, 'panel.html');
    const outside = path.join(ghost.dir, 'outside.html');
    const entry = path.join(ghost.dir, 'panel.html');
    const stat = await fs.lstat(entry, { bigint: true });
    await fs.writeFile(outside, '<html>other</html>');
    await fs.unlink(entry);
    try {
      await fs.symlink(outside, entry);
    } catch (error) {
      if (process.platform !== 'win32' ||
        !['EPERM', 'EACCES', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      // File symlinks require a privilege on Windows. Keep the file-link guard
      // exercised there, alongside the real directory-junction case below.
      const lstat = fs.lstat;
      stat.isSymbolicLink = () => true;
      vi.spyOn(fs, 'lstat').mockImplementation((...args) => args[0] === entry
        ? Promise.resolve(stat) as ReturnType<typeof fs.lstat>
        : lstat(...args));
    }
    const open = vi.spyOn(fs, 'open');
    await expect(readMobilePageChunk(ghost, file, 0)).rejects.toThrow(
      'plugin mobile page path segment is a link: panel.html',
    );
    expect(open).not.toHaveBeenCalled();
  });

  it('does not follow a parent directory replaced by an external link', async () => {
    const ghost = await fixture();
    const parent = path.join(ghost.dir, 'assets');
    await fs.mkdir(parent);
    await fs.writeFile(path.join(parent, 'page.html'), '<html>first</html>');
    const files = await listMobilePageFiles(ghost, 'assets/page.html');
    const file = files.find((candidate) => candidate.path === 'assets/page.html')!;
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-mobile-plugin-outside-'));
    roots.push(outside);
    await fs.writeFile(path.join(outside, 'page.html'), '<html>other</html>');
    await fs.rename(parent, path.join(ghost.dir, 'original-assets'));
    await fs.symlink(outside, parent, process.platform === 'win32' ? 'junction' : 'dir');
    const open = vi.spyOn(fs, 'open');
    await expect(readMobilePageChunk(ghost, file, 0)).rejects.toThrow(
      'plugin mobile page path segment is a link: assets/page.html',
    );
    expect(open).not.toHaveBeenCalled();
  });
});
