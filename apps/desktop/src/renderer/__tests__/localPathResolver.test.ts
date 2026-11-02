/**
 * localPathResolver.test.ts
 * ---------------------------------------------------------------------------
 * Pure-function unit tests for the markdown link / @-chip ref resolver shared
 * by MarkdownRenderer (F1) and UserMessage (F2).
 *
 * Covers the 22 baseline cases enumerated in the tech spec
 * (text-lightbox-trigger-extension-frontend.md M1 table) plus a small set of
 * defensive edge cases (trailing-slash cwd, double-slash, unicode filenames).
 */

import { afterEach, describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  resolveWorkspacePath,
  resolveWorkspacePathBatch,
  safeDecodeHrefForLookup,
} from '../../main/pathResolver';

import {
  _clearSmartResolveCache,
  classifyMarkdownHref,
  looksLikeDirectoryPath,
  looksLikeFilePath,
  peekResolveLocalPathSmart,
  resolveKnownLocalFileHref,
  resolveLocalPath,
  resolveLocalPathSmart,
  resolveLocalPathSmartCached,
  resolveToolFilePath,
  revalidateNegativeLocalPathSmart,
  toFileUrl,
  toLocalFileUrl,
} from '@/lib/localPathResolver';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('classifyMarkdownHref', () => {
  it('returns external for undefined / empty', () => {
    expect(classifyMarkdownHref(undefined)).toBe('external');
    expect(classifyMarkdownHref('')).toBe('external');
  });

  it('returns external for http(s) URLs (priority over extension match)', () => {
    expect(classifyMarkdownHref('https://example.com')).toBe('external');
    expect(classifyMarkdownHref('http://example.com/a.png')).toBe('external');
  });

  it('returns external for plain word with no path/ext signal', () => {
    expect(classifyMarkdownHref('hello')).toBe('external');
  });

  it('returns text-local for bare filename with non-image extension', () => {
    expect(classifyMarkdownHref('App.tsx')).toBe('text-local');
  });

  it('returns image-local for bare filename with image extension (case-insensitive)', () => {
    expect(classifyMarkdownHref('logo.PNG')).toBe('image-local');
    expect(classifyMarkdownHref('photo.jpeg')).toBe('image-local');
  });

  it('returns text-local for relative path with text extension', () => {
    expect(classifyMarkdownHref('src/App.tsx')).toBe('text-local');
  });

  it('returns text-local for POSIX absolute text path', () => {
    expect(classifyMarkdownHref('/abs/x.md')).toBe('text-local');
  });

  it('returns text-local for Windows absolute path with backslash', () => {
    expect(classifyMarkdownHref('C:\\Users\\x.tsx')).toBe('text-local');
  });

  it('returns image-local for Windows absolute path with image extension', () => {
    expect(classifyMarkdownHref('C:/Users/x.png')).toBe('image-local');
  });

  it('returns image-local for file:// URL with Windows path + image ext', () => {
    expect(classifyMarkdownHref('file:///C:/a.png')).toBe('image-local');
  });

  it('returns image-local for file:// URL with POSIX path + svg', () => {
    expect(classifyMarkdownHref('file:///abs/a.svg')).toBe('image-local');
  });

  it('returns model-local for 3D model extensions (case-insensitive)', () => {
    expect(classifyMarkdownHref('/abs/character.glb')).toBe('model-local');
    expect(classifyMarkdownHref('~/Downloads/character.fbx')).toBe('model-local');
    expect(classifyMarkdownHref('C:\\models\\char.FBX')).toBe('model-local');
    expect(classifyMarkdownHref('assets/scene.GLB')).toBe('model-local');
  });

  it('returns model-local for .gltf — model check must beat the text fallback', () => {
    // .gltf 底层是 JSON;若 model 分支排在 text 判定之后会被 'text-local' 抢走。
    expect(classifyMarkdownHref('/abs/scene.gltf')).toBe('model-local');
  });

  // Trailing-separator paths classify as 'directory' so the renderer can
  // skip TextLightbox / ImageLightbox routing for folder refs.
  it('returns directory for relative folder path with trailing slash', () => {
    expect(classifyMarkdownHref('src/components/')).toBe('directory');
    expect(classifyMarkdownHref('./docs/')).toBe('directory');
    expect(classifyMarkdownHref('../sibling/')).toBe('directory');
  });

  it('returns directory for POSIX absolute folder path', () => {
    expect(classifyMarkdownHref('/Users/me/dir/')).toBe('directory');
    expect(classifyMarkdownHref('/etc/')).toBe('directory');
  });

  it('returns directory for Windows absolute folder path', () => {
    expect(classifyMarkdownHref('C:\\Users\\')).toBe('directory');
    expect(classifyMarkdownHref('D:/projects/')).toBe('directory');
  });

  it('returns directory for file:// URL pointing at a folder', () => {
    expect(classifyMarkdownHref('file:///Users/me/dir/')).toBe('directory');
    expect(classifyMarkdownHref('file:///C:/Users/')).toBe('directory');
  });

  // Regression: in-document anchors and our internal deep-link schemes
  // must NOT classify as a local-file kind. classifyMarkdownLinkTarget already
  // peels these off upstream, so this is defensive — it keeps classifyMarkdownHref
  // correct in isolation and guards any direct caller.
  it('returns external for xdt-maker://session deep link (does not enter local branch)', () => {
    expect(
      classifyMarkdownHref('xdt-maker://session/123e4567-e89b-12d3-a456-426614174000'),
    ).toBe('external');
    expect(classifyMarkdownHref('xdt-maker://session-card/abc?wake=resumed')).toBe('external');
  });

  it('returns external for xdt-audio:// links', () => {
    expect(classifyMarkdownHref('xdt-audio://local/?path=%2Ftmp%2Ftts.mp3')).toBe('external');
  });

  it('returns external for in-document anchors, including dotted ones', () => {
    // Plain `#heading` never tripped HAS_EXT_RE, but `#v1.2` ends in `.2` and
    // would have misclassified as text-local before the `#` guard.
    expect(classifyMarkdownHref('#section')).toBe('external');
    expect(classifyMarkdownHref('#v1.2')).toBe('external');
  });
});

