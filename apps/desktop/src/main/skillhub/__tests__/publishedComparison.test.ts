import { createHash } from 'node:crypto';
import nodeFs from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fixture from './fixtures/published-content.json';
import { comparePublishedSkill, localComparisonFiles, publishedManifest } from '../publishedComparison';
import type { SkillhubMarketService } from '../marketService';
import type { Skill } from '../scanner';
import { pack } from '../zipPacker';

vi.mock('../../logger', () => ({ createLogger: () => ({ info: vi.fn() }) }));

let root: string;
let skill: Pick<Skill, 'name' | 'absolutePath' | 'registryEntry' | 'registrySkillName'>;
const info = { isCreator: true, canManage: true, authorId: 'owner', ownerType: 'personal', latestVersion: '1.0.0' };
const market = {
  info: vi.fn(),
  getPublishedFiles: vi.fn(),
  readPublishedFile: vi.fn(),
};
const compare = (diff = false) => comparePublishedSkill(skill, market as unknown as SkillhubMarketService, diff);
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-compare-'));
  for (const file of fixture) {
    await fs.mkdir(path.dirname(path.join(root, file.path)), { recursive: true });
    await fs.writeFile(path.join(root, file.path), Buffer.from(file.base64, 'base64'));
  }
  skill = { name: 'golden-skill', absolutePath: root, registryEntry: null };
  market.info.mockReset().mockResolvedValue({ success: true, info });
  market.getPublishedFiles.mockReset().mockResolvedValue({ version: '1.0.0', files: fixture });
  market.readPublishedFile.mockReset().mockImplementation(async ({ path: name }) => ({
    file: { content: Buffer.from(fixture.find((file) => file.path === name)!.base64, 'base64').toString('utf8'), truncated: false },
  }));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

