import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadPluginAppearanceResource } from '../pluginAppearanceResources.js';

/* C11: exercise the actual package/owned-file loader. A declared filename is
 * insufficient authority for symlinks or mismatched bytes. Tier: unit; native
 * image decoding and temp files, no Electron process or artificial waits. */
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'plugin-appearance-'));
  roots.push(dir);
  const ghost = { dir, ui: { version: 1, appearance: { fields: ['uiFont'],
    resources: [{ id: 'font', kind: 'font', path: 'font.ttf' }] } } };
  return { instanceId: 'test', ghost, assertCurrent: () => {}, files: { describe: async () => null, read: async () => new Response(null, { status: 404 }) } };
}
describe('plugin appearance resources', () => {
  it('reads declared bounded font bytes and gives them a content identity', async () => {
    const f = await fixture();
    const bytes = Buffer.alloc(12 + 4 * 16 + 4);
    bytes.writeUInt32BE(0x00010000, 0); bytes.writeUInt16BE(4, 4);
    ['head', 'maxp', 'cmap', 'name'].forEach((tag, i) => {
      bytes.write(tag, 12 + i * 16); bytes.writeUInt32BE(76, 20 + i * 16); bytes.writeUInt32BE(4, 24 + i * 16);
    });
    await fs.writeFile(path.join(f.ghost.dir, 'font.ttf'), bytes);
    const result = await loadPluginAppearanceResource(f, 'asset:font', 'font');
    expect(result).toMatchObject({ kind: 'font', mimeType: 'font/ttf', bytes });
    expect(result.hash).toMatch(/^[0-9a-f]{64}$/);
  });
  it('rejects undeclared, type-confused, linked and malformed resources', async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.ghost.dir, 'font.ttf'), 'not a font');
    await expect(loadPluginAppearanceResource(f, 'asset:missing', 'font')).rejects.toThrow('RESOURCE_UNAVAILABLE');
    await expect(loadPluginAppearanceResource(f, 'asset:font', 'image')).rejects.toThrow('RESOURCE_TYPE');
    await expect(loadPluginAppearanceResource(f, 'asset:font', 'font')).rejects.toThrow('INVALID_FONT');
    await fs.symlink('font.ttf', path.join(f.ghost.dir, 'link.ttf'));
    f.ghost.ui.appearance.resources[0].path = 'link.ttf';
    await expect(loadPluginAppearanceResource(f, 'asset:font', 'font')).rejects.toThrow();
  });
  it('rechecks the actual runtime after asynchronous owned-file reads', async () => {
    const f = await fixture(); let current = true;
    f.assertCurrent = () => { if (!current) throw new Error('CONTEXT_CHANGED'); };
    f.files.describe = async () => { current = false; return null; };
    await expect(loadPluginAppearanceResource(f, 'library:font.ttf', 'font')).rejects.toThrow('CONTEXT_CHANGED');
  });
});
