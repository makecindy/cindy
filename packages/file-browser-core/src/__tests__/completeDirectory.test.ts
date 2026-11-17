import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listDir, readFile, statEntry } from '../scanner';
import { loadIgnoreMatcher } from '../ignore';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

// #10863 follow-up: listDir previously exposed ancestor links and aliases into
// .git, and started every entry's I/O at once. Existing doc-mode cycle coverage
// did not cover ordinary expansion or resource pressure. Unit tier: real small
// junction fixtures; the concurrency probe observes in-flight production I/O.
it('filters canonical ancestor links while preserving sibling aliases', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'complete-dir-'));
  roots.push(root);
  for (const name of ['a/child', 'b', 'normal']) await fs.mkdir(path.join(root, name), { recursive: true });
  for (const [name, target] of [
    ['a/self', 'a'], ['a/back', ''], ['a/child/back', 'a'],
    ['a/to-b', 'b'], ['b/to-a', 'a'], ['b/ok', 'normal'], ['b/also-ok', 'normal'],
  ]) await fs.symlink(path.join(root, target), path.join(root, name), 'junction');
  const matcher = { ignores: () => false };
  expect((await listDir(root, 'a', matcher)).map(e => e.name)).toEqual(['child', 'to-b']);
  expect(await listDir(root, 'a/child', matcher)).toEqual([]);
  // The logical ancestor a is not a filesystem parent of b. Resolve the whole
  // expansion route, not just the current directory's canonical parents.
  expect((await listDir(root, 'a/to-b', matcher)).map(e => e.name)).toEqual(['also-ok', 'ok']);
});

// #10882 discussion_r4599574866: realpath preserves on-disk .GIT/.Git casing.
// The existing lowercase fixture missed aliases bypassing the logical matcher.
// Unit: real directory/junction inputs through listDir, including doc probes and
// a retargeted expansion; .github stays visible and unfiltered transfers stay complete.
it.each(['.git', '.GIT', '.Git'])('hides aliases into %s metadata and rechecks their target when expanding', async (metadata) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'complete-dir-'));
  roots.push(root);
  for (const name of [`repo/${metadata}/objects`, 'repo/.github', 'container', 'normal']) {
    await fs.mkdir(path.join(root, name), { recursive: true });
  }
  await fs.writeFile(path.join(root, 'repo', metadata, 'objects/note.md'), 'metadata');
  for (const [name, target] of [
    ['git-alias', `repo/${metadata}`], ['container/objects', `repo/${metadata}/objects`],
    ['github-alias', 'repo/.github'], ['changing', 'normal'],
  ]) await fs.symlink(path.join(root, target), path.join(root, name), 'junction');
  const matcher = await loadIgnoreMatcher(root);
  expect((await listDir(root, '', matcher)).map(e => e.name))
    .toEqual(['changing', 'container', 'github-alias', 'normal', 'repo']);
  expect(await listDir(root, 'container', matcher, { docMode: true })).toEqual([]);
  expect((await listDir(root, '', matcher, { docMode: true })).map(e => e.name)).not.toContain('container');
  await fs.unlink(path.join(root, 'changing'));
  await fs.symlink(path.join(root, 'repo', metadata, 'objects'), path.join(root, 'changing'), 'junction');
  await expect(listDir(root, 'changing', matcher)).rejects.toThrow(/\.git/);
  // Complete enumeration's existing transfer semantics are not presentation rules.
  expect((await listDir(root, `repo/${metadata}/objects`)).map(e => e.name)).toEqual(['note.md']);
});

it('bounds directory entry scans and still returns every link across batches', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'complete-dir-'));
  roots.push(root);
  await fs.mkdir(path.join(root, 'target'));
  for (let i = 0; i < 130; i++) {
    await fs.symlink(path.join(root, 'target'), path.join(root, `alias${i}`), 'junction');
  }
  const original = fs.lstat;
  let active = 0;
  let peak = 0;
  const probe = vi.spyOn(fs, 'lstat').mockImplementation(async (...args) => {
    active++;
    peak = Math.max(peak, active);
    try { return await original(...args); } finally { active--; }
  });
  try {
    const entries = await listDir(root, '', { ignores: () => false });
    expect(entries.map(e => e.name)).toEqual([
      ...Array.from({ length: 130 }, (_, i) => `alias${i}`), 'target',
    ]);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(64);
    expect(active).toBe(0);
  } finally {
    probe.mockRestore();
  }
});

// Review regression: doc probes must use the same visible paths as expansion.
// Unit: a root document plus empty/back -> root used to expose an empty folder;
// existing loop tests only checked that recursion terminates.
it('does not count documents reachable only through hidden ancestor links', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'complete-dir-'));
  roots.push(root);
  for (const name of ['empty', 'a', 'b/empty', 'valid']) await fs.mkdir(path.join(root, name), { recursive: true });
  await fs.writeFile(path.join(root, 'note.md'), 'root');
  await fs.writeFile(path.join(root, 'a/note.md'), 'ancestor');
  await fs.writeFile(path.join(root, 'valid/note.md'), 'visible');
  for (const [name, target] of [
    ['empty/back', ''], ['a/to-b', 'b'], ['b/empty/back', 'a'], ['alias', 'valid'],
  ]) await fs.symlink(path.join(root, target), path.join(root, name), 'junction');
  const matcher = { ignores: () => false };
  expect((await listDir(root, '', matcher, { docMode: true })).map(e => e.name))
    .not.toContain('empty');
  expect(await listDir(root, 'empty', matcher, { docMode: true })).toEqual([]);
  expect(await listDir(root, 'a/to-b', matcher, { docMode: true })).toEqual([]);
  expect((await listDir(root, 'alias', matcher, { docMode: true })).map(e => e.name)).toEqual(['note.md']);
});

