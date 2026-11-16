import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { inspectCindyFile, readCindyZipEntry } from '../reader';

let root: string;
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-file-reader-')); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

async function archive(files: Record<string, string>, prefix = '') {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(files)) zip.file(prefix + name, content);
  const file = path.join(root, 'sample.cindy');
  await fs.writeFile(file, await zip.generateAsync({ type: 'nodebuffer' }));
  return file;
}

const manifest = { formatVersion: 1, type: 'theme', themes: ['themes/light.json'] };

// Unit: exercise the file bytes, not filename heuristics. A generic importer
// must preserve old plugin dispatch and reject future formats before installing.
describe('Cindy file identification', () => {
  it.each(['', 'wrapped/'])('delegates legacy ghost.json packages unchanged (%s)', async (prefix) => {
    const file = await archive({
      'ghost.json': '{"schemaVersion":3,"id":"legacy"}',
      'main.js': '// original plugin bytes',
      // This name was not reserved in old plugins and must not break them.
      'cindy.json': '{"formatVersion":999,"type":"future"}',
    }, prefix);
    const before = await fs.readFile(file);
    expect(await inspectCindyFile(file)).toEqual({ type: 'plugin' });
    expect(await fs.readFile(file)).toEqual(before);
  });

  it.each(['', 'wrapped/'])('identifies a declared theme and binds it to package bytes (%s)', async (prefix) => {
    const file = await archive({ 'cindy.json': JSON.stringify(manifest), 'themes/light.json': '{}' }, prefix);
    const result = await inspectCindyFile(file);
    expect(result.type).toBe('theme');
    if (result.type !== 'theme') return;
    expect(result.manifest).toEqual(manifest);
    expect(result.packageSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(await readCindyZipEntry(result.zip.file(prefix + 'themes/light.json')!, 100)).toEqual(Buffer.from('{}'));
  });

  it.each([
    { ...manifest, type: 'future-document' },
    { ...manifest, formatVersion: 3 },
  ])('reports unsupported types and newer formats without plugin fallback: %j', async (value) => {
    const file = await archive({ 'cindy.json': JSON.stringify(value) });
    await expect(inspectCindyFile(file)).rejects.toMatchObject({ code: 'unsupported' });
    expect(await fs.readdir(root)).toEqual(['sample.cindy']);
  });

  it('recognizes v2 resource declarations while preserving v1 dispatch', async () => {
    const value = { ...manifest, formatVersion: 2, resources: [{ id: 'body', kind: 'font', path: 'assets/body.ttf' }] };
    const result = await inspectCindyFile(await archive({ 'cindy.json': JSON.stringify(value) }));
    expect(result).toMatchObject({ type: 'theme', manifest: value });
  });

  it.each([
    'not json',
    JSON.stringify({ ...manifest, formatVersion: 0 }),
    JSON.stringify({ ...manifest, themes: ['../outside.json'] }),
    JSON.stringify({ ...manifest, themes: [] }),
    JSON.stringify({ ...manifest, formatVersion: 2, resources: [{ id: 'bg', kind: 'image', path: '../outside.png' }] }),
    JSON.stringify({ ...manifest, formatVersion: 2, resources: [{ id: 'bg', kind: 'script', path: 'code.js' }] }),
    JSON.stringify({ ...manifest, formatVersion: 2, resources: [{ id: 'bg', kind: 'image', path: 'a.png' }, { id: 'bg', kind: 'image', path: 'b.png' }] }),
  ])('keeps invalid declarations separate from unsupported types: %s', async (value) => {
    await expect(inspectCindyFile(await archive({ 'cindy.json': value }))).rejects.toMatchObject({ code: 'invalid' });
  });

  it('rejects unsafe original paths even if JSZip canonicalizes them', async () => {
    await expect(inspectCindyFile(await archive({
      'cindy.json': JSON.stringify(manifest), '../escape.txt': 'escape',
    }))).rejects.toMatchObject({ code: 'invalid' });
  });

  it('rejects path aliases, symbolic links and oversized manifest output', async () => {
    const zip = new JSZip();
    zip.file('cindy.json', JSON.stringify(manifest));
    zip.file('CINDY.JSON', '{}');
    const file = path.join(root, 'sample.cindy');
    await fs.writeFile(file, await zip.generateAsync({ type: 'nodebuffer' }));
    await expect(inspectCindyFile(file)).rejects.toMatchObject({ code: 'invalid' });
    zip.remove('CINDY.JSON');
    zip.file('asset.png', '/outside', { unixPermissions: 0o120777 });
    await fs.writeFile(file, await zip.generateAsync({ type: 'nodebuffer', platform: 'UNIX' }));
    await expect(inspectCindyFile(file)).rejects.toMatchObject({ code: 'invalid' });
    zip.remove('asset.png');
    zip.file('cindy.json', ' '.repeat(256 * 1024 + 1));
    await fs.writeFile(file, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
    await expect(inspectCindyFile(file)).rejects.toMatchObject({ code: 'invalid' });
  });
});
