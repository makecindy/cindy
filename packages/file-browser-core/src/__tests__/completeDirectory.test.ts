import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listDir } from '../scanner';
import { loadIgnoreMatcher } from '../ignore';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

it('separates complete enumeration from tree presentation filters', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'complete-dir-'));
  roots.push(root);
  for (const name of ['dist', 'build', 'vendor']) await fs.mkdir(path.join(root, name));
  for (const name of ['.env', 'asset.meta', 'index.html']) await fs.writeFile(path.join(root, name), 'fixture');
  await fs.writeFile(path.join(root, 'dist/app.js'), 'fixture');
  expect((await listDir(root, '')).map(e => e.name).sort()).toEqual(
    ['.env', 'asset.meta', 'build', 'dist', 'index.html', 'vendor'],
  );
  const matcher = await loadIgnoreMatcher(root, { hideMetaFiles: true, honorVcsIgnore: false });
  expect((await listDir(root, '', matcher)).map(e => e.name)).toEqual(['.env', 'index.html']);
  expect((await listDir(root, 'dist')).map(e => e.relPath)).toEqual(['dist/app.js']);
  await expect(listDir(root, '', null, { maxEntries: 2 })).rejects.toThrow('DIRECTORY_TOO_LARGE');
  await expect(listDir(root, '', null, { maxEntries: NaN })).rejects.toThrow('Invalid');
  await expect(listDir(root, '../')).rejects.toThrow('escapes');
});

it('retains realpath boundaries when listing without presentation filters', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'complete-dir-'));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'complete-outside-'));
  roots.push(root, outside);
  await fs.symlink(outside, path.join(root, 'link'), 'junction');
  expect(await listDir(root, '')).toEqual([]);
  await expect(listDir(root, 'link')).rejects.toThrow('escapes');
});

// #7064: exercise listDir's returned order, not a copied comparator. Existing
// fixtures only cover alphabetic names; 3.md / 10.md is the minimal failure.
// Unit tier: small real directories, no subprocess or external service.
it('orders numeric filename segments naturally with directories first', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'complete-dir-'));
  roots.push(root);
  for (const name of ['Chapter10', 'chapter2']) await fs.mkdir(path.join(root, name));
  for (const name of ['01.md', '02.md', '3.md', '10.md', '29.md', '30.md', 'part2-10.md', 'Part2-3.md']) {
    await fs.writeFile(path.join(root, name), 'fixture');
  }
  expect((await listDir(root, '')).map(entry => entry.name)).toEqual([
    'chapter2', 'Chapter10', '01.md', '02.md', '3.md', '10.md', '29.md', '30.md',
    'Part2-3.md', 'part2-10.md',
  ]);
});

// #7064 compatibility: numeric ties and nonnumeric names must retain legacy
// locale ordering. Reverse enumeration exposes lost distinctions (1 / 01 and
// a / full-width A) that ordinary readdir order could accidentally conceal.
it.each([
  ['equal numeric values', ['1.md', '001.md', '01.md']],
  ['text, accents and character width', ['README.md', 'apple.md', 'a.md', 'Ａ.md', 'á.md', 'zebra.md']],
])('preserves legacy ordering for %s', async (_label, names) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'complete-dir-'));
  roots.push(root);
  for (const name of names) await fs.writeFile(path.join(root, name), 'fixture');
  const expected = [...names].sort((a, b) => a.toLocaleLowerCase().localeCompare(b.toLocaleLowerCase()));
  const entries = await fs.readdir(root, { withFileTypes: true });
  entries.sort((a, b) => expected.indexOf(b.name) - expected.indexOf(a.name));
  const reader: { readdir(dir: string, options: { withFileTypes: true }): Promise<Dirent[]> } = fs;
  const readDir = vi.spyOn(reader, 'readdir').mockResolvedValueOnce(entries);
  try {
    expect((await listDir(root, '')).map(entry => entry.name)).toEqual(expected);
  } finally {
    readDir.mockRestore();
  }
});