// Review/engineering §8.4: top-level batching did not bound nested fan-out.
// Unit: multiple roots with >64 descendants; a late document also proves the
// bounded traversal does not truncate or stop at the first empty branch.
it('bounds nested document scans across sibling probes without losing late documents', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'complete-dir-'));
  roots.push(root);
  for (const parent of ['a', 'b']) {
    for (let i = 0; i < 70; i++) await fs.mkdir(path.join(root, parent, `d${String(i).padStart(3, '0')}`), { recursive: true });
  }
  await fs.writeFile(path.join(root, 'b/d069/note.md'), 'late document');
  const reader: { readdir(dir: string, options: { withFileTypes: true }): Promise<Dirent[]> } = fs;
  const original = reader.readdir.bind(fs);
  let active = 0;
  let peak = 0;
  const probe = vi.spyOn(reader, 'readdir').mockImplementation(async (...args) => {
    active++;
    peak = Math.max(peak, active);
    try { return await original(...args); } finally { active--; }
  });
  try {
    expect((await listDir(root, '', { ignores: () => false }, { docMode: true })).map(e => e.name)).toEqual(['b']);
    expect(peak).toBeLessThanOrEqual(64);
    expect(active).toBe(0);
  } finally { probe.mockRestore(); }
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

// #10863: existing coverage only rejects external links. Exercise the real
// presentation/expansion/read entries with one internal directory junction.
// Unit tier, isolated small filesystem fixtures; relPath is a POSIX API path.
it('presents internal directory links and expands them using their logical paths', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'complete-dir-'));
  roots.push(root);
  await fs.mkdir(path.join(root, 'documents'));
  await fs.writeFile(path.join(root, 'documents/note.md'), 'linked document');
  await fs.symlink(path.join(root, 'documents'), path.join(root, 'alias'), 'junction');
  const matcher = await loadIgnoreMatcher(root);

  expect(await listDir(root, '', matcher)).toEqual([
    expect.objectContaining({ name: 'alias', relPath: 'alias', type: 'directory', size: 0, symlinkTarget: 'documents' }),
    expect.objectContaining({ name: 'documents', type: 'directory' }),
  ]);
  expect(await listDir(root, 'alias', matcher)).toEqual([
    expect.objectContaining({ relPath: 'alias/note.md', type: 'file', size: 15 }),
  ]);
  expect(await readFile(root, 'alias/note.md')).toMatchObject({ content: 'linked document' });
  expect(await statEntry(root, 'alias')).toMatchObject({ type: 'directory' });
  // Complete enumeration serves recursive transfers and keeps its no-follow contract.
  expect((await listDir(root, '')).map(entry => entry.name)).toEqual(['documents']);
});

it('applies directory ignores to aliases and hides invalid or external directory links', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'complete-dir-'));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'complete-outside-'));
  roots.push(root, outside);
  await fs.mkdir(path.join(root, 'documents'));
  await fs.writeFile(path.join(root, '.gitignore'), 'alias/\n');
  await fs.symlink(path.join(root, 'documents'), path.join(root, 'alias'), 'junction');
  await fs.symlink(path.join(root, 'missing'), path.join(root, 'broken'), 'junction');
  await fs.symlink(outside, path.join(root, 'outside'), 'junction');
  const matcher = await loadIgnoreMatcher(root);
  expect((await listDir(root, '', matcher)).map(entry => entry.name)).toEqual(['documents', '.gitignore']);
  await expect(listDir(root, 'outside', matcher)).rejects.toThrow('escapes');

  // A previously visible alias may be retargeted between listing and expansion.
  await fs.unlink(path.join(root, 'alias'));
  await fs.symlink(outside, path.join(root, 'alias'), 'junction');
  await expect(listDir(root, 'alias', matcher)).rejects.toThrow('escapes');
});

it('finds documents through directory links without following cycles or sharing alias filters', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'complete-dir-'));
  roots.push(root);
  for (const name of ['documents', 'container', 'empty']) await fs.mkdir(path.join(root, name));
  await fs.writeFile(path.join(root, 'documents/note.md'), 'doc');
  await fs.symlink(path.join(root, 'documents'), path.join(root, 'container/docs'), 'junction');
  await fs.symlink(path.join(root, 'empty'), path.join(root, 'empty/loop'), 'junction');
  await fs.symlink(root, path.join(root, 'documents/back'), 'junction');
  await fs.writeFile(path.join(root, '.gitignore'), 'documents/\ncontainer/docs/note.md\n');
  const matcher = await loadIgnoreMatcher(root);
  expect(await listDir(root, '', matcher, { docMode: true })).toEqual([]);
  // A second alias has a different logical ignore rule despite the same target.
  await fs.symlink(path.join(root, 'documents'), path.join(root, 'container/visible'), 'junction');
  expect((await listDir(root, '', matcher, { docMode: true })).map(entry => entry.name))
    .toEqual(['container']);
  expect((await listDir(root, 'container', matcher, { docMode: true })).map(entry => entry.name))
    .toEqual(['visible']);
  const unfiltered = { ignores: () => false };
  expect((await listDir(root, '', unfiltered, { docMode: true })).map(entry => entry.name))
    .toEqual(['container', 'documents']);
  expect((await listDir(root, 'container', unfiltered, { docMode: true })).map(entry => entry.name))
    .toEqual(['docs', 'visible']);
  expect((await listDir(root, 'container/docs', unfiltered, { docMode: true })).map(entry => entry.name))
    .toContain('note.md');
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
