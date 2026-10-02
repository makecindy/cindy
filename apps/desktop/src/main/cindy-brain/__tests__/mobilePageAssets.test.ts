import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { InstalledGhost } from '../../../shared/ghost.js';
import { listMobilePageFiles, readMobilePageChunk } from '../mobilePageAssets.js';

const roots: string[] = [];
afterEach(async () => {
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
    await fs.writeFile(outside, '<html>other</html>');
    await fs.unlink(path.join(ghost.dir, 'panel.html'));
    await fs.symlink(outside, path.join(ghost.dir, 'panel.html'));
    await expect(readMobilePageChunk(ghost, file, 0)).rejects.toThrow();
  });
});
