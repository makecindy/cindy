import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { groupRepositoryCloneUrl, groupRepositoryKey, parseGroupRepository, type GroupRepository } from '@cindy/maker-shared/botGroupChat';

/**
 * Cindy's own checkout of a group's repository (bot-group-chat.md §7.5). A group with a repository
 * works in that repository: when no project registered on this computer is it, Cindy keeps one copy
 * per repository — `<root>/github/<owner>/<name>` for GitHub, `<root>/<host>/<path>` for GitLab,
 * CNB and other git hosts — shared by every group with that repository, and registers it as an
 * ordinary project named after the repository.
 *
 * - The folder is there from the first request on, so the group's task opens in it at once; the
 *   repository is cloned into it in the background (latest version only) and never delays a reply.
 * - GitHub: clone, pull and push use Cindy's GitHub sign-in on this computer (`gh auth
 *   git-credential`, set in the checkout's own git config; no credential is written anywhere). Not
 *   signed in: Cindy may open its own GitHub sign-in and wait a short while; a public repository
 *   clones without it.
 * - Other hosts: plain git over HTTPS with this computer's own git access (its credential helper);
 *   Cindy has no sign-in to open there, so a refusal says to give this computer access first.
 * - Until the repository is fetched the folder is empty: the result says why, and a later need tries again.
 * - A clean checkout is fast-forwarded before a request (`sync`); local changes are never touched.
 */
export type GroupCheckoutResult =
  | { status: 'ready'; dir: string }
  /** `signInOpened`: Cindy's GitHub sign-in was opened on this computer and not finished in time. */
  | { status: 'git-missing' | 'sign-in-required' | 'unavailable'; signInOpened?: boolean }
  /** Another git host refused or could not be reached with this computer's own git access. */
  | { status: 'access-required' };
export interface GitResult { exitCode: number; stdout: string; stderr: string }
export interface GroupCheckoutDeps {
  /** This account's root for managed checkouts (`<owner data>/projects`). */
  root: () => string;
  /** Runs git; resolves with any exit code, rejects only when git cannot run. Prompts are disabled. */
  git: (args: string[], options: { cwd?: string; timeoutMs: number }) => Promise<GitResult>;
  /** git is installed (on macOS without starting Apple's installer stub). */
  gitAvailable: () => Promise<boolean>;
  /** The gh binary behind Cindy's working GitHub sign-in on this computer, else null. */
  githubHelper: () => Promise<string | null>;
  /** Opens Cindy's own GitHub sign-in in an app window; false when none can show it. */
  openSignIn: () => boolean;
  /** True once GitHub is signed in; false after `timeoutMs` or once `isCurrent` turns false. */
  waitForSignIn: (timeoutMs: number, isCurrent: () => boolean) => Promise<boolean>;
  /** Registers the folder as an ordinary project (idempotent). */
  register: (dir: string) => Promise<void>;
  fs: {
    exists: (target: string) => Promise<boolean>;
    readdir: (target: string) => Promise<string[]>;
    mkdir: (target: string) => Promise<void>;
    rename: (from: string, to: string) => Promise<void>;
    rm: (target: string) => Promise<void>;
  };
  log?: { warn: (message: string, meta?: Record<string, unknown>) => void };
  now?: () => number;
}

const CLONE_TIMEOUT_MS = 10 * 60_000;
const PULL_TIMEOUT_MS = 60_000;
const SIGN_IN_WAIT_MS = 3 * 60_000;
/** A busy group shares one fetch: a checkout is synced at most this often. */
const SYNC_INTERVAL_MS = 30_000;
const HELPER_KEY = 'credential.https://github.com.helper';

/** `owner/name` of a GitHub remote URL (HTTPS, SSH or scp form), or null for any other remote. */
export function githubRepositoryOfRemote(url: string): string | null {
  const repository = parseGroupRepository(url);
  return repository?.kind === 'github' ? repository.repo : null;
}

/** `owner/name` of a GitHub repository, or null for anything that is not a plain repository name. */
export function parseGithubRepository(repo: string): { owner: string; name: string } | null {
  const match = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})$/.exec(repo.trim());
  if (!match || match[2] === '.' || match[2] === '..' || /\.git$/i.test(match[2]!)) return null;
  return { owner: match[1]!, name: match[2]! };
}

