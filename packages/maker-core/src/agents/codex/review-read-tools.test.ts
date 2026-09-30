import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildReviewReadGrants, type ReviewReadGrant } from '../shared/review-read-scope.js';
import { callReviewReadTool, isWindowsReviewLocalPath } from './review-read-tools.js';

describe('Windows Review path support', () => {
  it.each(['C:\\review', 'c:/review/file.md', './file.md', '../artifact.md'])('accepts local drive evidence %s', (target) => {
    expect(isWindowsReviewLocalPath(target, 'C:\\review')).toBe(true);
  });
  it.each(['\\\\server\\share\\file', '//server/share/file', '\\\\?\\C:\\file', '\\\\.\\pipe\\name', 'C:\\file:stream'])('rejects unsupported evidence %s', (target) => {
    expect(isWindowsReviewLocalPath(target, 'C:\\review')).toBe(false);
  });
  it('rejects relative paths rooted at a network share', () => {
    expect(isWindowsReviewLocalPath('file.md', '\\\\server\\share\\review')).toBe(false);
  });
});

describe('Windows Review host reads', () => {
  let root: string;
  let work: string;
  let grants: ReviewReadGrant[];
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(tmpdir(), 'cindy-review-tools-'));
    work = path.join(root, 'work');
    await fs.mkdir(work);
    grants = await buildReviewReadGrants(work, []);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  });
  const text = (result: Awaited<ReturnType<typeof callReviewReadTool>>) => {
    expect(result.success).toBe(true);
    const item = result.contentItems[0];
    if (item.type !== 'inputText') throw new Error('Expected text');
    return JSON.parse(item.text);
  };
  it('paginates numbered evidence without modifying the file', async () => {
    const content = Array.from({ length: 250 }, (_, i) => `line ${i}`).join('\n');
    await fs.writeFile(path.join(work, 'code.ts'), content);
    const first = text(await callReviewReadTool('review_read_file', { path: 'code.ts' }, work, grants));
    expect(first.text).toContain('200: line 199\n');
    expect(first.nextOffset).toBe(200);
    const last = text(await callReviewReadTool('review_read_file', { path: 'code.ts', offset: 200 }, work, grants));
    expect(last.text).toMatch(/^201: line 200/);
    expect(last.nextOffset).toBeNull();
    expect(await fs.readFile(path.join(work, 'code.ts'), 'utf8')).toBe(content);
  });
  it('allows an explicitly granted external file, but not its siblings', async () => {
    const artifact = path.join(root, 'artifact.md');
    await fs.writeFile(artifact, 'evidence');
    await fs.writeFile(path.join(root, 'sibling.md'), 'private');
    grants = await buildReviewReadGrants(work, [artifact]);
    expect(text(await callReviewReadTool('review_read_file', { path: artifact }, work, grants)).text).toContain('evidence');
    expect((await callReviewReadTool('review_read_file', { path: '../sibling.md' }, work, grants)).success).toBe(false);
  });
  it('filters secrets and escaping junctions from directory listings and reads', async () => {
    await fs.mkdir(path.join(work, '.git'));
    await fs.writeFile(path.join(work, '.env'), 'SYNTHETIC_SECRET');
    await fs.writeFile(path.join(work, 'safe.md'), 'safe');
    const outside = path.join(root, 'outside');
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, 'private.md'), 'SYNTHETIC_PRIVATE');
    await fs.symlink(outside, path.join(work, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    const result = text(await callReviewReadTool('review_list_directory', { path: '.' }, work, grants));
    expect(result.entries).toEqual([{ name: 'safe.md', directory: false }]);
    for (const target of ['.env', '.git', 'escape/private.md', '../outside/private.md']) {
      const result = await callReviewReadTool('review_read_file', { path: target }, work, grants);
      expect(result.success).toBe(false);
      expect(JSON.stringify(result)).not.toContain('SYNTHETIC');
    }
  });
  it('rejects external hard links', async () => {
    const outside = path.join(root, 'private.md');
    await fs.writeFile(outside, 'SYNTHETIC_PRIVATE');
    await fs.link(outside, path.join(work, 'alias.md'));
    expect((await callReviewReadTool('review_read_file', { path: 'alias.md' }, work, grants)).success).toBe(false);
  });
  it('rejects file substitution between validation and opening', async () => {
    const target = path.join(work, 'evidence.md');
    await fs.writeFile(target, 'safe');
    const open = fs.open.bind(fs);
    vi.spyOn(fs, 'open').mockImplementationOnce(async (...args) => {
      await fs.rename(target, `${target}.original`);
      await fs.writeFile(target, 'replaced');
      return open(...args);
    });
    expect((await callReviewReadTool('review_read_file', { path: target }, work, grants)).success).toBe(false);
  });
  it('bounds directory pages and permits continuing past excluded entries', async () => {
    await Promise.all(Array.from({ length: 205 }, (_, i) => fs.writeFile(path.join(work, `file-${i}.txt`), '')));
    const first = text(await callReviewReadTool('review_list_directory', { path: '.' }, work, grants));
    const second = text(await callReviewReadTool('review_list_directory', { path: '.', offset: first.nextOffset }, work, grants));
    expect(first.entries).toHaveLength(200);
    expect(second.entries).toHaveLength(5);
    expect(second.nextOffset).toBeNull();
  });
  it('rejects unsupported tools, malformed arguments, binary and oversized text', async () => {
    await fs.writeFile(path.join(work, 'binary'), Buffer.from([0, 1, 2]));
    await fs.writeFile(path.join(work, 'large'), Buffer.alloc(2 * 1024 * 1024 + 1, 65));
    await fs.writeFile(path.join(work, 'long-line'), 'a'.repeat(70_000));
    for (const file of ['binary', 'large', 'long-line']) {
      expect((await callReviewReadTool('review_read_file', { path: file }, work, grants)).success).toBe(false);
    }
    for (const args of [null, [], {}, { path: '.', offset: -1 }, { path: '.', offset: 0.5 }, { path: '.', command: 'anything' }]) {
      expect((await callReviewReadTool('review_list_directory', args, work, grants)).success).toBe(false);
    }
    expect((await callReviewReadTool('exec_command', { path: '.' }, work, grants)).success).toBe(false);
  });
  it('returns image bytes only for scoped image evidence', async () => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64');
    await fs.writeFile(path.join(work, 'image.png'), png);
    await fs.writeFile(path.join(work, 'fake.png'), 'not an image');
    const result = await callReviewReadTool('review_view_image', { path: 'image.png' }, work, grants);
    expect(result).toEqual({ success: true, contentItems: [{ type: 'inputImage', imageUrl: `data:image/png;base64,${png.toString('base64')}` }] });
    expect((await callReviewReadTool('review_view_image', { path: 'fake.png' }, work, grants)).success).toBe(false);
  });
  it.skipIf(process.platform !== 'win32')('rejects device paths, UNC paths and alternate streams before filesystem access', async () => {
    const realpath = vi.spyOn(fs, 'realpath');
    for (const target of ['\\\\server\\share\\file', '\\\\?\\C:\\file', 'C:\\work\\file:stream']) {
      expect((await callReviewReadTool('review_read_file', { path: target }, work, grants)).success).toBe(false);
    }
    expect(realpath).not.toHaveBeenCalled();
  });
});
