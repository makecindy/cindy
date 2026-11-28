/**
 * External links in chat messages, described from the URL alone.
 *
 * Desktop and Mobile group chats share this so a pasted link reads the same on both:
 * a bare `https://github.com/o/r/pull/1` shows as `o/r#1`, a long web address as its
 * site and a shortened path. Nothing here fetches; a PR title and state come from the
 * desktop's existing status cache when it has one.
 */

export type GithubLinkType =
  | 'pull'
  | 'issue'
  | 'discussion'
  | 'commit'
  | 'file'
  | 'folder'
  | 'release'
  | 'repo';

export type ExternalLinkInfo =
  | {
      kind: 'github';
      type: GithubLinkType;
      url: string;
      owner: string;
      repo: string;
      /** PR, issue or discussion number. */
      number?: number;
      /** Full commit SHA as written in the URL. */
      sha?: string;
      /** Path inside the repository for files and folders, without the branch. */
      path?: string;
      /** `L12` or `L12-L20` from a file permalink. */
      lines?: { start: number; end?: number };
      /** Release tag. */
      tag?: string;
    }
  | { kind: 'web'; url: string; host: string; path: string };

const NAME = /^[A-Za-z0-9_.-]+$/;
const LABEL_MAX = 48;
/** GitHub top-level paths that are product pages, not users or organizations. */
const GITHUB_RESERVED = new Set([
  'about', 'apps', 'collections', 'contact', 'customer-stories', 'enterprise', 'events', 'explore',
  'features', 'login', 'logout', 'marketplace', 'new', 'notifications', 'orgs', 'organizations',
  'pricing', 'pulls', 'issues', 'search', 'settings', 'signup', 'sponsors', 'topics', 'trending',
]);

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function positiveInt(value: string | undefined): number | undefined {
  if (!value || !/^[1-9]\d{0,9}$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function githubLines(hash: string): { start: number; end?: number } | undefined {
  const match = /^#L(\d+)(?:C\d+)?(?:-L(\d+)(?:C\d+)?)?$/.exec(hash);
  const start = positiveInt(match?.[1]);
  if (!match || start === undefined) return undefined;
  const end = positiveInt(match[2]);
  return end !== undefined && end > start ? { start, end } : { start };
}

function describeGithub(url: URL): ExternalLinkInfo | null {
  const segments = url.pathname.split('/').filter(Boolean).map(decodeSegment);
  const [owner, repo, section, ...rest] = segments;
  if (!owner || !repo || !NAME.test(owner) || !NAME.test(repo) || GITHUB_RESERVED.has(owner.toLowerCase())) return null;
  const base = { kind: 'github' as const, url: url.href, owner, repo: repo.replace(/\.git$/i, '') };
  if (section === undefined) return { ...base, type: 'repo' };
  const number = positiveInt(rest[0]);
  if (section === 'pull' && number !== undefined) return { ...base, type: 'pull', number };
  if (section === 'issues' && number !== undefined) return { ...base, type: 'issue', number };
  if (section === 'discussions' && number !== undefined) return { ...base, type: 'discussion', number };
  if (section === 'commit' && rest[0] && /^[0-9a-f]{7,40}$/i.test(rest[0])) {
    return { ...base, type: 'commit', sha: rest[0].toLowerCase() };
  }
  if ((section === 'blob' || section === 'tree') && rest.length >= 1) {
    // The branch may contain slashes; without the API the first segment is the best guess.
    const path = rest.slice(1).join('/');
    if (section === 'tree' && !path) return { ...base, type: 'repo' };
    if (!path) return null;
    const lines = section === 'blob' ? githubLines(url.hash) : undefined;
    return { ...base, type: section === 'blob' ? 'file' : 'folder', path, ...(lines ? { lines } : {}) };
  }
  if (section === 'releases' && rest[0] === 'tag' && rest[1]) {
    return { ...base, type: 'release', tag: rest.slice(1).join('/') };
  }
  return null;
}

/** Only http(s) URLs are described; anything else returns null and keeps its existing rendering. */
export function describeExternalLink(href: string): ExternalLinkInfo | null {
  if (!href || href.length > 4096) return null;
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || !url.hostname || url.username || url.password) return null;
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  if (host === 'github.com' && !url.port) {
    const github = describeGithub(url);
    if (github) return github;
  }
  const path = url.pathname
    .split('/')
    .filter(Boolean)
    .map(decodeSegment)
    .join('/');
  return { kind: 'web', url: url.href, host: url.port ? `${host}:${url.port}` : host, path };
}

function lineLabel(lines: { start: number; end?: number } | undefined): string {
  if (!lines) return '';
  return lines.end === undefined ? `:${lines.start}` : `:${lines.start}-${lines.end}`;
}

function lastSegment(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1] || path;
}

/** Keeps the start and the end of a long label, which is where people look. */
function shortenMiddle(text: string, max = LABEL_MAX): string {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  const head = Math.ceil((max - 1) * 0.55);
  const tail = max - 1 - head;
  return `${chars.slice(0, head).join('')}…${chars.slice(chars.length - tail).join('')}`;
}

function webLabel(host: string, path: string): string {
  if (!path) return host;
  const full = `${host}/${path}`;
  if (Array.from(full).length <= LABEL_MAX) return full;
  const parts = path.split('/');
  const last = parts[parts.length - 1];
  // site/first/…/last keeps both where the page lives and what it is.
  if (parts.length > 2) {
    const kept = `${host}/${parts[0]}/…/${last}`;
    if (Array.from(kept).length <= LABEL_MAX) return kept;
  }
  if (parts.length > 1) {
    const kept = `${host}/…/${last}`;
    if (Array.from(kept).length <= LABEL_MAX) return kept;
  }
  return shortenMiddle(full);
}

/**
 * The text shown in place of a bare URL. GitHub follows GitHub's own short references
 * (`owner/repo#12`, `owner/repo@abc1234`); other sites show the site and a shortened path.
 */
export function externalLinkLabel(info: ExternalLinkInfo): string {
  if (info.kind === 'web') return webLabel(info.host, info.path);
  const repo = `${info.owner}/${info.repo}`;
  switch (info.type) {
    case 'pull':
    case 'issue':
    case 'discussion':
      return `${repo}#${info.number}`;
    case 'commit':
      return `${repo}@${info.sha?.slice(0, 7)}`;
    case 'file':
      return shortenMiddle(`${repo}/${lastSegment(info.path ?? '')}${lineLabel(info.lines)}`);
    case 'folder':
      return shortenMiddle(`${repo}/${lastSegment(info.path ?? '')}/`);
    case 'release':
      return shortenMiddle(`${repo}@${info.tag}`);
    case 'repo':
      return repo;
  }
}