/** gh as git's credential helper; a path git's shell cannot quote safely is not used. */
function helperCommand(gh: string): string | null {
  const binary = process.platform === 'win32' ? gh.replaceAll('\\', '/') : gh;
  return /['\n\r]/.test(binary) ? null : `!'${binary}' auth git-credential`;
}

export function createGroupProjectCheckouts(deps: GroupCheckoutDeps) {
  const inFlight = new Map<string, Promise<GroupCheckoutResult>>();
  const synced = new Map<string, number>();
  const now = deps.now ?? Date.now;
  const git = (args: string[], cwd?: string, timeoutMs = 15_000) => deps.git(args, { ...(cwd ? { cwd } : {}), timeoutMs });

  /** Where Cindy keeps `repository`; null for a path that would leave its folder. */
  function folderOf(repository: GroupRepository): string | null {
    if (repository.kind === 'github') {
      const parsed = parseGithubRepository(repository.repo);
      return parsed ? path.join(deps.root(), 'github', parsed.owner, parsed.name) : null;
    }
    const host = repository.host.replace(/:[0-9]+$/, '').toLowerCase();
    if (host === 'github' || host.startsWith('.')) return null;
    const dir = path.join(deps.root(), host, ...repository.path.split('/'));
    return path.resolve(dir).startsWith(path.resolve(deps.root(), host) + path.sep) ? dir : null;
  }

  function isManaged(dir: string): boolean {
    const root = path.resolve(deps.root());
    return path.resolve(dir).startsWith(root + path.sep);
  }

  /** Only Cindy's sign-in answers for github.com in this checkout (other helpers are reset). */
  async function useSignIn(dir: string, gh: string) {
    const command = helperCommand(gh);
    if (!command) return;
    const current = await git(['config', '--local', '--get-all', HELPER_KEY], dir);
    if (current.exitCode === 0 && current.stdout.split('\n').map(line => line.trim()).includes(command)) return;
    await git(['config', '--local', '--unset-all', HELPER_KEY], dir);
    await git(['config', '--local', '--add', HELPER_KEY, ''], dir);
    await git(['config', '--local', '--add', HELPER_KEY, command], dir);
  }

  /** Moves every entry of `from` into `to` (created when missing); false when `to` gained a clashing entry meanwhile. */
  async function moveInto(from: string, to: string): Promise<boolean> {
    if (!await deps.fs.exists(to)) { await deps.fs.rename(from, to); return true; }
    const present = new Set(await deps.fs.readdir(to));
    const entries = await deps.fs.readdir(from);
    if (entries.some(entry => present.has(entry))) return false;
    for (const entry of entries) await deps.fs.rename(path.join(from, entry), path.join(to, entry));
    await deps.fs.rm(from);
    return true;
  }

  async function ensureOnce(repository: GroupRepository, dir: string, options: { signIn: boolean; isCurrent: () => boolean }): Promise<GroupCheckoutResult> {
    if (!await deps.gitAvailable()) return { status: 'git-missing' };
    const github = repository.kind === 'github';
    if (await deps.fs.exists(path.join(dir, '.git'))) {
      const origin = await git(['remote', 'get-url', 'origin'], dir);
      const head = await git(['rev-parse', '--verify', '-q', 'HEAD'], dir);
      const found = origin.exitCode === 0 ? parseGroupRepository(origin.stdout.trim()) : null;
      // Someone pointed this folder elsewhere, or it holds no version: leave it alone.
      if (head.exitCode !== 0 || !found || groupRepositoryKey(found) !== groupRepositoryKey(repository)) return { status: 'unavailable' };
      const gh = github ? await deps.githubHelper() : null;
      if (gh) await useSignIn(dir, gh);
      if (!options.isCurrent()) throw new Error('OWNER_CHANGED');
      await deps.register(dir);
      return { status: 'ready', dir };
    }
    // Only an empty folder is cloned into; anything else there is not Cindy's to replace.
    if (await deps.fs.exists(dir) && (await deps.fs.readdir(dir)).length) return { status: 'unavailable' };
    let gh = github ? await deps.githubHelper() : null;
    let signInOpened = false;
    if (github && !gh && options.signIn && options.isCurrent()) {
      signInOpened = deps.openSignIn();
      if (signInOpened && await deps.waitForSignIn(SIGN_IN_WAIT_MS, options.isCurrent)) gh = await deps.githubHelper();
    }
    if (!options.isCurrent()) throw new Error('OWNER_CHANGED');
    const command = gh ? helperCommand(gh) : null;
    const parent = path.dirname(dir);
    await deps.fs.mkdir(parent);
    // Cloned beside its place and moved in whole, so the folder is never a half-fetched repository.
    const staging = path.join(parent, `.${path.basename(dir)}.cloning-${randomUUID().slice(0, 8)}`);
    const cloned = await git([...(command ? ['-c', `${HELPER_KEY}=`, '-c', `${HELPER_KEY}=${command}`] : []),
      'clone', '--depth', '1', '--no-tags', '--quiet', groupRepositoryCloneUrl(repository), staging], undefined, CLONE_TIMEOUT_MS);
    if (cloned.exitCode !== 0) {
      deps.log?.warn('Group project clone failed', { host: github ? 'github.com' : repository.host, signedIn: !!gh, exitCode: cloned.exitCode });
      await deps.fs.rm(staging);
      if (!github) return { status: 'access-required' };
      return gh ? { status: 'unavailable' } : { status: 'sign-in-required', ...(signInOpened ? { signInOpened } : {}) };
    }
    // The folder already holds the group's task: its contents move in, the folder itself stays.
    if (!await moveInto(staging, dir)) {
      await deps.fs.rm(staging);
      return { status: 'unavailable' };
    }
    if (gh) await useSignIn(dir, gh);
    // The account may have changed during the clone: the folder is that account's, never registered for another.
    if (!options.isCurrent()) throw new Error('OWNER_CHANGED');
    await deps.register(dir);
    return { status: 'ready', dir };
  }

  return {
    isManaged,
    /** Where Cindy keeps its checkout of `repository` on this computer; null for one it cannot keep. */
    dirOf(repository: GroupRepository): string | null {
      return folderOf(repository);
    },
    /**
     * The checkout of `repository`, cloned on first need. `signIn`: open Cindy's GitHub sign-in and
     * wait briefly when not signed in (the requester's own request on their computer; GitHub only).
     * Null for a repository Cindy cannot keep.
     */
    ensure(repository: GroupRepository, options: { signIn: boolean; isCurrent: () => boolean }): Promise<GroupCheckoutResult> | null {
      const dir = folderOf(repository);
      if (!dir) return null;
      const key = dir.toLowerCase();
      const existing = inFlight.get(key);
      if (existing) return existing;
      const pending = ensureOnce(repository, dir, options)
        .finally(() => { if (inFlight.get(key) === pending) inFlight.delete(key); });
      inFlight.set(key, pending);
      return pending;
    },
    /**
     * Brings a clean checkout of Cindy's up to date before a request (fast-forward only). Local
     * changes, a branch without upstream or any failure leave it as it is.
     */
    async sync(dir: string): Promise<void> {
      if (!isManaged(dir)) return;
      const key = path.resolve(dir).toLowerCase();
      if (now() - (synced.get(key) ?? -Infinity) < SYNC_INTERVAL_MS) return;
      synced.set(key, now());
      try {
        const status = await git(['status', '--porcelain'], dir);
        if (status.exitCode !== 0 || status.stdout.trim()) return;
        const upstream = await git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], dir);
        if (upstream.exitCode !== 0) return;
        const pulled = await git(['pull', '--ff-only', '--no-rebase', '--quiet'], dir, PULL_TIMEOUT_MS);
        if (pulled.exitCode !== 0) deps.log?.warn('Group project checkout was not brought up to date', { exitCode: pulled.exitCode });
      } catch (error) {
        deps.log?.warn('Group project checkout was not brought up to date', { error: error instanceof Error ? error.name : 'Error' });
      }
    },
  };
}
export type GroupProjectCheckouts = ReturnType<typeof createGroupProjectCheckouts>;