describe('looksLikeDirectoryPath', () => {
  it('matches paths ending with forward slash', () => {
    expect(looksLikeDirectoryPath('src/')).toBe(true);
    expect(looksLikeDirectoryPath('src/components/')).toBe(true);
    expect(looksLikeDirectoryPath('/Users/me/')).toBe(true);
  });

  it('matches paths ending with backslash', () => {
    expect(looksLikeDirectoryPath('C:\\Users\\')).toBe(true);
    expect(looksLikeDirectoryPath('src\\')).toBe(true);
  });

  it('rejects paths without trailing separator', () => {
    expect(looksLikeDirectoryPath('src/App.tsx')).toBe(false);
    expect(looksLikeDirectoryPath('C:\\Users\\me\\file.txt')).toBe(false);
    expect(looksLikeDirectoryPath('App.tsx')).toBe(false);
  });

  it('rejects empty string', () => {
    expect(looksLikeDirectoryPath('')).toBe(false);
  });
});

describe('resolveLocalPath', () => {
  it('returns POSIX absolute href as-is regardless of cwd', () => {
    expect(resolveLocalPath('/abs/x.tsx', 'C:\\proj')).toBe('/abs/x.tsx');
  });

  it('returns Windows absolute href as-is regardless of cwd', () => {
    expect(resolveLocalPath('C:\\x\\a.tsx', '/cwd')).toBe('C:\\x\\a.tsx');
  });

  it('joins relative href with Windows-style cwd using backslashes', () => {
    expect(resolveLocalPath('src/App.tsx', 'C:\\proj')).toBe('C:\\proj\\src\\App.tsx');
  });

  it('joins relative href with POSIX cwd using forward slashes', () => {
    expect(resolveLocalPath('src/App.tsx', '/home/user')).toBe('/home/user/src/App.tsx');
  });

  it('strips file:// prefix and leading slash for Windows file URL', () => {
    expect(resolveLocalPath('file:///C:/x.png', '/cwd')).toBe('C:/x.png');
  });

  it('strips file:// prefix for POSIX file URL', () => {
    expect(resolveLocalPath('file:///abs/x.png', '/cwd')).toBe('/abs/x.png');
  });

  it('decodes percent-encoded segments inside file:// URL', () => {
    // Sanity: encoded space/Chinese/etc round-trips back through decodeURIComponent
    expect(resolveLocalPath('file:///abs/with%20space.png', '/cwd')).toBe(
      '/abs/with space.png',
    );
  });

  it('keeps raw path when file:// URL has an invalid percent sequence', () => {
    // Literal `%` in filenames ("100%完成.md", "%APPDATA%") is not a valid
    // escape — a bare decodeURIComponent throws URIError. Remote sessions
    // resolve chat hrefs synchronously during render, so a throw here used to
    // crash the whole route (react-router "URI malformed" error page).
    expect(resolveLocalPath('file:///abs/100%done.md', '/cwd')).toBe('/abs/100%done.md');
    expect(resolveLocalPath('file:///C:/x/%APPDATA%/a.txt', '/cwd')).toBe('C:/x/%APPDATA%/a.txt');
  });

  it('trims trailing separator on cwd before joining', () => {
    expect(resolveLocalPath('a.txt', '/home/user/')).toBe('/home/user/a.txt');
    expect(resolveLocalPath('a.txt', 'C:\\proj\\')).toBe('C:\\proj\\a.txt');
  });

  it('returns UNC share href as-is instead of joining it onto the cwd', () => {
    expect(resolveLocalPath('\\\\server\\share\\a.ts', 'C:\\proj')).toBe('\\\\server\\share\\a.ts');
  });
});

