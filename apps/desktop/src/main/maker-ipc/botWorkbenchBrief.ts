/**
 * 伙伴工作台的项目素材(brief):宿主现算、有界、只看近期、带缓存,不经过模型。
 *
 * - docs:顶层与 `docs/` 下两级以内的 Markdown 文件路径(最多 30 个),只给路径不给正文;顺序为
 *   顶层 README / DESIGN / AGENTS / CLAUDE → docs 里同名的 → `docs/product-rules` → `docs/dev-rules`
 *   → 其余顶层 → 其余 docs;
 * - recent:不是 git 仓库时,最近 14 天改过的文件(最多 20 个,跳过隐藏目录与 node_modules 等),
 *   让伙伴在没有提交记录时也知道最近动了什么;
 * - git:当前分支、未提交改动数、最近 14 天的提交(最多 30 条)、最近有提交的本地分支(最多 10 个);
 *   每条命令限时,拿不到就缺项;
 * - github:远端是 GitHub 且本机已有 gh 登录时,我打开的 PR 与指派给我 / 我开的 issue(各最多 10 条);
 *   没有凭证返回 `unavailable: 'no-credential'`,不猜、不弹登录。
 * 按项目缓存 60 秒,目录 mtime 或 git HEAD / index 变化即失效。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

export interface WorkbenchBriefCommit {
  sha: string;
  date: string;
  author: string;
  subject: string;
}

export interface WorkbenchBriefGithubItem {
  number: number;
  title: string;
  state: string;
  updatedAt: string;
  url: string;
}

export interface WorkbenchProjectBrief {
  docs: string[];
  /** 不是 git 仓库时最近 14 天改过的文件;git 仓库为空(看 git.commits)。 */
  recent: Array<{ path: string; modifiedAt: string }>;
  git: {
    branch: string | null;
    changes: number | null;
    commits: WorkbenchBriefCommit[];
    branches: Array<{ name: string; date: string }>;
    /** 查 PR / issue 用的 GitHub `owner/repo`:fork 工作流优先 `upstream`,否则 `origin`;都不是 GitHub 为 null。 */
    remote: string | null;
    /** `upstream` 与 `origin` 里所有 GitHub `owner/repo`(条目归属项目时都认)。 */
    remotes: string[];
  } | null;
  github:
    | { repo: string; pullRequests: WorkbenchBriefGithubItem[]; issues: WorkbenchBriefGithubItem[] }
    | { unavailable: 'no-credential' | 'not-github' | 'error' };
}

export interface WorkbenchBriefDeps {
  /** 在 cwd 里跑 git,失败返回 null(限时由实现保证)。 */
  git(cwd: string, args: string[]): Promise<string | null>;
  /** 以 GitHub 搜索语法查 issue / PR;没有凭证返回 null。 */
  searchGithub(query: string, limit: number): Promise<WorkbenchBriefGithubItem[] | null>;
  now(): number;
}

export const BRIEF_MAX_DOCS = 30;
export const BRIEF_MAX_COMMITS = 30;
export const BRIEF_MAX_BRANCHES = 10;
export const BRIEF_MAX_GITHUB = 10;
export const BRIEF_MAX_RECENT_FILES = 20;
const BRIEF_RECENT_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
/** 找最近改过的文件时最多看这么多目录项,大目录也有界。 */
const RECENT_SCAN_BUDGET = 3_000;
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'out', 'target', 'vendor', 'Pods', 'DerivedData', '__pycache__']);
export const BRIEF_TTL_MS = 60_000;
const DOC_PRIORITY = /^(readme|design|agents|claude)(\.|$)/i;

/** 从 git 远端地址解析 GitHub 的 `owner/repo`。 */
export function parseGithubRemote(url: string | null | undefined): string | null {
  if (!url) return null;
  const match = /github\.com[:/]([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(url.trim());
  return match ? `${match[1]}/${match[2]}` : null;
}

async function listMarkdown(projectDir: string): Promise<string[]> {
  const out: string[] = [];
  const visit = async (dir: string, depth: number) => {
    if (out.length >= 200) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isFile() && /\.mdx?$/i.test(entry.name)) out.push(full);
      // docs/ 本身算第一层,再往下两级:docs/<a>/<b>/*.md。
      else if (entry.isDirectory() && depth < 3 && (depth > 0 || entry.name === 'docs')) await visit(full, depth + 1);
    }
  };
  await visit(projectDir, 0);
  const rank = (file: string) => {
    const relative = path.relative(projectDir, file).split(path.sep).join('/');
    const top = !relative.includes('/');
    const key = DOC_PRIORITY.test(path.basename(file));
    if (top && key) return 0;
    if (key) return 1;
    if (relative.startsWith('docs/product-rules/')) return 2;
    if (relative.startsWith('docs/dev-rules/')) return 3;
    return top ? 4 : 5;
  };
  return out
    .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
    .slice(0, BRIEF_MAX_DOCS);
}

async function listRecentFiles(projectDir: string, since: number): Promise<WorkbenchProjectBrief['recent']> {
  const found: Array<{ path: string; mtimeMs: number }> = [];
  let budget = RECENT_SCAN_BUDGET;
  const visit = async (dir: string, depth: number) => {
    if (budget <= 0) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (--budget <= 0) return;
      if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < 4) await visit(full, depth + 1);
      } else if (entry.isFile()) {
        const stat = await fs.stat(full).catch(() => null);
        if (stat && stat.mtimeMs >= since) found.push({ path: full, mtimeMs: stat.mtimeMs });
      }
    }
  };
  await visit(projectDir, 0);
  return found
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, BRIEF_MAX_RECENT_FILES)
    .map((file) => ({ path: file.path, modifiedAt: new Date(file.mtimeMs).toISOString() }));
}

