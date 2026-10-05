import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildProjectBrief, createBriefCache, parseGithubRemote, type WorkbenchBriefDeps } from '../botWorkbenchBrief.js';

let root: string | null = null;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = null;
});

async function project() {
  root = await mkdtemp(path.join(os.tmpdir(), 'wb-brief-'));
  await mkdir(path.join(root, 'node_modules', 'pkg'), { recursive: true });
  await writeFile(path.join(root, 'node_modules', 'pkg', 'index.js'), '');
  await mkdir(path.join(root, 'docs', 'deep'), { recursive: true });
  await writeFile(path.join(root, 'notes.md'), '');
  await writeFile(path.join(root, 'DESIGN.md'), '');
  await writeFile(path.join(root, 'README.md'), '');
  await writeFile(path.join(root, 'docs', 'guide.md'), '');
  await mkdir(path.join(root, 'docs', 'product-rules'), { recursive: true });
  await mkdir(path.join(root, 'docs', 'dev-rules', 'deep'), { recursive: true });
  await writeFile(path.join(root, 'docs', 'product-rules', 'core.md'), '');
  await writeFile(path.join(root, 'docs', 'dev-rules', 'deep', 'setup.md'), '');
  await writeFile(path.join(root, 'docs', 'design-rules-DESIGN.md'), '');
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src', 'ignored.md'), '');
  return root;
}

function gitDeps(overrides: Partial<WorkbenchBriefDeps> = {}): WorkbenchBriefDeps {
  // 「最近」以真实时间为准:临时文件的 mtime 就是现在。
  const outputs: Record<string, string> = {
    'rev-parse --is-inside-work-tree': 'true\n',
    'rev-parse --abbrev-ref HEAD': 'main\n',
    'status --porcelain': ' M a.ts\n?? b.ts\n',
    'remote get-url upstream': 'https://github.com/org/app.git\n',
    'remote get-url origin': 'git@github.com:me/app.git\n',
  };
  return {
    git: vi.fn(async (_cwd: string, args: string[]) => {
      const key = args.join(' ');
      if (args[0] === 'log') return 'abc123\u00002026-09-30T10:00:00+08:00\u0000Me\u0000fix icons\n';
      if (args[0] === 'for-each-ref') return 'main\u00002026-09-30T10:00:00+08:00\nfeat\u00002026-09-29T10:00:00+08:00\n';
      return outputs[key] ?? null;
    }),
    searchGithub: vi.fn(async (query: string) => [{
      number: query.includes('is:pr') ? 12 : 7,
      title: query.includes('is:pr') ? 'Icons PR' : 'Icon bug',
      state: 'open',
      updatedAt: '2026-09-30T00:00:00Z',
      url: 'https://github.com/me/app/x',
    }]),
    now: () => Date.now(),
    ...overrides,
  };
}

describe('parseGithubRemote', () => {
  it('reads owner/repo from ssh and https remotes only', () => {
    expect(parseGithubRemote('git@github.com:me/app.git')).toBe('me/app');
    expect(parseGithubRemote('https://github.com/me/app')).toBe('me/app');
    expect(parseGithubRemote('https://gitlab.com/me/app.git')).toBeNull();
    expect(parseGithubRemote(null)).toBeNull();
  });
});

describe('buildProjectBrief', () => {
  it('lists top-level and docs Markdown paths with key docs first, plus recent git and GitHub items', async () => {
    const dir = await project();
    const deps = gitDeps({ now: () => Date.parse('2026-10-01T00:00:00Z') });
    const brief = await buildProjectBrief(dir, deps);
    expect(brief.docs.map((file) => path.relative(dir, file))).toEqual([
      'DESIGN.md',
      'README.md',
      path.join('docs', 'product-rules', 'core.md'),
      path.join('docs', 'dev-rules', 'deep', 'setup.md'),
      'notes.md',
      path.join('docs', 'design-rules-DESIGN.md'),
      path.join('docs', 'guide.md'),
    ]);
    expect(brief.recent).toEqual([]);
    expect(brief.git).toMatchObject({
      branch: 'main',
      changes: 2,
      remote: 'org/app',
      remotes: ['org/app', 'me/app'],
      commits: [{ sha: 'abc123', author: 'Me', subject: 'fix icons' }],
      branches: [{ name: 'main' }, { name: 'feat' }],
    });
    // fork 工作流:PR / issue 查 upstream。
    expect(brief.github).toMatchObject({ repo: 'org/app', pullRequests: [{ number: 12 }], issues: [{ number: 7 }] });
    expect(vi.mocked(deps.searchGithub).mock.calls[0]![0]).toContain('repo:org/app');
    const log = vi.mocked(deps.git).mock.calls.find(([, args]) => args[0] === 'log')![1];
    expect(log).toContain('--since=2026-09-17T00:00:00.000Z');
    expect(log).toContain('--max-count=30');
  });

  it('reports missing pieces instead of guessing', async () => {
    const dir = await project();
    expect((await buildProjectBrief(dir, gitDeps({ searchGithub: vi.fn(async () => null) }))).github)
      .toEqual({ unavailable: 'no-credential' });
    expect((await buildProjectBrief(dir, gitDeps({ searchGithub: vi.fn(async () => { throw new Error('rate'); }) }))).github)
      .toEqual({ unavailable: 'error' });
    const plain = await buildProjectBrief(dir, gitDeps({ git: vi.fn(async () => null) }));
    expect(plain).toMatchObject({ git: null, github: { unavailable: 'not-github' } });
    expect(plain.docs.length).toBe(7);
    // 不是 git 仓库:给最近 14 天改过的文件,跳过 node_modules 与隐藏目录。
    expect(plain.recent.map((file) => path.relative(dir, file.path)).sort()).toContain(path.join('src', 'ignored.md'));
    expect(plain.recent.length).toBeLessThanOrEqual(20);
    const missing = await buildProjectBrief(path.join(dir, 'nope'), gitDeps({ git: vi.fn(async () => null) }));
    expect(missing).toEqual({ docs: [], recent: [], git: null, github: { unavailable: 'not-github' } });
  });
});

describe('createBriefCache', () => {
  it('reuses a brief for 60 seconds unless the fingerprint changes', async () => {
    const dir = await project();
    let now = 0;
    let print = 'a';
    const deps = gitDeps({ now: () => now });
    const readBrief = createBriefCache({ ...deps, fingerprint: async () => print });
    await readBrief(dir);
    await readBrief(dir);
    expect(vi.mocked(deps.searchGithub)).toHaveBeenCalledTimes(3);
    print = 'b';
    await readBrief(dir);
    expect(vi.mocked(deps.searchGithub)).toHaveBeenCalledTimes(6);
    now = 61_000;
    await readBrief(dir);
    expect(vi.mocked(deps.searchGithub)).toHaveBeenCalledTimes(9);
  });
});
