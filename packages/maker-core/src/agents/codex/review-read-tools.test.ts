import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildReviewReadGrants, type ReviewReadGrant } from '../shared/review-read-scope.js';
import { GUEST_PROJECT_TOOLS, callGuestProjectTool, callReviewReadTool, isWindowsReviewLocalPath } from './review-read-tools.js';

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
  it.each([false, true])('bounds directory pages with excluded entries: %s', async (includeExcluded) => {
    // Pagination needs 200+ entries, not hundreds of real disk operations.
    // Real path confinement, junctions and file identity are exercised above.
    const directoryPath = grants[0].realPath;
    const directoryStat = await fs.stat(directoryPath);
    const names = Array.from({ length: 205 }, (_, i) => `file-${i}.txt`);
    const listedNames = includeExcluded ? ['.env', ...names] : names;
    const fileStat = { ...directoryStat, nlink: 1, isFile: () => true, isDirectory: () => false };
    const virtualFiles = new Set(names.map((name) => path.join(directoryPath, name)));
    vi.spyOn(fs, 'realpath').mockImplementation(async (target) => {
      const candidate = String(target);
      if (candidate === work || candidate === directoryPath) return directoryPath;
      if (virtualFiles.has(candidate)) return candidate;
      throw new Error('Unexpected fixture path');
    });
    vi.spyOn(fs, 'stat').mockImplementation(async (target) => {
      if (String(target) === directoryPath) return directoryStat;
      if (virtualFiles.has(String(target))) return fileStat as typeof directoryStat;
      throw new Error('Unexpected fixture path');
    });
    vi.spyOn(fs, 'opendir').mockImplementation(async () => ({
      async *[Symbol.asyncIterator]() {
        for (const name of listedNames) yield { name };
      },
    }) as Awaited<ReturnType<typeof fs.opendir>>);
    const first = text(await callReviewReadTool('review_list_directory', { path: '.' }, work, grants));
    const second = text(await callReviewReadTool('review_list_directory', { path: '.', offset: first.nextOffset }, work, grants));
    expect(first.entries).toHaveLength(includeExcluded ? 199 : 200);
    expect(first.nextOffset).toBe(200);
    expect(second.entries).toHaveLength(includeExcluded ? 6 : 5);
    expect(second.nextOffset).toBeNull();
    expect([...first.entries, ...second.entries]).toEqual(names.map((name) => ({ name, directory: false })));
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

// #8359: a confined guest on Windows reads through these tools. Same scope
// checks as Review, but the names, descriptions and refusals speak about the
// conversation's project, never about Review or evidence.
describe('confined guest project tools', () => {
  let root: string;
  let project: string;
  let grants: ReviewReadGrant[];
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(tmpdir(), 'cindy-guest-tools-'));
    project = path.join(root, 'client-a');
    await fs.mkdir(project);
    await fs.writeFile(path.join(project, 'infoA.txt'), 'secret A');
    await fs.mkdir(path.join(root, 'client-b'));
    await fs.writeFile(path.join(root, 'client-b', 'infoB.txt'), 'secret B');
    // A real image outside the project: the image tool must refuse it too.
    await fs.writeFile(path.join(root, 'client-b', 'photo.png'), Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'));
    grants = await buildReviewReadGrants(project, []);
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('describes the project scope without Review wording', () => {
    expect(GUEST_PROJECT_TOOLS.map((tool) => tool.name)).toEqual(['project_read_file', 'project_list_directory', 'project_view_image']);
    for (const tool of GUEST_PROJECT_TOOLS) expect(tool.description).not.toMatch(/review|evidence/i);
  });

  it('reads inside the project and refuses everything else with the project wording', async () => {
    const inside = await callGuestProjectTool('project_read_file', { path: 'infoA.txt' }, project, grants);
    expect(inside.success).toBe(true);
    expect(JSON.stringify(inside.contentItems)).toContain('secret A');
    for (const [name, args] of [
      ['project_read_file', { path: '../client-b/infoB.txt' }],
      ['project_read_file', { path: path.join(root, 'client-b', 'infoB.txt') }],
      ['project_list_directory', { path: root }],
      ['project_view_image', { path: '../client-b/photo.png' }],
      ['review_read_file', { path: 'infoA.txt' }],
    ] as const) {
      const refused = await callGuestProjectTool(name, args, project, grants);
      expect(refused.success).toBe(false);
      expect(JSON.stringify(refused.contentItems)).toContain('outside this conversation');
      expect(JSON.stringify(refused.contentItems)).not.toContain('secret B');
    }
  });
});
