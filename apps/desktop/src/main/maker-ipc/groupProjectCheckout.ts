import path from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * Cindy's own checkout of a group's GitHub repository (bot-group-chat.md §7.5). A group with a
 * repository works in that repository: when no project registered on this computer is it, Cindy
 * keeps one copy per repository at `<root>/<owner>/<name>` (shared by every group with that
 * repository) and registers it as an ordinary project named after the repository.
 *
 * - The first need clones it lightly (latest version only) before the task starts, so the
 *   repository's own rules and Skills are on disk when the harness loads the project.
 * - Clone, pull and push use Cindy's GitHub sign-in on this computer (`gh auth git-credential`, set
 *   in the checkout's own git config; no credential is written anywhere). Not signed in: Cindy may
 *   open its own GitHub sign-in and wait a short while; a public repository clones without it.
 * - Until the repository is fetched there is no folder: the result says why, and a later need tries again.
 * - A clean checkout is fast-forwarded before a request (`sync`); local changes are never touched.
 */
export type GroupCheckoutResult =
  | { status: 'ready'; dir: string }
  /** `signInOpened`: Cindy's GitHub sign-in was opened on this computer and not finished in time. */
  | { status: 'git-missing' | 'sign-in-required' | 'unavailable'; signInOpened?: boolean };
export interface GitResult { exitCode: number; stdout: string; stderr: string }
export interface GroupCheckoutDeps {
  /** This account's root for managed checkouts (`<owner data>/projects/github`). */
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
  const match = /^(?:https?:\/\/(?:[^@/\s]+@)?github\.com\/|ssh:\/\/git@github\.com(?::\d+)?\/|git@github\.com:)([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/i
    .exec(url.trim());
  return match ? match[1]! : null;
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

  async function ensureOnce(repo: string, dir: string, options: { signIn: boolean; isCurrent: () => boolean }): Promise<GroupCheckoutResult> {
    if (!await deps.gitAvailable()) return { status: 'git-missing' };
    if (await deps.fs.exists(path.join(dir, '.git'))) {
      const origin = await git(['remote', 'get-url', 'origin'], dir);
      const head = await git(['rev-parse', '--verify', '-q', 'HEAD'], dir);
      // Someone pointed this folder elsewhere, or it holds no version: leave it alone.
      if (origin.exitCode !== 0 || head.exitCode !== 0
        || githubRepositoryOfRemote(origin.stdout.trim())?.toLowerCase() !== repo.toLowerCase()) return { status: 'unavailable' };
      const gh = await deps.githubHelper();
      if (gh) await useSignIn(dir, gh);
      if (!options.isCurrent()) throw new Error('OWNER_CHANGED');
      await deps.register(dir);
      return { status: 'ready', dir };
    }
    // Only an empty folder is cloned into; anything else there is not Cindy's to replace.
    if (await deps.fs.exists(dir) && (await deps.fs.readdir(dir)).length) return { status: 'unavailable' };
    let gh = await deps.githubHelper();
    let signInOpened = false;
    if (!gh && options.signIn && options.isCurrent()) {
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
      'clone', '--depth', '1', '--no-tags', '--quiet', `https://github.com/${repo}.git`, staging], undefined, CLONE_TIMEOUT_MS);
    if (cloned.exitCode !== 0) {
      deps.log?.warn('Group project clone failed', { signedIn: !!gh, exitCode: cloned.exitCode });
      await deps.fs.rm(staging);
      return gh ? { status: 'unavailable' } : { status: 'sign-in-required', ...(signInOpened ? { signInOpened } : {}) };
    }
    await deps.fs.rm(dir);
    await deps.fs.rename(staging, dir);
    if (gh) await useSignIn(dir, gh);
    // The account may have changed during the clone: the folder is that account's, never registered for another.
    if (!options.isCurrent()) throw new Error('OWNER_CHANGED');
    await deps.register(dir);
    return { status: 'ready', dir };
  }

  return {
    isManaged,
    /**
     * The checkout of `repo`, cloned on first need. `signIn`: open Cindy's GitHub sign-in and wait
     * briefly when not signed in (the requester's own request on their computer). Null for a
     * repository name that is not plain `owner/name`.
     */
    ensure(repo: string, options: { signIn: boolean; isCurrent: () => boolean }): Promise<GroupCheckoutResult> | null {
      const parsed = parseGithubRepository(repo);
      if (!parsed) return null;
      const dir = path.join(deps.root(), parsed.owner, parsed.name);
      const key = dir.toLowerCase();
      const existing = inFlight.get(key);
      if (existing) return existing;
      const pending = ensureOnce(`${parsed.owner}/${parsed.name}`, dir, options)
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