describe('resolveToolFilePath (agent tool-input path absolutizer)', () => {
  // Regression: a model (e.g. Kimi K3) may emit a RELATIVE Read file_path;
  // the runtime resolves it against the session cwd and the Read succeeds,
  // but the preview/reveal IPCs require absolute paths — the chip click used
  // to fail with "Path must be absolute".

  it('joins a relative tool path onto a Windows workingDir', () => {
    expect(
      resolveToolFilePath('packages\\maker-core\\src\\env-builder.ts', 'E:\\github_code\\cindy'),
    ).toBe('E:\\github_code\\cindy\\packages\\maker-core\\src\\env-builder.ts');
  });

  it('joins a relative tool path onto a POSIX workingDir', () => {
    expect(resolveToolFilePath('src/a.ts', '/home/user/proj')).toBe('/home/user/proj/src/a.ts');
  });

  it('normalizes forward slashes in the tool path when workingDir is Windows-style', () => {
    expect(resolveToolFilePath('packages/maker-core/a.ts', 'E:\\repo')).toBe(
      'E:\\repo\\packages\\maker-core\\a.ts',
    );
  });

  it('passes absolute paths through untouched (POSIX / drive-letter / UNC)', () => {
    expect(resolveToolFilePath('/abs/x.ts', 'C:\\proj')).toBe('/abs/x.ts');
    expect(resolveToolFilePath('C:\\x\\a.ts', '/cwd')).toBe('C:\\x\\a.ts');
    expect(resolveToolFilePath('\\\\server\\share\\a.ts', 'C:\\proj')).toBe(
      '\\\\server\\share\\a.ts',
    );
  });

  it('returns the raw path unchanged when workingDir is empty (outside chat stream)', () => {
    expect(resolveToolFilePath('src/a.ts', '')).toBe('src/a.ts');
    expect(resolveToolFilePath('', 'C:\\proj')).toBe('');
  });
});

describe('resolveLocalPathSmart', () => {
  // #7303: an explicit retry must reach the host's refresh option, not just
  // bypass this module's render cache (the real cache regression lives in main).
  it('passes explicit refresh through the existing resolution IPC', async () => {
    const resolvePath = vi.fn().mockResolvedValue({ status: 'none', candidates: [] });
    vi.stubGlobal('window', { electronAPI: { resolvePath } });
    await resolveLocalPathSmart('report.pdf', '/repo', { refresh: true });
    expect(resolvePath).toHaveBeenCalledWith({ href: 'report.pdf', workingDir: '/repo', refresh: true });
  });

  it('passes decoded native paths to the main-process resolver for file URLs', async () => {
    const resolvePath = vi.fn().mockResolvedValue({
      status: 'unique',
      candidates: ['C:\\repo\\src\\App.tsx'],
    });
    vi.stubGlobal('window', { electronAPI: { resolvePath } });

    await expect(resolveLocalPathSmart('file:///C:/repo/src/App.tsx', 'C:\\repo')).resolves.toEqual({
      status: 'unique',
      absPath: 'C:\\repo\\src\\App.tsx',
    });
    expect(resolvePath).toHaveBeenCalledWith({
      href: 'C:/repo/src/App.tsx',
      workingDir: 'C:\\repo',
    });
  });
});

