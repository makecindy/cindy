/**
 * pathResolver.test.ts
 * ---------------------------------------------------------------------------
 * Unit tests for the markdown-monorepo-resolve smart path resolver.
 *
 * These tests build a small fixture directory tree under os.tmpdir and drive
 * the BFS / cache against real filesystem operations. We don't mock fs because
 * the whole point of this resolver is filesystem behavior — a mock would just
 * re-implement what we're trying to verify.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  _clearResolveCache,
  _pathResolverTesting,
  bfsFindBySuffix,
  bfsFindManyBySuffix,
  resolveWorkspacePath,
  resolveWorkspacePathBatch,
  resolveWorkspacePathBatchCached,
  resolveWorkspacePathCached,
} from '../pathResolver';

let tmpRoot: string;
let workspace: string;

function write(rel: string, body = ''): string {
  const abs = path.join(workspace, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
  return abs;
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xdt-pathresolver-'));
  workspace = path.join(tmpRoot, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  _clearResolveCache();
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('bfsFindBySuffix', () => {
  it('finds a file in a sub-package by relative path suffix', () => {
    const target = write('apps/desktop/src/App.tsx', 'export {}');
    write('apps/server/src/index.ts');

    const matches = bfsFindBySuffix(workspace, 'src/App.tsx');
    expect(matches).toEqual([target]);
  });

  it('returns multiple matches when the same suffix appears in several packages', () => {
    const a = write('apps/desktop/package.json', '{}');
    const b = write('apps/server/package.json', '{}');

    const matches = bfsFindBySuffix(workspace, 'package.json');
    expect(matches.sort()).toEqual([a, b].sort());
  });

  it('skips ignored directories (node_modules, .git, dist)', () => {
    write('node_modules/foo/src/App.tsx');
    write('.git/objects/src/App.tsx');
    write('dist/src/App.tsx');
    const real = write('apps/desktop/src/App.tsx');

    const matches = bfsFindBySuffix(workspace, 'src/App.tsx');
    expect(matches).toEqual([real]);
  });

  // 用户场景：Agent 在子文件夹 film/ 里渲染出 renders/out/clip.mp4，回复里写相对子文件夹的路径。
  // 路径自己点名经过的被忽略目录(renders 下的 out)必须能进入；别处的 out 与首段就是被忽略
  // 目录的查找仍按原规则跳过，避免打开整棵树里的构建产物。
  it.each([
    ['renders/out/clip.mp4', ['film/renders/out/clip.mp4']],
    ['out/clip.mp4', []],
  ])('enters an ignored directory only where %s names it', (href, expected) => {
    write('film/renders/out/clip.mp4');
    write('film/out/clip.mp4');
    write('web/out/renders/out/clip.mp4');

    expect(bfsFindBySuffix(workspace, href)).toEqual(expected.map((rel) => path.join(workspace, rel)));
  });

  it('respects maxCandidates and stops early', () => {
    write('a/foo.ts');
    write('b/foo.ts');
    write('c/foo.ts');
    write('d/foo.ts');

    const matches = bfsFindBySuffix(workspace, 'foo.ts', { maxCandidates: 2 });
    expect(matches.length).toBe(2);
  });

  it('respects maxDepth — files past the depth limit are not found', () => {
    // workspace -> level1 -> level2 -> level3 -> deep.tsx
    // Depth in the BFS counts directory descents from root. With maxDepth: 2,
    // we descend root -> level1 (depth 1) -> level2 (depth 2), and stop
    // entering deeper directories — so level3/deep.tsx is unreachable.
    write('level1/level2/level3/deep.tsx');

    const matchesDeep = bfsFindBySuffix(workspace, 'deep.tsx', { maxDepth: 2 });
    expect(matchesDeep).toEqual([]);

    const matchesShallow = bfsFindBySuffix(workspace, 'deep.tsx', { maxDepth: 8 });
    expect(matchesShallow.length).toBe(1);
  });

  it('applies isPathAllowed filter to candidates', () => {
    const blocked = write('apps/desktop/src/App.tsx');
    const allowed = write('apps/server/src/App.tsx');

    const matches = bfsFindBySuffix(workspace, 'src/App.tsx', {
      isPathAllowed: (p) => p === allowed,
    });
    expect(matches).toEqual([allowed]);
    expect(matches).not.toContain(blocked);
  });

  it('is case-insensitive on win32, case-sensitive elsewhere', () => {
    write('apps/desktop/src/App.tsx');
    const matches = bfsFindBySuffix(workspace, 'src/app.tsx');
    if (process.platform === 'win32') {
      expect(matches.length).toBe(1);
    } else {
      expect(matches).toEqual([]);
    }
  });
});

describe('safeDecodeHrefForLookup', () => {
  it('allows encoded separators only when they decode to a Windows absolute path', () => {
    expect(_pathResolverTesting.safeDecodeHrefForLookup(
      'C:%5CUsers%5Cme%5Chello%20world.pdf',
    )).toBe('C:\\Users\\me\\hello world.pdf');
    expect(_pathResolverTesting.safeDecodeHrefForLookup('safe%2Fsecret.txt')).toBeNull();
  });
});

describe('resolveWorkspacePath', () => {
  it('returns unique when direct join hits a file', async () => {
    const target = write('src/App.tsx');

    const r = await resolveWorkspacePath('src/App.tsx', workspace);
    expect(r.status).toBe('unique');
    expect(r.candidates).toEqual([target]);
  });

  it('falls back to BFS when direct join misses but a sub-package has the file', async () => {
    const target = write('apps/desktop/src/App.tsx');

    const r = await resolveWorkspacePath('src/App.tsx', workspace);
    expect(r.status).toBe('unique');
    expect(r.candidates).toEqual([target]);
  });

  it('returns multiple when several sub-packages have the same file', async () => {
    const a = write('apps/desktop/package.json', '{}');
    const b = write('apps/server/package.json', '{}');

    const r = await resolveWorkspacePath('package.json', workspace);
    expect(r.status).toBe('multiple');
    expect(r.candidates.sort()).toEqual([a, b].sort());
  });

  it('returns none when nothing matches anywhere', async () => {
    write('apps/desktop/src/App.tsx');

    const r = await resolveWorkspacePath('does/not/exist.ts', workspace);
    expect(r.status).toBe('none');
    expect(r.candidates).toEqual([]);
  });

  it('handles absolute href by stat-ing it directly (unique on hit)', async () => {
    const target = write('apps/desktop/src/App.tsx');

    const r = await resolveWorkspacePath(target, workspace);
    expect(r.status).toBe('unique');
    expect(r.candidates).toEqual([target]);
  });

  it('decodes percent-encoded absolute hrefs from markdown links before stat', async () => {
    const target = write('dialogues/2026-06-23/hello word.pdf', '%PDF');
    const encoded = target.replace('hello word.pdf', 'hello%20word.pdf');

    const r = await resolveWorkspacePath(encoded, workspace);
    expect(r.status).toBe('unique');
    expect(r.candidates).toEqual([target]);
  });

  it('decodes percent-encoded relative hrefs before direct join', async () => {
    const target = write('Application Support/hello-word.pdf', '%PDF');

    const r = await resolveWorkspacePath('Application%20Support/hello-word.pdf', workspace);
    expect(r.status).toBe('unique');
    expect(r.candidates).toEqual([target]);
  });

  it('rejects percent-encoded traversal separators before direct join', async () => {
    const parentSecret = path.join(path.dirname(workspace), 'secret.txt');
    fs.writeFileSync(parentSecret, 'secret');

    await expect(resolveWorkspacePath('..%2Fsecret.txt', workspace)).resolves.toEqual({
      status: 'none',
      candidates: [],
    });
    await expect(resolveWorkspacePath('%2e%2e/secret.txt', workspace)).resolves.toEqual({
      status: 'none',
      candidates: [],
    });
    await expect(resolveWorkspacePath('safe/..%2Fsecret.txt', workspace)).resolves.toEqual({
      status: 'none',
      candidates: [],
    });
    await expect(resolveWorkspacePath('safe%2Fsecret.txt', workspace)).resolves.toEqual({
      status: 'none',
      candidates: [],
    });
  });

  it('preserves literal parent-directory segments that were not introduced by decoding', async () => {
    const normalized = write('report.pdf', '%PDF');
    const siblingDir = path.join(path.dirname(workspace), 'sibling');
    fs.mkdirSync(siblingDir, { recursive: true });
    const sibling = path.join(siblingDir, 'report.pdf');
    fs.writeFileSync(sibling, '%PDF');

    await expect(resolveWorkspacePath('docs/../report.pdf', workspace)).resolves.toEqual({
      status: 'unique',
      kind: 'file',
      candidates: [normalized],
    });
    await expect(resolveWorkspacePath('../sibling/report.pdf', workspace)).resolves.toEqual({
      status: 'unique',
      candidates: [sibling],
      kind: 'file',
    });
  });

  it('returns none for absolute href that does not exist', async () => {
    const ghost = path.join(workspace, 'ghost', 'missing.tsx');

    const r = await resolveWorkspacePath(ghost, workspace);
    expect(r.status).toBe('none');
  });

  it('returns none for empty href / cwd', async () => {
    expect((await resolveWorkspacePath('', workspace)).status).toBe('none');
    expect((await resolveWorkspacePath('src/App.tsx', '')).status).toBe('none');
  });

  it('returns none for URL-scheme href', async () => {
    write('apps/desktop/src/App.tsx');

    const r = await resolveWorkspacePath(
      'https://example.com/src/App.tsx',
      workspace,
    );
    expect(r.status).toBe('none');
  });

  it('returns none when decoding would turn href into a URL-scheme target', async () => {
    expect(_pathResolverTesting.safeDecodeHrefForLookup('https%3A//example.com/a.pdf')).toBeNull();

    await expect(resolveWorkspacePath('https%3A//example.com/a.pdf', workspace)).resolves.toEqual({
      status: 'none',
      candidates: [],
    });
  });

  it('returns none for href with newline', async () => {
    write('apps/desktop/src/App.tsx');

    const r = await resolveWorkspacePath('src/App.tsx\nrm -rf /', workspace);
    expect(r.status).toBe('none');
  });

  it('returns none when workingDir is not absolute', async () => {
    const r = await resolveWorkspacePath('src/App.tsx', 'relative/path');
    expect(r.status).toBe('none');
  });

  it('skips node_modules during fallback BFS', async () => {
    write('node_modules/foo/src/App.tsx');

    const r = await resolveWorkspacePath('src/App.tsx', workspace);
    expect(r.status).toBe('none');
  });

  it('honors isPathAllowed: blocked candidate is not returned', async () => {
    const blocked = write('apps/desktop/src/App.tsx');

    const r = await resolveWorkspacePath('src/App.tsx', workspace, {
      isPathAllowed: (p) => p !== blocked,
    });
    expect(r.status).toBe('none');
  });

  it('direct-join hit also passes through isPathAllowed', async () => {
    const target = write('src/App.tsx');

    const r = await resolveWorkspacePath('src/App.tsx', workspace, {
      isPathAllowed: () => false,
    });
    expect(r.status).toBe('none');
    expect(r.candidates).not.toContain(target);
  });
});

describe('resolveWorkspacePathCached', () => {
  // #7303: renderer retries used to hit the same main-process negative cache.
  // Exercise real batch-cache → file restoration → explicit refresh, no timers.
  it('refreshes a restored file immediately despite a batch-cached miss', async () => {
    const href = 'report.pdf';
    expect((await resolveWorkspacePathBatchCached([href], workspace))[href].status).toBe('none');
    const target = write(href, 'restored');
    expect((await resolveWorkspacePathCached(href, workspace)).status).toBe('none');
    expect(await resolveWorkspacePathCached(href, workspace, { refresh: true })).toEqual({
      status: 'unique', candidates: [target], kind: 'file',
    });
    expect((await resolveWorkspacePathBatchCached([href], workspace))[href].candidates).toEqual([target]);
  });

  it('returns the same result on repeated calls (cache hit)', async () => {
    const target = write('apps/desktop/src/App.tsx');

    const r1 = await resolveWorkspacePathCached('src/App.tsx', workspace);
    expect(r1.status).toBe('unique');
    expect(r1.candidates).toEqual([target]);

    // Delete the file — a fresh BFS would now return 'none', so a stable
    // 'unique' on the second call proves the cache short-circuited fs.
    fs.rmSync(target);
    const r2 = await resolveWorkspacePathCached('src/App.tsx', workspace);
    expect(r2).toEqual(r1);
  });

  it('different (workingDir, href) pairs are cached separately', async () => {
    write('apps/desktop/src/App.tsx');
    write('apps/server/src/index.ts');

    const a = await resolveWorkspacePathCached('src/App.tsx', workspace);
    const b = await resolveWorkspacePathCached('src/index.ts', workspace);

    expect(a.status).toBe('unique');
    expect(b.status).toBe('unique');
    expect(a.candidates).not.toEqual(b.candidates);
  });
});

describe('bfsFindManyBySuffix (single-walk multi-href)', () => {
  it('resolves several hrefs in one walk', async () => {
    const a = write('apps/desktop/src/App.tsx');
    const b = write('apps/server/src/index.ts');

    const found = await bfsFindManyBySuffix(workspace, ['src/App.tsx', 'src/index.ts']);
    expect(found.get('src/App.tsx')).toEqual([a]);
    expect(found.get('src/index.ts')).toEqual([b]);
  });

  it('gives each href its own candidate bucket (multiple matches)', async () => {
    const a = write('apps/desktop/package.json', '{}');
    const b = write('apps/server/package.json', '{}');
    write('apps/desktop/src/App.tsx');

    const found = await bfsFindManyBySuffix(workspace, ['package.json', 'src/App.tsx']);
    expect((found.get('package.json') ?? []).sort()).toEqual([a, b].sort());
    expect(found.get('src/App.tsx')?.length).toBe(1);
  });

  it('skips ignored directories for every href', async () => {
    write('node_modules/foo/src/App.tsx');
    const real = write('apps/desktop/src/App.tsx');

    const found = await bfsFindManyBySuffix(workspace, ['src/App.tsx']);
    expect(found.get('src/App.tsx')).toEqual([real]);
  });

  // 一个 href 点名的被忽略目录(renders 下的 out)只对它自己放行：同一批里的 clip.mp4 不能借道
  // 匹配到那里的输出文件，否则单独解析是 none/unique 的路径会因为同批的其他引用变成错误的结果。
  it('keeps an ignored directory one href names closed to the other hrefs', async () => {
    write('film/renders/out/other.mp4');
    write('film/renders/out/clip.mp4');
    write('docs/clip.mp4');
    const hrefs = ['renders/out/other.mp4', 'clip.mp4', 'out/clip.mp4'];

    const found = await bfsFindManyBySuffix(workspace, hrefs);
    expect(found.get('clip.mp4')).toEqual([path.join(workspace, 'docs/clip.mp4')]);
    for (const href of hrefs) expect(found.get(href)).toEqual(bfsFindBySuffix(workspace, href));
  });

  it('caps each bucket independently at maxCandidates', async () => {
    write('a/foo.ts');
    write('b/foo.ts');
    write('c/foo.ts');
    const found = await bfsFindManyBySuffix(workspace, ['foo.ts'], { maxCandidates: 2 });
    expect(found.get('foo.ts')?.length).toBe(2);
  });
});

describe('resolveWorkspacePathBatch', () => {
  it('mixes absolute / direct-join / BFS hrefs in one call', async () => {
    const direct = write('src/App.tsx');
    const nested = write('apps/desktop/src/deep.tsx');
    const abs = write('abs/target.ts');

    const out = await resolveWorkspacePathBatch(
      [abs, 'src/App.tsx', 'src/deep.tsx', 'ghost/x.ts'],
      workspace,
    );
    expect(out[abs]).toEqual({ status: 'unique', candidates: [abs], kind: 'file' });
    expect(out['src/App.tsx']).toEqual({ status: 'unique', candidates: [direct], kind: 'file' });
    expect(out['src/deep.tsx']).toEqual({ status: 'unique', candidates: [nested], kind: 'file' });
    expect(out['ghost/x.ts']).toEqual({ status: 'none', candidates: [] });
  });

  it('finds a file under an output directory named by the href (real resolver)', async () => {
    const real = write('chaoshan-film/renders2d/out/seg3_2d_v1.mp4');
    write('chaoshan-film/out/seg3_2d_v1.mp4');

    const result = await resolveWorkspacePathBatch(['renders2d/out/seg3_2d_v1.mp4'], workspace);
    expect(result['renders2d/out/seg3_2d_v1.mp4']).toEqual({ status: 'unique', candidates: [real], kind: 'file' });
  });

  it('decodes percent-encoded hrefs in batch mode', async () => {
    const direct = write('Application Support/hello-word.pdf', '%PDF');
    const nested = write('apps/desktop/Generated Files/report final.pdf', '%PDF');

    const out = await resolveWorkspacePathBatch(
      ['Application%20Support/hello-word.pdf', 'Generated%20Files/report%20final.pdf'],
      workspace,
    );
    expect(out['Application%20Support/hello-word.pdf']).toEqual({
      status: 'unique',
      candidates: [direct],
      kind: 'file',
    });
    expect(out['Generated%20Files/report%20final.pdf']).toEqual({
      status: 'unique',
      candidates: [nested],
      kind: 'file',
    });
  });

  it('rejects percent-encoded traversal in batch mode', async () => {
    const parentSecret = path.join(path.dirname(workspace), 'batch-secret.txt');
    fs.writeFileSync(parentSecret, 'secret');

    const out = await resolveWorkspacePathBatch(
      ['..%2Fbatch-secret.txt', '%2e%2e/batch-secret.txt'],
      workspace,
    );
    expect(out['..%2Fbatch-secret.txt']).toEqual({ status: 'none', candidates: [] });
    expect(out['%2e%2e/batch-secret.txt']).toEqual({ status: 'none', candidates: [] });

    const mixed = await resolveWorkspacePathBatch(['safe/..%2Fbatch-secret.txt'], workspace);
    expect(mixed['safe/..%2Fbatch-secret.txt']).toEqual({ status: 'none', candidates: [] });
  });

  it('preserves literal parent-directory segments in batch mode', async () => {
    const normalized = write('batch-report.pdf', '%PDF');
    const siblingDir = path.join(path.dirname(workspace), 'batch-sibling');
    fs.mkdirSync(siblingDir, { recursive: true });
    const sibling = path.join(siblingDir, 'report.pdf');
    fs.writeFileSync(sibling, '%PDF');

    const out = await resolveWorkspacePathBatch(
      ['docs/../batch-report.pdf', '../batch-sibling/report.pdf'],
      workspace,
    );
    expect(out['docs/../batch-report.pdf']).toEqual({
      status: 'unique',
      candidates: [normalized],
      kind: 'file',
    });
    expect(out['../batch-sibling/report.pdf']).toEqual({
      status: 'unique',
      candidates: [sibling],
      kind: 'file',
    });
  });

  it('returns multiple when a suffix matches several packages', async () => {
    const a = write('apps/desktop/package.json', '{}');
    const b = write('apps/server/package.json', '{}');

    const out = await resolveWorkspacePathBatch(['package.json'], workspace);
    expect(out['package.json'].status).toBe('multiple');
    expect(out['package.json'].candidates.sort()).toEqual([a, b].sort());
  });

  it('returns none for every href when workingDir is not absolute', async () => {
    const out = await resolveWorkspacePathBatch(['src/App.tsx'], 'relative/dir');
    expect(out['src/App.tsx']).toEqual({ status: 'none', candidates: [] });
  });

  it('returns none when decoding would turn href into a URL-scheme target in batch mode', async () => {
    expect(_pathResolverTesting.safeDecodeHrefForLookup('https%3A//example.com/batch.pdf')).toBeNull();

    const out = await resolveWorkspacePathBatch(['https%3A//example.com/batch.pdf'], workspace);
    expect(out['https%3A//example.com/batch.pdf']).toEqual({
      status: 'none',
      candidates: [],
    });
  });

  it('collapses duplicate hrefs into a single resolution', async () => {
    const target = write('src/App.tsx');
    const out = await resolveWorkspacePathBatch(['src/App.tsx', 'src/App.tsx'], workspace);
    expect(out['src/App.tsx']).toEqual({ status: 'unique', candidates: [target], kind: 'file' });
  });

  it('batch: 目录直连命中 → unique + kind directory(镜像单发,冷缓存目录 chip 依赖)', async () => {
    write('Skills/inner.md');
    const out = await resolveWorkspacePathBatch(['Skills', './Skills', 'ghost-dir'], workspace);
    expect(out['Skills']).toEqual({
      status: 'unique',
      candidates: [path.join(workspace, 'Skills')],
      kind: 'directory',
    });
    expect(out['./Skills']).toEqual({
      status: 'unique',
      candidates: [path.join(workspace, 'Skills')],
      kind: 'directory',
    });
    expect(out['ghost-dir']).toEqual({ status: 'none', candidates: [] });
  });
});

describe('resolveWorkspacePathBatchCached', () => {
  it('serves repeated hrefs from cache without re-walking', async () => {
    const target = write('apps/desktop/src/App.tsx');
    const r1 = await resolveWorkspacePathBatchCached(['src/App.tsx'], workspace);
    expect(r1['src/App.tsx'].candidates).toEqual([target]);

    // Delete the file; a fresh walk would now miss. A stable 'unique' proves
    // the cache short-circuited the filesystem.
    fs.rmSync(target);
    const r2 = await resolveWorkspacePathBatchCached(['src/App.tsx'], workspace);
    expect(r2['src/App.tsx']).toEqual(r1['src/App.tsx']);
  });

  // 回复可能先引用产物、文件后写出：调用方要求重查时，缓存里的 none 必须重新搜索；
  // 已唯一命中的结论照常走缓存，不因重查放大目录遍历。
  it('re-walks cached negative answers only when asked to revalidate them', async () => {
    const first = await resolveWorkspacePathBatchCached(['src/App.tsx'], workspace);
    expect(first['src/App.tsx'].status).toBe('none');
    const app = write('apps/desktop/src/App.tsx');

    // 不要求重查时仍走缓存；要求重查时重新搜索并写回缓存。
    expect((await resolveWorkspacePathBatchCached(['src/App.tsx'], workspace))['src/App.tsx'].status).toBe('none');
    const rechecked = await resolveWorkspacePathBatchCached(['src/App.tsx'], workspace, {}, true);
    expect(rechecked['src/App.tsx']).toEqual({ status: 'unique', candidates: [app], kind: 'file' });

    // 唯一命中的结论即使要求重查也走缓存（删掉文件后结论不变说明没有重新遍历）。
    fs.rmSync(app);
    const kept = await resolveWorkspacePathBatchCached(['src/App.tsx'], workspace, {}, true);
    expect(kept['src/App.tsx'].candidates).toEqual([app]);
  });

  it('shares its cache with the single-point resolveWorkspacePathCached', async () => {
    const target = write('apps/desktop/src/App.tsx');
    await resolveWorkspacePathBatchCached(['src/App.tsx'], workspace);

    fs.rmSync(target);
    // Single-point call should read the batch's cached entry, not re-walk.
    const single = await resolveWorkspacePathCached('src/App.tsx', workspace);
    expect(single.status).toBe('unique');
    expect(single.candidates).toEqual([target]);
  });
});

describe('leading ~ (home) expansion', () => {
  // A home dir DISTINCT from the workspace, so a `~/...` hit can only come from
  // tilde expansion — never from the workspace BFS coincidentally matching.
  let fakeHome: string;

  function writeHome(rel: string, body = ''): string {
    const abs = path.join(fakeHome, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
    return abs;
  }

  beforeEach(() => {
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'xdt-fakehome-'));
  });
  afterEach(() => {
    fs.rmSync(fakeHome, { recursive: true, force: true });
  });

  it('expands ~/path to the home dir and resolves the real file', async () => {
    const target = writeHome('Desktop/1.txt');

    const r = await resolveWorkspacePath('~/Desktop/1.txt', workspace, { homeDir: fakeHome });
    expect(r.status).toBe('unique');
    expect(r.candidates).toEqual([target]);
  });

  it('does NOT fall through to workspace BFS for a missing ~/path', async () => {
    // Same suffix exists in the workspace, but `~/...` points at home — a BFS
    // fallthrough would wrongly return the workspace file. Must be 'none'.
    write('Desktop/1.txt');

    const r = await resolveWorkspacePath('~/Desktop/1.txt', workspace, { homeDir: fakeHome });
    expect(r.status).toBe('none');
    expect(r.candidates).toEqual([]);
  });

  it('leaves ~otheruser untouched (resolves exactly as before → none)', async () => {
    const r = await resolveWorkspacePath('~bob/secret.txt', workspace, { homeDir: fakeHome });
    expect(r.status).toBe('none');
  });

  it('a bare ~ resolves as a directory hit (目录 chip 支持后的语义)', async () => {
    // 目录 unique 支持前这里是 none("~ 不是文件");现在 resolver 如实回
    // unique+directory,可点性由 chip 分类层把关(裸 ~ 不会被分类为 candidate)。
    const r = await resolveWorkspacePath('~', workspace, { homeDir: fakeHome });
    expect(r).toEqual({ status: 'unique', candidates: [fakeHome], kind: 'directory' });
  });

  it('honors isPathAllowed on the expanded home path', async () => {
    writeHome('Desktop/1.txt');

    const r = await resolveWorkspacePath('~/Desktop/1.txt', workspace, {
      homeDir: fakeHome,
      isPathAllowed: () => false,
    });
    expect(r.status).toBe('none');
  });

  it('batch: expands ~ alongside ordinary relative hrefs in one pass', async () => {
    const homeFile = writeHome('Desktop/1.txt');
    const rel = write('src/App.tsx');

    const out = await resolveWorkspacePathBatch(
      ['~/Desktop/1.txt', 'src/App.tsx'],
      workspace,
      { homeDir: fakeHome },
    );
    expect(out['~/Desktop/1.txt']).toEqual({ status: 'unique', candidates: [homeFile], kind: 'file' });
    expect(out['src/App.tsx']).toEqual({ status: 'unique', candidates: [rel], kind: 'file' });
  });
});