function parseCommits(raw: string | null): WorkbenchBriefCommit[] {
  if (!raw) return [];
  return raw
    .split('\n')
    .filter(Boolean)
    .slice(0, BRIEF_MAX_COMMITS)
    .map((line) => {
      const [sha = '', date = '', author = '', subject = ''] = line.split('\u0000');
      return { sha, date, author: author.slice(0, 80), subject: subject.slice(0, 200) };
    })
    .filter((commit) => commit.sha);
}

export async function buildProjectBrief(projectDir: string, deps: WorkbenchBriefDeps): Promise<WorkbenchProjectBrief> {
  const sinceIso = new Date(deps.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
  const [docs, inside] = await Promise.all([
    listMarkdown(projectDir),
    deps.git(projectDir, ['rev-parse', '--is-inside-work-tree']),
  ]);
  if (inside?.trim() !== 'true') {
    const recent = await listRecentFiles(projectDir, deps.now() - BRIEF_RECENT_WINDOW_MS);
    return { docs, recent, git: null, github: { unavailable: 'not-github' } };
  }
  const [branch, status, log, refs, upstreamUrl, originUrl] = await Promise.all([
    deps.git(projectDir, ['rev-parse', '--abbrev-ref', 'HEAD']),
    deps.git(projectDir, ['status', '--porcelain']),
    deps.git(projectDir, [
      'log',
      `--since=${sinceIso}`,
      `--max-count=${BRIEF_MAX_COMMITS}`,
      '--format=%h%x00%cI%x00%an%x00%s',
    ]),
    deps.git(projectDir, [
      'for-each-ref',
      '--sort=-committerdate',
      `--count=${BRIEF_MAX_BRANCHES}`,
      '--format=%(refname:short)%00%(committerdate:iso-strict)',
      'refs/heads',
    ]),
    deps.git(projectDir, ['remote', 'get-url', 'upstream']),
    deps.git(projectDir, ['remote', 'get-url', 'origin']),
  ]);
  const remotes = [...new Set([parseGithubRemote(upstreamUrl), parseGithubRemote(originUrl)].filter((item): item is string => Boolean(item)))];
  const remote = remotes[0] ?? null;
  const git = {
    branch: branch?.trim() && branch.trim() !== 'HEAD' ? branch.trim() : null,
    changes: status === null ? null : status.split('\n').filter(Boolean).length,
    commits: parseCommits(log),
    branches: (refs ?? '')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [name = '', date = ''] = line.split('\u0000');
        return { name, date };
      })
      .filter((item) => item.name)
      .slice(0, BRIEF_MAX_BRANCHES),
    remote,
    remotes,
  };
  if (!remote) return { docs, recent: [], git, github: { unavailable: 'not-github' } };
  try {
    const [pullRequests, authored, assigned] = await Promise.all([
      deps.searchGithub(`repo:${remote} is:pr is:open author:@me`, BRIEF_MAX_GITHUB),
      deps.searchGithub(`repo:${remote} is:issue is:open author:@me`, BRIEF_MAX_GITHUB),
      deps.searchGithub(`repo:${remote} is:issue is:open assignee:@me`, BRIEF_MAX_GITHUB),
    ]);
    if (pullRequests === null || authored === null || assigned === null) {
      return { docs, recent: [], git, github: { unavailable: 'no-credential' } };
    }
    const issues = new Map<number, WorkbenchBriefGithubItem>();
    for (const item of [...assigned, ...authored]) if (!issues.has(item.number)) issues.set(item.number, item);
    return {
      docs,
      recent: [],
      git,
      github: {
        repo: remote,
        pullRequests: pullRequests.slice(0, BRIEF_MAX_GITHUB),
        issues: [...issues.values()]
          .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
          .slice(0, BRIEF_MAX_GITHUB),
      },
    };
  } catch {
    return { docs, recent: [], git, github: { unavailable: 'error' } };
  }
}

/** 缓存指纹:目录 mtime + `.git/HEAD` 内容 + `.git/index` mtime;读不到的部分记空。 */
export async function briefFingerprint(projectDir: string): Promise<string> {
  const stat = async (file: string) => (await fs.stat(file).catch(() => null))?.mtimeMs ?? 0;
  const head = await fs.readFile(path.join(projectDir, '.git', 'HEAD'), 'utf8').catch(() => '');
  return [await stat(projectDir), head.trim(), await stat(path.join(projectDir, '.git', 'index'))].join('|');
}

export function createBriefCache(deps: WorkbenchBriefDeps & { fingerprint?: (dir: string) => Promise<string> }) {
  const cache = new Map<string, { at: number; fingerprint: string; brief: WorkbenchProjectBrief }>();
  const fingerprint = deps.fingerprint ?? briefFingerprint;
  return async function readBrief(projectDir: string): Promise<WorkbenchProjectBrief> {
    const now = deps.now();
    const print = await fingerprint(projectDir);
    const cached = cache.get(projectDir);
    if (cached && cached.fingerprint === print && now - cached.at < BRIEF_TTL_MS) return cached.brief;
    const brief = await buildProjectBrief(projectDir, deps);
    if (cache.size > 64) cache.clear();
    cache.set(projectDir, { at: now, fingerprint: print, brief });
    return brief;
  };
}