describe('published content comparison', () => {
  it('matches the server golden bytes, including binary and empty files, without a registry snapshot', async () => {
    const local = await localComparisonFiles(root, false);
    const { manifest } = await pack(root);
    expect(manifest.files.map(({ relPath, ...file }) => ({ path: relPath, ...file })))
      .toEqual([...local].sort((a, b) => a.path.localeCompare(b.path)));
    expect(local.sort((a, b) => a.path.localeCompare(b.path))).toEqual(
      fixture.map(({ path, size, sha256 }) => ({ path, size, sha256 })).sort((a, b) => a.path.localeCompare(b.path)),
    );
    expect(await compare()).toEqual({ status: 'same', version: '1.0.0', pending: false });
    expect(market.getPublishedFiles).toHaveBeenCalledWith({ name: 'golden-skill', version: '1.0.0', includeHashes: true });
  });

  it.each(['unchanged', 'modified', 'unknown'] as const)('distinguishes %s local content from a newer remote release', async (localChanges) => {
    skill.registryEntry = { version: '1.0.0' } as Skill['registryEntry'];
    market.info.mockResolvedValue({ info: { ...info, latestVersion: '2.0.0' } });
    const newer = fixture.map((file) => file.path === 'SKILL.md' ? { ...file, sha256: 'a'.repeat(64) } : file);
    market.getPublishedFiles.mockImplementation(async ({ version }) => {
      if (version === '1.0.0' && localChanges === 'unknown') throw new Error('Historical manifest unavailable');
      return { version, files: version === '2.0.0' ? newer : fixture };
    });
    if (localChanges === 'modified') await fs.writeFile(path.join(root, 'scripts/run.py'), 'local edit');
    expect(await compare()).toMatchObject({ status: 'different', version: '2.0.0', localChanges });
    expect(market.getPublishedFiles).toHaveBeenCalledWith({ name: 'golden-skill', version: '1.0.0', includeHashes: true });
  });

  it.each(['learned', 'imported'] as const)('does not assume %s version numbers identify a downloaded baseline', async (origin) => {
    skill.registryEntry = { version: '0.1.0', origin } as Skill['registryEntry'];
    await fs.writeFile(path.join(root, 'scripts/run.py'), 'locally authored');
    expect(await compare()).toEqual({ status: 'different', version: '1.0.0', pending: false });
    expect(market.getPublishedFiles).toHaveBeenCalledTimes(1);
  });

  it('counts version-only edits and compares with the remote text', async () => {
    const original = Buffer.from(fixture[0].base64, 'base64').toString('utf8');
    await fs.writeFile(path.join(root, 'SKILL.md'), original.replace('1.0.0', '1.0.1'));
    expect(await compare(true)).toMatchObject({ status: 'different', changes: [{
      path: 'SKILL.md', kind: 'modified', isBinary: false, oldContent: original, newContent: original.replace('1.0.0', '1.0.1'),
    }] });
  });

  it('detects added scripts, removed files and changed binary bytes', async () => {
    await fs.writeFile(path.join(root, 'scripts/new.py'), 'new');
    await fs.unlink(path.join(root, 'empty.txt'));
    await fs.writeFile(path.join(root, 'assets/icon.bin'), Buffer.from([0, 1]));
    const result = await compare(true);
    expect(result).toMatchObject({ status: 'different', changes: [
      { path: 'assets/icon.bin', kind: 'modified', isBinary: true, oldSize: 5, newSize: 2 },
      { path: 'empty.txt', kind: 'removed' },
      { path: 'scripts/new.py', kind: 'added', newContent: 'new' },
    ] });
  });

  it.each(['pending', 'scanning', 'machine_reviewing', 'manual_reviewing', 'quarantine', 'warning', 'warn', ' MANUAL_REVIEWING ', undefined])(
    'uses the submitted version during review (%s)', async (status) => {
      market.info.mockResolvedValue({ info: { ...info, moderationStatus: 'published', pendingVersion: { version: '1.1.0', status } } });
      market.getPublishedFiles.mockResolvedValue({ version: '1.1.0', files: fixture });
      expect(await compare()).toEqual({ status: 'same', version: '1.1.0', pending: true });
      await fs.writeFile(path.join(root, 'scripts/run.py'), 'changed again');
      expect(await compare(true)).toMatchObject({ status: 'different', version: '1.1.0', pending: true });
      expect(market.readPublishedFile).toHaveBeenCalledWith({ name: 'golden-skill', version: '1.1.0', path: 'scripts/run.py' });
    });

  it.each(['pending', 'scanning', 'machine_reviewing', 'manual_reviewing', 'quarantine', 'warning', 'warn'])(
    'recognizes a first publication under review (%s)', async (moderationStatus) => {
      market.info.mockResolvedValue({ info: { ...info, moderationStatus } });
      expect(await compare()).toEqual({ status: 'same', version: '1.0.0', pending: true });
    });

  it.each(['rejected', 'failed', 'blocked'])('compares with the published version after rejection (%s)', async (status) => {
    market.info.mockResolvedValue({ info: { ...info, moderationStatus: 'published', pendingVersion: { version: '1.1.0', status } } });
    expect(await compare()).toEqual({ status: 'same', version: '1.0.0', pending: false });
  });

  it.each([false, undefined])('does not infer authorship from management rights (%s)', async (isCreator) => {
    market.info.mockResolvedValue({ info: { ...info, isCreator } });
    expect(await compare()).toEqual({ status: isCreator === false ? 'not-owner' : 'unavailable' });
    expect(market.getPublishedFiles).not.toHaveBeenCalled();
  });

  it('does not cross catalog identities with the same slug', async () => {
    skill.registryEntry = { catalogScope: 'team' } as Skill['registryEntry'];
    market.info.mockResolvedValueOnce({ info }).mockResolvedValueOnce({ info: { ...info, authorId: 'different-owner' } });
    expect(await compare()).toEqual({ status: 'not-owner' });
    expect(market.getPublishedFiles).not.toHaveBeenCalled();
  });

  it('fails rather than treating a missing digest, changing version, or unreadable tree as clean', async () => {
    market.getPublishedFiles.mockResolvedValueOnce({ version: '1.0.0', files: fixture.map(({ sha256, ...file }) => file) });
    await expect(compare()).rejects.toThrow('Missing file digest');
    market.getPublishedFiles.mockResolvedValueOnce({ version: '2.0.0', files: fixture });
    await expect(compare()).rejects.toThrow('Published version changed');
    await fs.rename(root, root + '-moved');
    try { await expect(compare()).rejects.toThrow(); }
    finally { await fs.rename(root + '-moved', root); }
  });

  it('skips packaging exclusions and symlinks without reading their targets', async () => {
    await fs.mkdir(path.join(root, '.git'));
    await fs.writeFile(path.join(root, '.git/config'), 'ignore');
    await fs.writeFile(path.join(root, '.DS_Store'), 'ignore');
    await fs.symlink(os.tmpdir(), path.join(root, 'external'), process.platform === 'win32' ? 'junction' : 'dir');
    expect(await compare()).toMatchObject({ status: 'same' });
  });

  it('accepts 2,000 packaged files with directories and symlinks, but rejects an extra file', async () => {
    // Exercise both production walkers at the real quota without thousands of
    // disk operations competing with other unit workers. The golden test above
    // verifies the same pack/compare contract against real filesystem handles.
    const files = new Map<string, Buffer>([
      [path.join(root, 'SKILL.md'), Buffer.from(fixture[0].base64, 'base64')],
      ...Array.from({ length: 1_999 }, (_, index): [string, Buffer] =>
        [path.join(root, 'nested', `${index}.txt`), Buffer.from('content')]),
    ]);
    const entry = (name: string, kind: 'file' | 'dir' | 'link') => ({
      name, isFile: () => kind === 'file', isDirectory: () => kind === 'dir',
    });
    const directories = new Map([
      [root, [entry('SKILL.md', 'file'), entry('nested', 'dir'), entry('external', 'link')]],
      [path.join(root, 'nested'), [entry('empty', 'dir'),
        ...Array.from({ length: 1_999 }, (_, index) => entry(`${index}.txt`, 'file'))]],
      [path.join(root, 'nested', 'empty'), []],
    ]);
    const stat = (file: string) => ({
      ino: 1, dev: 1, mtimeMs: 1, ctimeMs: 1,
      size: files.get(file)?.length ?? 0, isFile: () => files.has(file),
    });
    const bytes = (file: string) => {
      const content = files.get(file);
      if (!content) throw new Error(`Unexpected file read: ${file}`);
      return content;
    };
    vi.spyOn(fs, 'realpath').mockImplementation(async (file) => String(file));
    vi.spyOn(fs, 'readdir').mockImplementation(async (dir) => {
      const entries = directories.get(String(dir));
      if (!entries) throw new Error(`Unexpected directory read: ${dir}`);
      return entries as never;
    });
    vi.spyOn(fs, 'stat').mockImplementation(async (file) => stat(String(file)) as never);
    vi.spyOn(fs, 'readFile').mockImplementation(async (file) => Buffer.from(bytes(String(file))));
    vi.spyOn(fs, 'open').mockImplementation(async (file) => ({
      stat: async () => stat(String(file)),
      createReadStream: () => Readable.from([bytes(String(file))]),
      close: async () => {},
    }) as Awaited<ReturnType<typeof fs.open>>);
    vi.spyOn(nodeFs, 'createReadStream').mockImplementation((file) =>
      Readable.from([bytes(String(file))]) as ReturnType<typeof nodeFs.createReadStream>);
    const { manifest } = await pack(root);
    expect(manifest.files).toHaveLength(2_000);
    market.getPublishedFiles.mockResolvedValue({
      version: '1.0.0', files: manifest.files.map(({ relPath, ...file }) => ({ path: relPath, ...file })),
    });
    expect(await compare()).toEqual({ status: 'same', version: '1.0.0', pending: false });
    files.set(path.join(root, 'extra.txt'), Buffer.from('one too many'));
    directories.get(root)!.push(entry('extra.txt', 'file'));
    await expect(compare()).rejects.toThrow('Skill exceeds comparison limit');
  });

  it('shows summaries for truncated or unverifiable remote text', async () => {
    await fs.writeFile(path.join(root, 'scripts/run.py'), 'new');
    market.readPublishedFile.mockResolvedValue({ file: { content: 'wrong', truncated: false } });
    expect(await compare(true)).toMatchObject({ changes: [{ path: 'scripts/run.py', isBinary: true, oldContent: '', newContent: '' }] });
    market.readPublishedFile.mockResolvedValue({ file: { content: 'print("hello")\n', truncated: true } });
    expect(await compare(true)).toMatchObject({ changes: [{ isBinary: true }] });
  });

  it('never downloads large files just to preview them', async () => {
    const content = Buffer.alloc(2 * 1024 * 1024, 'a');
    const sha256 = createHash('sha256').update(content).digest('hex');
    market.getPublishedFiles.mockResolvedValue({ version: '1.0.0', files: [...fixture, { path: 'large.txt', size: content.length, sha256 }] });
    expect(await compare(true)).toMatchObject({ changes: [{ path: 'large.txt', kind: 'removed', isBinary: true }] });
    expect(market.readPublishedFile).not.toHaveBeenCalled();
  });

  it.each(['../escape', '/etc/passwd', 'C:/secret', 'a//b', 'a/./b', 'a\\b'])('rejects invalid remote paths: %s', (name) => {
    expect(() => publishedManifest([...fixture, { ...fixture[0], path: name }])).toThrow('Invalid published path');
  });
  it('applies the file limit after package exclusions, while enforcing the retained limit', () => {
    const ignored = Array.from({ length: 2_100 }, (_, i) => ({ path: `node_modules/package/${i}.js` }));
    const retained = [fixture[0], ...Array.from({ length: 1_999 }, (_, i) => ({ ...fixture[0], path: `scripts/${i}.js` }))];
    expect(publishedManifest([...ignored, ...retained])).toHaveLength(2_000);
    expect(() => publishedManifest([...ignored, ...retained, { ...fixture[0], path: 'extra.js' }]))
      .toThrow('Skill exceeds comparison limit');
    expect(() => publishedManifest([...ignored, ...retained, { path: 'node_modules/../escape' }]))
      .toThrow('Invalid published path');
  });

  it('rejects duplicated and incomplete remote manifests', () => {
    expect(() => publishedManifest([...fixture, fixture[0]])).toThrow('Invalid published path');
    expect(() => publishedManifest(fixture.slice(1))).toThrow('Missing Skill manifest');
  });
});