describe('file URL decoding across renderer and main', () => {
  afterEach(() => {
    _clearSmartResolveCache();
  });

  // F3: both IPC paths reach the production host decoder after file URL conversion.
  it.each([
    ['file:///C:/project/a%2520b.pdf', 'C:/project/a%20b.pdf'],
    ['file:///project/a%2520b.pdf', '/project/a%20b.pdf'],
    ['file:///project/report%23final.pdf', '/project/report#final.pdf'],
  ])('preserves the literal target of %s for direct and batched lookup', async (href, expected) => {
    const resolvePath = vi.fn().mockResolvedValue({ status: 'none', candidates: [] });
    const resolvePathBatch = vi.fn().mockResolvedValue({});
    vi.stubGlobal('window', { electronAPI: { resolvePath, resolvePathBatch } });

    await resolveLocalPathSmart(href, '/project', { refresh: true });
    await resolveLocalPathSmartCached(href, '/project');

    expect([
      safeDecodeHrefForLookup(resolvePath.mock.calls[0][0].href),
      safeDecodeHrefForLookup(resolvePathBatch.mock.calls[0][0].hrefs[0]),
    ]).toEqual([expected, expected]);
  });

  it('resolves a literal percent filename through the renderer and main production entry points', async () => {
    let root: string | undefined;

    try {
      root = fs.mkdtempSync(path.join(os.tmpdir(), 'xdt-renderer-path-'));
      const target = path.join(root, 'a%20b.pdf');
      fs.writeFileSync(target, '%PDF');
      const href = toFileUrl(target);

      const resolvePath = vi.fn(({ href: lookupHref, workingDir }: { href: string; workingDir: string }) =>
        resolveWorkspacePath(lookupHref, workingDir));
      const resolvePathBatch = vi.fn(({ hrefs, workingDir }: { hrefs: string[]; workingDir: string }) =>
        resolveWorkspacePathBatch(hrefs, workingDir));
      vi.stubGlobal('window', { electronAPI: { resolvePath, resolvePathBatch } });

      const direct = await resolveLocalPathSmart(href, root, { refresh: true });
      expect(direct.status).toBe('unique');
      if (direct.status === 'unique') {
        expect(direct.kind).toBe('file');
        expect(path.normalize(direct.absPath)).toBe(path.normalize(target));
      }

      const batch = await resolveLocalPathSmartCached(href, root);
      expect(batch.status).toBe('unique');
      if (batch.status === 'unique') {
        expect(batch.kind).toBe('file');
        expect(path.normalize(batch.absPath)).toBe(path.normalize(target));
      }
    } finally {
      if (root) fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('resolveLocalPathSmartCached + peekResolveLocalPathSmart (renderer cache + batch)', () => {
  afterEach(() => {
    _clearSmartResolveCache();
  });

  it('returns undefined on a cold peek', () => {
    expect(peekResolveLocalPathSmart('src/App.tsx', 'C:\\repo')).toBeUndefined();
  });

  it('caches the result so a second lookup hits without a second IPC', async () => {
    const resolvePathBatch = vi.fn().mockResolvedValue({
      'src/App.tsx': {
        status: 'unique',
        candidates: ['C:\\repo\\apps\\desktop\\src\\App.tsx'],
      },
    });
    vi.stubGlobal('window', { electronAPI: { resolvePathBatch } });

    const first = await resolveLocalPathSmartCached('src/App.tsx', 'C:\\repo');
    expect(first).toEqual({
      status: 'unique',
      absPath: 'C:\\repo\\apps\\desktop\\src\\App.tsx',
    });
    // The synchronous peek now returns that same result — this is what lets a
    // re-mounted reference paint its chip on the first render with no flash.
    expect(peekResolveLocalPathSmart('src/App.tsx', 'C:\\repo')).toEqual(first);

    const second = await resolveLocalPathSmartCached('src/App.tsx', 'C:\\repo');
    expect(second).toEqual(first);
    expect(resolvePathBatch).toHaveBeenCalledTimes(1);
  });

  it('batches different hrefs in one workingDir into a single resolvePathBatch IPC', async () => {
    // The whole point of the scheduler: one session switch mounts many refs,
    // but they collapse into ONE main-process walk.
    const resolvePathBatch = vi
      .fn()
      .mockImplementation(({ hrefs, workingDir }: { hrefs: string[]; workingDir: string }) =>
        Promise.resolve(
          Object.fromEntries(
            hrefs.map((h) => [h, { status: 'unique', candidates: [`${workingDir}/${h}`] }]),
          ),
        ),
      );
    vi.stubGlobal('window', { electronAPI: { resolvePathBatch } });

    const [a, b, c] = await Promise.all([
      resolveLocalPathSmartCached('src/A.tsx', '/repo'),
      resolveLocalPathSmartCached('src/B.tsx', '/repo'),
      resolveLocalPathSmartCached('src/C.tsx', '/repo'),
    ]);
    expect(a).toEqual({ status: 'unique', absPath: '/repo/src/A.tsx' });
    expect(b).toEqual({ status: 'unique', absPath: '/repo/src/B.tsx' });
    expect(c).toEqual({ status: 'unique', absPath: '/repo/src/C.tsx' });
    expect(resolvePathBatch).toHaveBeenCalledTimes(1);
    expect(resolvePathBatch.mock.calls[0][0].hrefs).toEqual(
      expect.arrayContaining(['src/A.tsx', 'src/B.tsx', 'src/C.tsx']),
    );
  });

  it('de-dups concurrent lookups of the same key into one batch entry', async () => {
    const resolvePathBatch = vi.fn().mockResolvedValue({
      'missing.ts': { status: 'none', candidates: [] },
    });
    vi.stubGlobal('window', { electronAPI: { resolvePathBatch } });

    const [a, b] = await Promise.all([
      resolveLocalPathSmartCached('missing.ts', '/repo'),
      resolveLocalPathSmartCached('missing.ts', '/repo'),
    ]);
    expect(a).toEqual(b);
    expect(resolvePathBatch).toHaveBeenCalledTimes(1);
  });

  it('caches none-results too so unresolvable refs stop re-searching', async () => {
    const resolvePathBatch = vi.fn().mockResolvedValue({
      'ghost/x.ts': { status: 'none', candidates: [] },
    });
    vi.stubGlobal('window', { electronAPI: { resolvePathBatch } });

    await resolveLocalPathSmartCached('ghost/x.ts', '/repo');
    expect(peekResolveLocalPathSmart('ghost/x.ts', '/repo')).toEqual({
      status: 'none',
      fallbackAbsPath: '/repo/ghost/x.ts',
    });
    await resolveLocalPathSmartCached('ghost/x.ts', '/repo');
    expect(resolvePathBatch).toHaveBeenCalledTimes(1);
  });

  it('keys by (workingDir, href) — different dirs flush as separate batches', async () => {
    const resolvePathBatch = vi
      .fn()
      .mockImplementation(({ hrefs, workingDir }: { hrefs: string[]; workingDir: string }) =>
        Promise.resolve(
          Object.fromEntries(
            hrefs.map((h) => [h, { status: 'unique', candidates: [`${workingDir}/${h}`] }]),
          ),
        ),
      );
    vi.stubGlobal('window', { electronAPI: { resolvePathBatch } });

    const [a, b] = await Promise.all([
      resolveLocalPathSmartCached('x.ts', '/a'),
      resolveLocalPathSmartCached('x.ts', '/b'),
    ]);
    expect(a).toEqual({ status: 'unique', absPath: '/a/x.ts' });
    expect(b).toEqual({ status: 'unique', absPath: '/b/x.ts' });
    // One batch per workingDir.
    expect(resolvePathBatch).toHaveBeenCalledTimes(2);
  });

  it('falls back to legacy resolution when resolvePathBatch is unavailable', async () => {
    vi.stubGlobal('window', { electronAPI: {} });
    const r = await resolveLocalPathSmartCached('src/x.ts', '/repo');
    expect(r).toEqual({ status: 'none', fallbackAbsPath: '/repo/src/x.ts' });
  });

  // 否定重查还没返回时，这条结论被缓存容量（500 条）挤掉：同路径的普通查找要加入这次重查，
  // 不能再发一个不带 revalidateNegative 的查找，让两个结果互相覆盖。
  it('joins a negative re-check in flight after the cache dropped the entry', async () => {
    let answer!: (raw: Record<string, unknown>) => void;
    const resolvePathBatch = vi.fn(
      async ({ hrefs, revalidateNegative }: { hrefs: string[]; revalidateNegative?: boolean }) => {
        if (revalidateNegative) return new Promise<Record<string, unknown>>((resolve) => { answer = resolve; });
        return Object.fromEntries(hrefs.map((href) => [href, { status: 'none', candidates: [] }]));
      },
    );
    vi.stubGlobal('window', { electronAPI: { resolvePathBatch } });
    await resolveLocalPathSmartCached('out/clip.mp4', '/task');
    const start = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => start + 3_000);

    const recheck = revalidateNegativeLocalPathSmart('out/clip.mp4', '/task', start + 3_000);
    await Promise.resolve();
    await Promise.all(Array.from({ length: 500 }, (_, i) => resolveLocalPathSmartCached(`other-${i}.ts`, '/task')));
    expect(peekResolveLocalPathSmart('out/clip.mp4', '/task')).toBeUndefined();
    const calls = resolvePathBatch.mock.calls.length;

    const plain = resolveLocalPathSmartCached('out/clip.mp4', '/task');
    answer({ 'out/clip.mp4': { status: 'unique', candidates: ['/task/film/out/clip.mp4'] } });
    expect(await plain).toEqual({ status: 'unique', absPath: '/task/film/out/clip.mp4' });
    expect(await recheck).toEqual({ status: 'unique', absPath: '/task/film/out/clip.mp4' });
    expect(resolvePathBatch).toHaveBeenCalledTimes(calls);
    vi.restoreAllMocks();
  });
});

describe('resolveKnownLocalFileHref', () => {
  const file = {
    name: 'GitHub 身份治理与 AI-Native 工作流演进方案.docx',
    path: '/Users/me/Documents/GitHub 身份治理与 AI-Native 工作流演进方案.docx',
  };

  it('resolves model-authored bare attachment filename links', () => {
    expect(resolveKnownLocalFileHref(file.name, [file])).toBe(file.path);
  });

  it('resolves percent-encoded attachment filename links', () => {
    expect(resolveKnownLocalFileHref(encodeURIComponent(file.name), [file])).toBe(file.path);
  });

  it('resolves links whose basename matches the attachment path', () => {
    expect(resolveKnownLocalFileHref(`docs/${file.name}`, [file])).toBe(file.path);
  });

  it('does not resolve duplicate attachment basenames', () => {
    expect(resolveKnownLocalFileHref('a.docx', [
      { name: 'a.docx', path: '/tmp/one/a.docx' },
      { name: 'a.docx', path: '/tmp/two/a.docx' },
    ])).toBeNull();
  });

  it('returns null when no attachment matches', () => {
    expect(resolveKnownLocalFileHref('missing.docx', [file])).toBeNull();
  });

  it('matches case-insensitively (Windows / macOS-default FS friendly)', () => {
    const mixedCase = {
      name: 'Report.DOCX',
      path: 'C:\\Users\\me\\Documents\\Report.DOCX',
    };
    expect(resolveKnownLocalFileHref('report.docx', [mixedCase])).toBe(mixedCase.path);
    expect(resolveKnownLocalFileHref('REPORT.DOCX', [mixedCase])).toBe(mixedCase.path);
  });
});

describe('looksLikeFilePath (inline-code path detector)', () => {
  // ---- POSITIVES ----
  it('matches Windows absolute path with backslash', () => {
    expect(looksLikeFilePath('E:\\AIWork\\claude-use\\20mb_file.txt')).toBe(true);
    expect(looksLikeFilePath('C:\\Users\\me\\foo.tsx')).toBe(true);
  });

  it('matches Windows absolute path with forward slash', () => {
    expect(looksLikeFilePath('D:/projects/app.ts')).toBe(true);
  });

  it('matches POSIX absolute path with file extension', () => {
    expect(looksLikeFilePath('/Users/me/notes.md')).toBe(true);
    expect(looksLikeFilePath('/home/user/script.sh')).toBe(true);
    expect(looksLikeFilePath('/abs/x.tsx')).toBe(true);
  });

  it('matches relative path with separator + extension', () => {
    expect(looksLikeFilePath('src/App.tsx')).toBe(true);
    expect(looksLikeFilePath('./foo.md')).toBe(true);
    expect(looksLikeFilePath('../sibling/foo.json')).toBe(true);
    expect(looksLikeFilePath('apps/desktop/src/index.ts')).toBe(true);
  });

  it('matches paths with backslash separator (Windows-style relative)', () => {
    expect(looksLikeFilePath('src\\App.tsx')).toBe(true);
  });

  // ---- NEGATIVES (the whole reason this exists) ----
  it('rejects identifiers with no separator and no extension', () => {
    expect(looksLikeFilePath('useState')).toBe(false);
    expect(looksLikeFilePath('hello')).toBe(false);
  });

  it('rejects bare filename with extension but no separator', () => {
    // Intentional: too ambiguous — there could be many `package.json` in a
    // workspace. Caller can wrap in markdown link syntax for explicit intent.
    expect(looksLikeFilePath('package.json')).toBe(false);
    expect(looksLikeFilePath('App.tsx')).toBe(false);
  });

  it('rejects shell commands and flags (whitespace)', () => {
    expect(looksLikeFilePath('npm run build')).toBe(false);
    expect(looksLikeFilePath('--filter desktop')).toBe(false);
    expect(looksLikeFilePath('git commit -m "msg"')).toBe(false);
  });

  it('rejects URL-scheme strings', () => {
    expect(looksLikeFilePath('https://example.com/foo.json')).toBe(false);
    expect(looksLikeFilePath('http://localhost:3000/app.ts')).toBe(false);
    expect(looksLikeFilePath('file:///abs/x.md')).toBe(false);
    expect(looksLikeFilePath('git+ssh://host/repo.git')).toBe(false);
  });

  it('rejects POSIX absolute paths without file extension', () => {
    // /etc, /dev/null etc. are unix paths but not previewable text files in
    // the chat-message context — keep the false-positive surface tight.
    expect(looksLikeFilePath('/etc')).toBe(false);
    expect(looksLikeFilePath('/dev/null')).toBe(false);
    expect(looksLikeFilePath('/usr/local/bin')).toBe(false);
  });

  it('rejects SSH-style host:path strings (colon in middle)', () => {
    expect(looksLikeFilePath('user@host:path/foo.txt')).toBe(false);
  });

  it('rejects multi-line content', () => {
    expect(looksLikeFilePath('src/App.tsx\nsecond line')).toBe(false);
  });

  it('rejects empty string', () => {
    expect(looksLikeFilePath('')).toBe(false);
  });

  it('matches image paths too — caller decides routing via classifyMarkdownHref', () => {
    // looksLikeFilePath is a pure path-shape predicate; the image vs text
    // routing happens downstream so paths like `./logo.png` still light up.
    expect(looksLikeFilePath('./logo.png')).toBe(true);
    expect(looksLikeFilePath('C:\\images\\hero.jpg')).toBe(true);
  });

  it('rejects directory shapes (trailing separator)', () => {
    // Folder refs are not file paths — the renderer must not turn them into
    // TextLightbox triggers. Pre-fix, `C:\Users\` slipped through because
    // WIN_ABS_RE only checks the prefix.
    expect(looksLikeFilePath('src/components/')).toBe(false);
    expect(looksLikeFilePath('./docs/')).toBe(false);
    expect(looksLikeFilePath('../sibling/')).toBe(false);
    expect(looksLikeFilePath('/Users/me/dir/')).toBe(false);
    expect(looksLikeFilePath('C:\\Users\\')).toBe(false);
    expect(looksLikeFilePath('D:/projects/')).toBe(false);
    expect(looksLikeFilePath('src\\')).toBe(false);
  });
});

describe('toFileUrl', () => {
  it('converts POSIX absolute path to file:///', () => {
    expect(toFileUrl('/abs/x.png')).toBe('file:///abs/x.png');
  });

  it('converts Windows path with forward slashes to file:///', () => {
    expect(toFileUrl('C:/x/a.png')).toBe('file:///C:/x/a.png');
  });

  it('normalizes backslashes to forward slashes', () => {
    expect(toFileUrl('C:\\x\\a.png')).toBe('file:///C:/x/a.png');
  });

  it('percent-encodes space in path segment', () => {
    expect(toFileUrl('/abs/with space.png')).toBe('file:///abs/with%20space.png');
  });
});

describe('toLocalFileUrl', () => {
  it('adds an encoded revision without changing the encoded file path', () => {
    expect(toLocalFileUrl('/abs/icon image.png', '12:34.5')).toBe(
      'xdt-file://local/?path=%2Fabs%2Ficon%20image.png&v=12%3A34.5',
    );
  });
});
