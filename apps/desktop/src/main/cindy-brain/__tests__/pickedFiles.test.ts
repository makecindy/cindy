import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { importPickedFiles, type PickedFilesDeps } from '../pickedFiles.js';
import { LibraryVault } from '../libraryVault.js';
import { GHOST_CINDY_DEPOSIT_MAX_BYTES } from '../../../shared/ghost.js';

// B2 production importer, tier: unit. Existing pick tests only cover dialog consent.
// Minimum failures: a normal file, an oversize sparse file, and cancellation during streaming.
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-picked-files-'));
  roots.push(root);
  const vault = new LibraryVault({ rootDir: () => path.join(root, 'library'), ghostId: 'plugin' });
  await vault.open();
  const progress = vi.fn();
  const deposit = vi.fn(async (_id: string, file: string) => {
    expect(await fs.readFile(file)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    return { url: 'cindy-media://blobs/fixture.png' };
  });
  const deps: PickedFilesDeps = { tempRoot: root, usageBytes: async () => 0, deposit,
    importLibrary: async (_id, input) => {
      const result = await vault.importStream(input);
      return result.ok ? { ...result, ref: `library:${result.path}` } : result;
    }, progress: () => progress,
  };
  return { root, deps, deposit, progress };
}
// PR #7924: 42-character generated prefix left only 22 characters for a source name.
// Unit through importPickedFiles + real LibraryVault; old short-name fixture missed rejection.
// PR #7924 round 2: a valid 212-character directory leaves only 43 characters for the generated filename.
it.each([
  { name: 'note.txt', directory: 'imports' },
  { name: 'quarterly-financial-report-2026-final.txt', directory: 'imports' },
  { name: 'quarterly-financial-report-2026-final.txt', directory: [...Array(3).fill('a'.repeat(64)), 'b'.repeat(17)].join('/') },
])('streams $name into $directory and preserves its display name', async ({ name, directory }) => {
  const { root, deps, progress } = await fixture();
  const file = path.join(root, name); await fs.writeFile(file, 'user file');
  const result = await importPickedFiles(deps, 'plugin', [file], { into: 'library', path: directory, assertCurrent() {} });
  expect(result).toMatchObject({ ok: true, files: [{ name, size: 9, mimeType: 'application/octet-stream' }] });
  if (!result.ok) throw new Error('failed');
  const saved = result.files![0]!;
  expect(saved).not.toHaveProperty('path');
  expect(await fs.readFile(path.join(root, 'library', saved.ref!.slice('library:'.length)), 'utf8')).toBe('user file');
  expect(saved.sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(progress).toHaveBeenCalledWith(9, undefined, '正在导入文件');
});
it('stages media from a held handle, sniffs bytes and cleans the private staging directory', async () => {
  const { root, deps, deposit } = await fixture();
  const file = path.join(root, 'misleading.txt');
  await fs.writeFile(file, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  expect(await importPickedFiles(deps, 'plugin', [file], { into: 'media', assertCurrent() {} })).toMatchObject({ ok: true, files: [{ mimeType: 'image/png' }] });
  expect(deposit).toHaveBeenCalledTimes(1);
  expect((await fs.readdir(root)).filter(name => name.startsWith('cindy-pick-'))).toEqual([]);
  await fs.truncate(file, GHOST_CINDY_DEPOSIT_MAX_BYTES + 1);
  expect(await importPickedFiles(deps, 'plugin', [file], { into: 'media', assertCurrent() {} })).toMatchObject({ ok: false, errorCode: 'TOO_LARGE', limitBytes: GHOST_CINDY_DEPOSIT_MAX_BYTES });
  expect(deposit).toHaveBeenCalledTimes(1);
});

// Same deposit_media byte rules: an ID3 tag beyond the initial probe must not hide a valid MPEG frame.
it('uses the shared bounded MP3 probe for a picked audio file with embedded artwork', async () => {
  const { root, deps } = await fixture();
  const tagSize = 65536;
  const bytes = Buffer.alloc(tagSize + 14);
  bytes.set([0x49, 0x44, 0x33, 4, 0, 0, (tagSize >>> 21) & 127, (tagSize >>> 14) & 127, (tagSize >>> 7) & 127, tagSize & 127]);
  bytes.set([0xff, 0xfb, 0x90, 0x64], tagSize + 10);
  const file = path.join(root, 'audio.mp3'); await fs.writeFile(file, bytes);
  deps.deposit = async (_id, staged, mime) => { expect(mime).toBe('audio/mpeg'); expect(await fs.readFile(staged)).toEqual(bytes); return { url: 'cindy-media://blobs/audio.mp3' }; };
  expect(await importPickedFiles(deps, 'plugin', [file], { into: 'media', assertCurrent() {} })).toMatchObject({ ok: true, files: [{ mimeType: 'audio/mpeg' }] });
});

// #7924 / 4420767928: importer must return committed refs when a later selection
// fails. Single-file cases missed this. Unit: a valid first file then unsupported
// media / failed Library write / missing source; no automatic deletion of user data.
it.each(['media', 'library', 'missing'] as const)('returns partial refs on %s failure', async (kind) => {
  const { root, deps } = await fixture();
  const first = path.join(root, 'first.png');
  const second = path.join(root, 'second.txt');
  await fs.writeFile(first, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (kind !== 'missing') await fs.writeFile(second, 'text');
  const importLibrary = deps.importLibrary;
  let calls = 0;
  if (kind === 'library') deps.importLibrary = async (...args) => ++calls === 2
    ? { ok: false, message: 'write failed' } : importLibrary(...args);
  const result = await importPickedFiles(deps, 'plugin', [first, second], {
    into: kind === 'media' ? 'media' : 'library', assertCurrent() {},
  });
  expect(result).toMatchObject({ ok: false, files: [{ name: 'first.png', ref: expect.any(String) }],
    failedFile: { index: 1, name: 'second.txt' } });
  if (result.ok) throw new Error('expected partial failure');
  expect(result.files).toHaveLength(1);
  expect(JSON.stringify(result)).not.toContain(root);
  if (kind !== 'media') expect(await fs.readFile(path.join(root, 'library', result.files![0].ref!.slice(8))))
    .toEqual(await fs.readFile(first));
});

// Partial-error refs must never escape an invalidated owner/install, even after a
// successful deposit. Unit through the same importer with a revoking host assertion.
it('does not return partial refs after the owner or selection becomes invalid', async () => {
  const { root, deps } = await fixture();
  const file = path.join(root, 'first.png');
  await fs.writeFile(file, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const deposit = deps.deposit;
  let current = true;
  deps.deposit = async (...args) => { const result = await deposit(...args); current = false; return result; };
  await expect(importPickedFiles(deps, 'plugin', [file], { into: 'media',
    assertCurrent() { if (!current) throw new Error('FILE_SELECTION_CANCELLED'); },
  })).rejects.toThrow('FILE_SELECTION_CANCELLED');
});
