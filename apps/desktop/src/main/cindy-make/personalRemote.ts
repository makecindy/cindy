import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type {
  CindyMakePersonalRemoteState,
  CindyMakeRemoteError,
  CindyMakeRemoteStep,
  CindyMakeRemoteSync,
} from '../../shared/cindyMakePersonalRemote.js';
import {
  CINDY_MAKE_REMOTE_ERRORS,
  CINDY_MAKE_REMOTE_SYNC,
  isGithubLogin,
  isGithubRepository,
  sameGithubLogin,
} from '../../shared/cindyMakePersonalRemote.js';
import { assertNoGitOperation, commitPersonalFiles } from './localHistory.js';
import { PERSONAL_UPSTREAM_REF, type ContentGit } from './sourceContent.js';
import { CINDY_PERSONAL_BRANCH } from './sourcePaths.js';

export const OFFICIAL_GITHUB_REPOSITORY = 'makecindy/cindy';
/** Remote name for the user's fork; `origin` keeps pointing at the official repository. */
export const PERSONAL_REMOTE_NAME = 'personal';
const BRANCH_REF = `refs/heads/${CINDY_PERSONAL_BRANCH}`;
/** The fork's personal version as last fetched by a sync. */
export const PERSONAL_TRACKING_REF = `refs/remotes/${PERSONAL_REMOTE_NAME}/${CINDY_PERSONAL_BRANCH}`;
const TRACKING_REF = PERSONAL_TRACKING_REF;
/** The official commit the shared personal version is based on, published next to it. */
export const PERSONAL_BASE_BRANCH = `${CINDY_PERSONAL_BRANCH}-base`;
const BASE_BRANCH_REF = `refs/heads/${PERSONAL_BASE_BRANCH}`;
const BASE_TRACKING_REF = `refs/remotes/${PERSONAL_REMOTE_NAME}/${PERSONAL_BASE_BRANCH}`;
const COMMIT = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;
/** Same identity as `MAKE_GIT_IDENTITY`, for commits written through the environment. */
const MAKE_IDENTITY = { name: 'Cindy Make', email: 'cindy-make@localhost.invalid' };
const FORK_WAIT_MS = 5 * 60_000;
const API = 'https://api.github.com';

type RemoteRunKind = NonNullable<CindyMakePersonalRemoteState['running']>;

/**
 * Persisted binding. It lives beside the managed checkout rather than inside it,
 * so clearing the source keeps the user's decision and bound repository.
 */
export interface PersonalRewrite {
  /** This computer's version before the rewrite, then any GitHub version combined into it. */
  from: string[];
  to: string;
}
const MAX_REWRITES = 16;
/**
 * Unverified sources are kept until a generated personal version covers them —
 * never dropped for age, or a flood of candidates could evict a live one and
 * make the trust check fail open. The bound only rejects a damaged local file.
 */
const MAX_UNVERIFIED_REMOTE = 512;

export interface PersonalRemoteRecord {
  schema: 1;
  choice?: 'github' | 'local';
  login?: string;
  repository?: string;
  confirmedAt?: number;
  sync?: CindyMakeRemoteSync;
  syncedAt?: number;
  /** Local commit this computer last confirmed on the fork; it may replace only its own upload. */
  syncedCommit?: string;
  /**
   * Adopted history rewrites (official updates and combines), oldest first: every
   * commit in `from` is contained in `to`. They prove an upload that replaces the
   * fork's version loses nothing even when the rewrite changed patches.
   */
  rewrites?: PersonalRewrite[];
  /**
   * Fork tips this computer took over before generating a personal version that
   * covers them. Their content is not verified yet: the automatic task install
   * must not run lifecycle scripts on worktrees that contain them.
   */
  unverifiedRemote?: string[];
  error?: CindyMakeRemoteError;
  /** Present only while an operation runs; a restart turns it into `interrupted`. */
  running?: RemoteRunKind;
}

const isTimestamp = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const oneOf = <T extends string>(values: readonly T[], value: unknown): value is T =>
  typeof value === 'string' && (values as readonly string[]).includes(value);

/** Unknown or corrupt content falls back to "never decided"; it never invents a binding. */
export function parsePersonalRemoteRecord(raw: string | null): PersonalRemoteRecord {
  if (raw === null) return { schema: 1 };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { schema: 1 };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { schema: 1 };
  const input = value as Record<string, unknown>;
  if (input.schema !== 1) return { schema: 1 };
  const record: PersonalRemoteRecord = { schema: 1 };
  if (input.choice === 'github' || input.choice === 'local') record.choice = input.choice;
  if (
    isGithubLogin(input.login) &&
    isGithubRepository(input.repository) &&
    sameGithubLogin(input.login, input.repository.split('/')[0])
  ) {
    record.login = input.login;
    record.repository = input.repository;
    if (isTimestamp(input.confirmedAt)) record.confirmedAt = input.confirmedAt;
    if (oneOf(CINDY_MAKE_REMOTE_SYNC, input.sync)) record.sync = input.sync;
    if (isTimestamp(input.syncedAt)) record.syncedAt = input.syncedAt;
    if (typeof input.syncedCommit === 'string' && COMMIT.test(input.syncedCommit))
      record.syncedCommit = input.syncedCommit;
  }
  if (Array.isArray(input.unverifiedRemote)) {
    const tips = input.unverifiedRemote.filter(
      (tip): tip is string => typeof tip === 'string' && COMMIT.test(tip),
    );
    if (tips.length) record.unverifiedRemote = [...new Set(tips)].slice(-MAX_UNVERIFIED_REMOTE);
  }
  // Rewrite lineage is provenance of already-taken-over content, not binding
  // state: it survives a disconnect (where `login`/`repository` are cleared) or
  // it would silently orphan the unverified tips it carries.
  if (Array.isArray(input.rewrites)) {
    const rewrites = input.rewrites.filter(
      (entry): entry is PersonalRewrite =>
        !!entry &&
        typeof entry === 'object' &&
        Array.isArray((entry as PersonalRewrite).from) &&
        (entry as PersonalRewrite).from.length > 0 &&
        (entry as PersonalRewrite).from.length <= 2 &&
        (entry as PersonalRewrite).from.every(
          (commit) => typeof commit === 'string' && COMMIT.test(commit),
        ) &&
        typeof (entry as PersonalRewrite).to === 'string' &&
        COMMIT.test((entry as PersonalRewrite).to),
    );
    if (rewrites.length) record.rewrites = rewrites.slice(-MAX_REWRITES);
  }
  if (oneOf(CINDY_MAKE_REMOTE_ERRORS, input.error)) record.error = input.error;
  if (input.running === 'save' || input.running === 'sync' || input.running === 'disconnect')
    record.running = input.running;
  return record;
}

/**
 * The content-trust facts of a record file, for the install decision. A missing
 * file proves there is nothing to carry; corrupt content or an unknown schema
 * proves nothing and must never read as "no unverified content" — it throws so
 * the install keeps its guarded path (anything unclear counts as unverified).
 */
export function parsePersonalRemoteTrust(
  raw: string | null,
): Pick<PersonalRemoteRecord, 'unverifiedRemote' | 'rewrites'> {
  if (raw === null) return {};
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('unprovable content trust');
  }
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (value as { schema?: unknown }).schema !== 1
  )
    throw new Error('unprovable content trust');
  const record = parsePersonalRemoteRecord(raw);
  // A malformed trust field proves nothing either: the entries a lenient parse
  // drops could be the very sources still on disk, so silence must never read as
  // "no unverified content".
  const input = value as Record<string, unknown>;
  const rawTips = input.unverifiedRemote;
  if (
    rawTips !== undefined &&
    (!Array.isArray(rawTips) ||
      rawTips.length > MAX_UNVERIFIED_REMOTE ||
      rawTips.some((tip) => typeof tip !== 'string' || !COMMIT.test(tip)))
  )
    throw new Error('unprovable content trust');
  const rawRewrites = input.rewrites;
  const wellFormedRewrite = (entry: unknown): boolean => {
    const rewrite = entry as { from?: unknown; to?: unknown } | null;
    return (
      !!rewrite &&
      typeof rewrite === 'object' &&
      Array.isArray(rewrite.from) &&
      rewrite.from.length > 0 &&
      rewrite.from.length <= 2 &&
      rewrite.from.every((commit) => typeof commit === 'string' && COMMIT.test(commit)) &&
      typeof rewrite.to === 'string' &&
      COMMIT.test(rewrite.to)
    );
  };
  if (rawRewrites !== undefined && (!Array.isArray(rawRewrites) || !rawRewrites.every(wellFormedRewrite)))
    throw new Error('unprovable content trust');
  return {
    ...(record.unverifiedRemote ? { unverifiedRemote: record.unverifiedRemote } : {}),
    ...(record.rewrites ? { rewrites: record.rewrites } : {}),
  };
}

export class PersonalRemoteError extends Error {
  constructor(readonly code: CindyMakeRemoteError) {
    super(code);
  }
}
const remoteError = (code: CindyMakeRemoteError) => new PersonalRemoteError(code);

/** Map a redacted Git failure to a user-facing reason without keeping its output. */
export function classifyRemoteGitError(error: unknown): CindyMakeRemoteError {
  if (error instanceof PersonalRemoteError) return error.code;
  const failure = error as { code?: unknown; stderr?: unknown } | undefined;
  if (failure?.code === 'cancelled') return 'network';
  if (failure?.code === 'busy' || failure?.code === 'dirty') return 'source';
  const text = typeof failure?.stderr === 'string' ? failure.stderr : '';
  if (/workflow/i.test(text) && /(scope|permission|refusing)/i.test(text)) return 'workflowScope';
  if (
    /(authentication failed|could not read username|terminal prompts disabled|permission to .* denied|invalid username or password|returned error: 40[13])/i.test(
      text,
    )
  )
    return 'github';
  if (
    /(could not resolve host|failed to connect|timed out|connection (?:reset|refused|was reset)|unable to access|network is unreachable|ssl|tls)/i.test(
      text,
    )
  )
    return 'network';
  return 'failed';
}

export interface GithubIdentity {
  login: string;
  token: string;
}
export type GithubIdentityResult =
  { status: 'connected'; identity: GithubIdentity } | { status: 'missing' | 'unavailable' };

const githubHeaders = (token: string): Record<string, string> => ({
  Authorization: `Bearer ${token}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
});

/** The token stays in memory for the caller; it is never part of any returned state. */
export async function readGithubIdentity(deps: {
  readToken(): Promise<string | null>;
  fetch: typeof fetch;
}): Promise<GithubIdentityResult> {
  let token: string | null;
  try {
    token = await deps.readToken();
  } catch {
    return { status: 'unavailable' };
  }
  if (!token) return { status: 'missing' };
  try {
    const response = await deps.fetch(`${API}/user`, {
      headers: githubHeaders(token),
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      // An expired or revoked credential needs a new connection, not a retry.
      return { status: response.status === 401 ? 'missing' : 'unavailable' };
    }
    const data = (await response.json()) as { login?: unknown };
    return isGithubLogin(data.login)
      ? { status: 'connected', identity: { login: data.login, token } }
      : { status: 'unavailable' };
  } catch {
    return { status: 'unavailable' };
  }
}

interface GithubRepositoryInfo {
  full_name?: unknown;
  fork?: unknown;
  owner?: { login?: unknown };
  parent?: { full_name?: unknown };
  source?: { full_name?: unknown };
}

/**
 * Create the user's fork, or receive the existing one: GitHub answers a repeated
 * fork request with the account's current fork, including a renamed one. Only a
 * fork of the official repository owned by the connected login is accepted.
 * When another fork cannot be created any more (422) instead of that repository
 * being returned, the account's existing fork is located and validated exactly
 * as strictly as a creation response.
 */
export async function ensureOfficialFork(
  fetchFn: typeof fetch,
  identity: GithubIdentity,
): Promise<string> {
  const request = async (
    url: string,
    init: RequestInit,
    /** The create request reuses the account's existing fork on 422 instead of failing. */
    tolerate422 = false,
  ): Promise<GithubRepositoryInfo | undefined> => {
    let response: Response;
    try {
      response = await fetchFn(url, {
        ...init,
        headers: { ...githubHeaders(identity.token), ...(init.headers as Record<string, string>) },
        redirect: 'error',
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw remoteError('network');
    }
    if (!response.ok) {
      await response.body?.cancel();
      if ([401, 403, 404].includes(response.status)) throw remoteError('github');
      if (tolerate422 && response.status === 422) return undefined;
      throw remoteError(response.status === 422 ? 'forkConflict' : 'failed');
    }
    try {
      return (await response.json()) as GithubRepositoryInfo;
    } catch {
      throw remoteError('failed');
    }
  };
  /** A read that only proves a credential works: a missing or redirected address is absent. */
  const read = async (url: string): Promise<unknown> => {
    let response: Response;
    try {
      response = await fetchFn(url, {
        method: 'GET',
        headers: githubHeaders(identity.token),
        // A renamed fork answers the saved name with a redirect; it is never
        // followed with the credential. The listing below finds the new name.
        redirect: 'manual',
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw remoteError('network');
    }
    if (!response.ok) {
      await response.body?.cancel();
      if ([401, 403].includes(response.status)) throw remoteError('github');
      return undefined;
    }
    return (await response.json().catch(() => undefined)) as unknown;
  };
  const official = (name: unknown) =>
    typeof name === 'string' && name.toLowerCase() === OFFICIAL_GITHUB_REPOSITORY;
  /** The strict check of a creation response also applies to a located fork. */
  const accepted = (repository: GithubRepositoryInfo): string | undefined => {
    const name = repository.full_name;
    return isGithubRepository(name) &&
      repository.fork === true &&
      sameGithubLogin(name.split('/')[0], identity.login) &&
      sameGithubLogin(
        typeof repository.owner?.login === 'string' ? repository.owner.login : undefined,
        identity.login,
      ) &&
      (official(repository.parent?.full_name) || official(repository.source?.full_name))
      ? name
      : undefined;
  };
  /** The account's own fork of the official repository, wherever it was renamed to. */
  const existingFork = async (): Promise<GithubRepositoryInfo> => {
    const canonical = await read(`${API}/repos/${identity.login}/cindy`);
    if (canonical && accepted(canonical as GithubRepositoryInfo))
      return canonical as GithubRepositoryInfo;
    // Follow the pages to the end: a fork outside the first screens must still be
    // found, because the create endpoint cannot make a second one.
    for (let page = 1; ; page += 1) {
      const listed = await read(
        `${API}/user/repos?per_page=100&page=${page}&affiliation=owner&sort=pushed`,
      );
      if (!Array.isArray(listed)) break;
      for (const entry of listed as Array<{ full_name?: unknown; fork?: unknown }>) {
        if (entry?.fork !== true || !isGithubRepository(entry.full_name)) continue;
        const full = await read(`${API}/repos/${entry.full_name}`);
        if (full && accepted(full as GithubRepositoryInfo)) return full as GithubRepositoryInfo;
      }
      if ((listed as unknown[]).length < 100) break;
    }
    throw remoteError('forkConflict');
  };
  let repository = await request(
    `${API}/repos/${OFFICIAL_GITHUB_REPOSITORY}/forks`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ default_branch_only: true }),
    },
    true,
  );
  if (!repository) repository = await existingFork();
  else if (
    isGithubRepository(repository.full_name) &&
    repository.parent === undefined &&
    repository.source === undefined
  )
    repository = await request(`${API}/repos/${repository.full_name}`, { method: 'GET' });
  const name = repository ? accepted(repository) : undefined;
  if (!name) throw remoteError('forkConflict');
  return name;
}

/**
 * The history rewrite an adopted official update or combine made: this computer's
 * version (and the GitHub version combined into it) became `to`. It is the lineage
 * that lets an upload replace the fork's version without losing a change.
 */
export function adoptedRewrite(state: {
  status: string;
  feature?: unknown;
  baselineCommit?: string;
  commit?: string;
  remote?: { commit?: string };
}): PersonalRewrite | undefined {
  if (state.status !== 'merged' || state.feature || !state.baselineCommit || !state.commit)
    return undefined;
  return {
    from: [
      state.baselineCommit,
      ...(state.remote?.commit && state.remote.commit !== state.baselineCommit
        ? [state.remote.commit]
        : []),
    ],
    to: state.commit,
  };
}

export interface PersonalForkHealth {
  /** The repository's current name; GitHub keeps serving Git under an old one after a rename. */
  repository: string;
  archived: boolean;
  canPush: boolean;
}

/**
 * The bound repository as GitHub sees it now. A renamed repository is followed through
 * GitHub's redirect to its id (once, on the API host); the caller accepts the new name
 * only under the same account. A deleted one is reported, never recreated.
 */
export async function inspectPersonalFork(
  fetchFn: typeof fetch,
  identity: GithubIdentity,
  repository: string,
  followRename = true,
): Promise<PersonalForkHealth> {
  let response: Response;
  try {
    // `repository` is `<owner>/<name>`, or the by-id address GitHub redirected to.
    response = await fetchFn(followRename ? `${API}/repos/${repository}` : repository, {
      headers: githubHeaders(identity.token),
      // A renamed repository answers with a redirect; it is never followed with the credential.
      redirect: 'manual',
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw remoteError('network');
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    // Renamed or transferred: GitHub points at the repository by id on its own API host.
    const location = response.headers.get('location') ?? '';
    const moved = /^https:\/\/api\.github\.com\/repositories\/\d{1,20}$/.test(location);
    if (moved && followRename) return inspectPersonalFork(fetchFn, identity, location, false);
    if (response.status === 404 || (response.status >= 300 && response.status < 400))
      throw remoteError('forkMissing');
    throw remoteError([401, 403].includes(response.status) ? 'github' : 'failed');
  }
  let info: {
    full_name?: unknown;
    archived?: unknown;
    fork?: unknown;
    owner?: { login?: unknown };
    parent?: { full_name?: unknown };
    source?: { full_name?: unknown };
    permissions?: { push?: unknown };
  };
  try {
    info = (await response.json()) as typeof info;
  } catch {
    throw remoteError('failed');
  }
  if (!isGithubRepository(info.full_name)) throw remoteError('failed');
  // The saved name must still be this account's fork of the official repository:
  // after the fork was deleted, an unrelated repository can answer under the same
  // name, and the managed branches must never be pushed into it. A stale binding
  // is reported (like a deleted one), never used.
  const official = (name: unknown) =>
    typeof name === 'string' && name.toLowerCase() === OFFICIAL_GITHUB_REPOSITORY;
  if (
    info.fork !== true ||
    !sameGithubLogin(
      typeof info.owner?.login === 'string' ? info.owner.login : undefined,
      identity.login,
    ) ||
    !(official(info.parent?.full_name) || official(info.source?.full_name))
  )
    throw remoteError('forkMissing');
  return {
    repository: info.full_name,
    archived: info.archived === true,
    canPush: info.permissions?.push !== false,
  };
}

/**
 * Read-only probe before consent: does the account's usual fork already hold a
 * personal version (another computer saved it)? A renamed fork is found later by
 * the fork request itself; this only adjusts what the consent card says.
 */
export async function findPersonalFork(
  fetchFn: typeof fetch,
  identity: GithubIdentity,
): Promise<string | undefined> {
  const read = async (url: string): Promise<Response | undefined> => {
    try {
      return await fetchFn(url, {
        headers: githubHeaders(identity.token),
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      return undefined;
    }
  };
  const repository = `${identity.login}/cindy`;
  if (!isGithubRepository(repository)) return undefined;
  const info = await read(`${API}/repos/${repository}`);
  if (!info?.ok) {
    await info?.body?.cancel();
    return undefined;
  }
  const data = (await info.json().catch(() => ({}))) as GithubRepositoryInfo;
  const official = (name: unknown) =>
    typeof name === 'string' && name.toLowerCase() === OFFICIAL_GITHUB_REPOSITORY;
  if (
    data.fork !== true ||
    !isGithubRepository(data.full_name) ||
    !(official(data.parent?.full_name) || official(data.source?.full_name))
  )
    return undefined;
  const branch = await read(`${API}/repos/${data.full_name}/branches/${CINDY_PERSONAL_BRANCH}`);
  await branch?.body?.cancel();
  return branch?.ok ? data.full_name : undefined;
}

export function githubRepositoryUrl(repository: string): string {
  if (!isGithubRepository(repository)) throw remoteError('failed');
  return `https://github.com/${repository}.git`;
}

/**
 * Credentials for one Git child process. The header is scoped to the exact fork
 * URL through `GIT_CONFIG_*`, so it never appears in argv, `.git/config`, the
 * remote URL, or logs. Credential helpers and askpass prompts are disabled so
 * a rejected token fails instead of opening a system credential dialog, and
 * repository hooks never run with the credential in their environment.
 */
export function githubAuthEnv(
  repository: string,
  token: string,
  base: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const existing = Number.parseInt(base.GIT_CONFIG_COUNT ?? '', 10);
  const start = Number.isSafeInteger(existing) && existing > 0 ? existing : 0;
  const entries: Array<[string, string]> = [
    [
      `http.${githubRepositoryUrl(repository)}.extraheader`,
      `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
    ],
    ['credential.helper', ''],
    ['credential.https://github.com.helper', ''],
    // Repository hooks and fsmonitor programs must not run with the credential in their environment.
    ['core.hooksPath', os.devNull],
    ['core.fsmonitor', 'false'],
  ];
  const env: NodeJS.ProcessEnv = {
    ...base,
    GIT_ASKPASS: '',
    SSH_ASKPASS: '',
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: String(start + entries.length),
  };
  entries.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${start + index}`] = key;
    env[`GIT_CONFIG_VALUE_${start + index}`] = value;
  });
  return env;
}

/** A commit identity applied through the environment, which outranks any Git configuration. */
export interface GitCommitIdentity {
  name: string;
  email: string;
  /** Git internal date format (`<unix seconds> <+hhmm>`); omitted means now. */
  date?: string;
}

export interface PersonalRemoteGitOptions {
  auth?: { repository: string; token: string };
  indexFile?: string;
  identity?: GitCommitIdentity;
}

/** Process environment for one Git command run on behalf of the personal version. */
export function personalGitEnv(
  base: NodeJS.ProcessEnv,
  options?: PersonalRemoteGitOptions,
): NodeJS.ProcessEnv {
  let env: NodeJS.ProcessEnv = options?.indexFile
    ? { ...base, GIT_INDEX_FILE: options.indexFile }
    : base;
  if (options?.identity) {
    const { name, email, date } = options.identity;
    env = {
      ...env,
      GIT_AUTHOR_NAME: name,
      GIT_AUTHOR_EMAIL: email,
      GIT_COMMITTER_NAME: name,
      GIT_COMMITTER_EMAIL: email,
    };
    if (date) env.GIT_AUTHOR_DATE = date;
    else delete env.GIT_AUTHOR_DATE;
    delete env.GIT_COMMITTER_DATE;
  }
  return options?.auth ? githubAuthEnv(options.auth.repository, options.auth.token, env) : env;
}

export interface PersonalRemoteDeps {
  /** The managed checkout that owns `cindy-personal`. */
  source: string;
  read(): PersonalRemoteRecord;
  write(record: PersonalRemoteRecord): void;
  identity(): Promise<GithubIdentityResult>;
  ensureFork(identity: GithubIdentity): Promise<string>;
  /** The account's official fork that already holds a personal version, if any. */
  findPersonalFork(identity: GithubIdentity): Promise<string | undefined>;
  /** The bound repository as GitHub sees it now (see `inspectPersonalFork`). */
  inspectFork?(identity: GithubIdentity, repository: string): Promise<PersonalForkHealth>;
  git(args: string[], cwd: string, options?: PersonalRemoteGitOptions): Promise<string>;
  sourceExists(): boolean;
  /** Serialize with every other Git write to the managed source. */
  withProject<T>(run: () => Promise<T>): Promise<T>;
  /** Keep the checkout from being cleared for the whole operation, including network phases. */
  withSourceUse<T>(run: () => Promise<T>): Promise<T>;
  /** True while the commit carries integrations a failed generation could still undo. */
  hasUnbuiltChanges(commit: string, tree: string): Promise<boolean>;
  /** A generated personal version was built from this commit. */
  isBuilt(commit: string): boolean;
  /** No generation, unresolved official update or manual source sync owns `cindy-personal`. */
  /** `withinSync`: Sync holds the source reservation itself, which does not count as busy. */
  sourceSettled(withinSync: boolean): boolean;
  /** The official commit the local personal version is based on, as shown in Settings. */
  officialBase(): Promise<string | undefined>;
  /** `cindy-personal` changed; refresh the Settings source summary. */
  sourceChanged(): void;
  publish(state: CindyMakePersonalRemoteState): void;
  sleep(ms: number): Promise<void>;
  now(): number;
  log?: { info(message: string, meta?: object): void; warn(message: string, meta?: object): void };
}

type UploadDecision =
  | { local: string; sync: CindyMakeRemoteSync }
  | { local: string; push: true; replace?: boolean; base?: string }
  | { local: string; adopt: true; base: string }
  /** This computer's own changes replayed on top of the fork's version (`local` is the result). */
  | { local: string; push: true; merged: { previous: string; base: string }; base: string };

/**
 * Main-owned binding between the local personal version and the user's GitHub fork.
 *
 * Only established content is uploaded: the fork either receives the exact local
 * `cindy-personal` commit (never a commit that a failed generation could still
 * undo) or nothing. Every upload uses explicit refspecs with leases, so content
 * pushed by another computer is never overwritten. A newer version on GitHub is
 * retrieved only when every local change is already in it. Network commands run
 * outside the project lock; each decision is taken on a locked snapshot.
 * Operations run in the background; nothing is replayed after a restart.
 */
export class PersonalRemoteController {
  private identityResult: GithubIdentityResult | undefined;
  private sourceAvailable = false;
  /** Local `cindy-personal` tip at the last refresh, to show content still awaiting upload. */
  private localTip: string | undefined;
  /** Repository of an existing personal version on the account, shown before binding. */
  private existingPersonal: string | undefined;
  private gitChecked = false;
  /** The current run belongs to Sync, which reserved the source itself. */
  private withinSync = false;
  /** `merge-tree --merge-base` (Git 2.40) replays changes without a checkout. */
  private canReplay = false;
  private lastAutomaticSync = 0;
  private runningKind: RemoteRunKind | undefined;
  private step: CindyMakeRemoteStep | undefined;
  private current: Promise<void> | undefined;

  constructor(private readonly deps: PersonalRemoteDeps) {
    try {
      const record = deps.read();
      if (record.running) {
        const { running: _interrupted, ...rest } = record;
        deps.write({ ...rest, error: 'interrupted' });
      }
    } catch (error) {
      deps.log?.warn('cindy-make personal remote record unavailable', {
        code: (error as { code?: unknown })?.code,
      });
    }
  }

  /** Settles the operation started by the most recent action, if any. */
  settled(): Promise<void> {
    return this.current ?? Promise.resolve();
  }

  state(): CindyMakePersonalRemoteState {
    const record = this.deps.read();
    const identity = this.identityResult;
    const githubLogin = identity?.status === 'connected' ? identity.identity.login : undefined;
    const accountMismatch =
      !!record.repository && !!githubLogin && !sameGithubLogin(record.login, githubLogin);
    const error = accountMismatch && !this.runningKind ? 'account' : record.error;
    // New local content (a generation or an official update) that has not been uploaded yet.
    const stale =
      record.sync === 'synced' &&
      !!record.syncedCommit &&
      !!this.localTip &&
      this.localTip !== record.syncedCommit;
    return {
      ...(record.choice ? { choice: record.choice } : {}),
      ...(record.repository ? { repository: record.repository, login: record.login } : {}),
      github: identity?.status ?? 'unavailable',
      ...(githubLogin ? { githubLogin } : {}),
      ...(this.runningKind ? { running: this.runningKind, step: this.step } : {}),
      ...(record.repository && record.sync ? { sync: stale ? 'pending' : record.sync } : {}),
      ...(error && !this.runningKind ? { error } : {}),
      ...(record.repository && record.syncedAt ? { syncedAt: record.syncedAt } : {}),
      ...(!record.repository && this.existingPersonal
        ? { existingPersonal: this.existingPersonal }
        : {}),
      sourceReady: this.sourceAvailable,
      // Until a repository is bound, the offer stays: only an explicit local-only choice collapses it.
      offerMigration:
        !!githubLogin && !record.repository && record.choice !== 'local' && !this.runningKind,
    };
  }

  /** Re-read the GitHub connection and local source; cheap enough per Settings visit. */
  async refresh(): Promise<CindyMakePersonalRemoteState> {
    const [identity, tip] = await Promise.all([this.deps.identity(), this.readLocalTip()]);
    this.identityResult = identity;
    this.localTip = tip;
    this.sourceAvailable = !!tip;
    // Reconnecting, or switching back to the bound login, resolves these without another upload.
    const record = this.deps.read();
    if (
      !this.runningKind &&
      identity.status === 'connected' &&
      (record.error === 'github' ||
        (record.error === 'account' && sameGithubLogin(record.login, identity.identity.login)))
    ) {
      const { error: _resolved, ...rest } = record;
      this.deps.write(rest);
    }
    if (identity.status === 'connected' && !record.repository) {
      try {
        this.existingPersonal = await this.deps.findPersonalFork(identity.identity);
      } catch {
        this.existingPersonal = undefined;
      }
    } else this.existingPersonal = undefined;
    const state = this.publish();
    // A Settings visit also picks up changes another computer uploaded; at most once a minute.
    if (
      identity.status === 'connected' &&
      record.repository &&
      record.choice === 'github' &&
      !this.runningKind &&
      this.deps.now() - this.lastAutomaticSync >= 60_000
    ) {
      this.lastAutomaticSync = this.deps.now();
      return this.sync();
    }
    return state;
  }

  async status(): Promise<CindyMakePersonalRemoteState> {
    return this.identityResult ? this.state() : this.refresh();
  }

  /** The user's one-time consent: create or reuse the fork, bind it and synchronize. */
  save(): CindyMakePersonalRemoteState {
    if (this.runningKind) return this.state();
    return this.start('save', async (setStep) => {
      const identity = await this.requireIdentity();
      const record = this.deps.read();
      if (record.repository && !sameGithubLogin(record.login, identity.login))
        throw remoteError('account');
      if (!(await this.readLocalTip())) throw remoteError('source');
      await this.requireGitVersion();
      await this.deps.withProject(async () => {
        setStep('preparing');
        await this.normalizeSource();
      });
      setStep('fork');
      const repository = await this.deps.ensureFork(identity);
      await this.waitForFork(repository, identity);
      this.update({
        choice: 'github',
        login: identity.login,
        repository,
        confirmedAt: this.deps.now(),
      });
      this.existingPersonal = undefined;
      this.deps.log?.info('cindy-make personal remote bound', { step: 'bound' });
      await this.upload(repository, identity, setStep);
    });
  }

  /** Explicit retry for a bound repository ("立即同步"); also retrieves newer GitHub content. */
  sync(): CindyMakePersonalRemoteState {
    if (this.runningKind) return this.state();
    const record = this.deps.read();
    if (!record.repository) throw remoteError('source');
    const repository = record.repository;
    return this.start('sync', async (setStep) => {
      const identity = await this.requireIdentity();
      if (!sameGithubLogin(record.login, identity.login)) throw remoteError('account');
      if (!(await this.readLocalTip())) throw remoteError('source');
      await this.requireGitVersion();
      await this.upload(repository, identity, setStep);
    });
  }

  /**
   * After a generation finishes or an official update is adopted. The upload rules
   * decide whether anything is established enough to share; unbound users are untouched.
   */
  autoSync(): void {
    const record = this.deps.read();
    if (this.runningKind || !record.repository || record.choice !== 'github') return;
    this.sync();
  }

  /**
   * Before a new task branches from `cindy-personal`, so it starts from changes made on
   * other computers too. Failures never block the task; the Settings row reports them.
   */
  async syncBeforeTask(timeoutMs = 120_000): Promise<void> {
    const record = this.deps.read();
    if (!record.repository || record.choice !== 'github') return;
    // One budget covers the whole wait: an operation already running is awaited
    // within it too, so a new task never stalls here longer than `timeoutMs`
    // even when an earlier sync waits for fork readiness or network.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const budget = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    });
    try {
      await Promise.race([this.settled(), budget]);
      if (!this.runningKind) this.sync();
      await Promise.race([this.settled(), budget]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * One sync, awaited; its result for the single Sync pipeline, which holds the source
   * reservation for this run. Errors are thrown as their code.
   */
  async syncNow(): Promise<CindyMakeRemoteSync | undefined> {
    // A run already in progress started before this Sync moved the source: let it end,
    // then decide again on the current facts.
    while (this.runningKind) await this.settled();
    this.withinSync = true;
    try {
      this.sync();
      await this.settled();
    } finally {
      this.withinSync = false;
    }
    const record = this.deps.read();
    if (record.error) throw remoteError(record.error);
    return record.sync;
  }

  /** The GitHub version the last fetch saw, with the official base published next to it. */
  async fetchedTips(): Promise<{ commit: string; base: string } | undefined> {
    const commit = await this.readCommit(TRACKING_REF);
    const base = await this.readCommit(BASE_TRACKING_REF);
    return commit && base ? { commit, base } : undefined;
  }

  keepLocal(): CindyMakePersonalRemoteState {
    const record = this.deps.read();
    if (this.runningKind || record.repository) return this.state();
    // Stopping the sharing keeps the content trust facts of what was already taken
    // over, including the rewrite history that carries their provenance.
    this.deps.write({
      schema: 1,
      choice: 'local',
      ...(record.unverifiedRemote ? { unverifiedRemote: record.unverifiedRemote } : {}),
      ...(record.rewrites ? { rewrites: record.rewrites } : {}),
    });
    return this.publish();
  }

  /** Stop synchronizing: remove the local remote only; the fork and local source stay. */
  async disconnect(): Promise<CindyMakePersonalRemoteState> {
    if (this.runningKind) throw Object.assign(new Error('busy'), { code: 'busy' });
    this.start('disconnect', async () => {
      await this.deps.withProject(async () => {
        if (this.deps.sourceExists() && (await this.remoteUrl()) !== undefined)
          await this.git(['remote', 'remove', PERSONAL_REMOTE_NAME]);
      });
      const { unverifiedRemote, rewrites } = this.deps.read();
      this.deps.write({
        schema: 1,
        choice: 'local',
        ...(unverifiedRemote ? { unverifiedRemote } : {}),
        ...(rewrites ? { rewrites } : {}),
      });
    });
    await this.settled();
    return this.state();
  }

  private publish(): CindyMakePersonalRemoteState {
    const state = this.state();
    this.deps.publish(state);
    return state;
  }

  private update(patch: Partial<PersonalRemoteRecord>): void {
    this.deps.write({ ...this.deps.read(), ...patch, schema: 1 });
  }

  private start(
    kind: RemoteRunKind,
    body: (setStep: (step: CindyMakeRemoteStep) => void) => Promise<void>,
  ): CindyMakePersonalRemoteState {
    // Persist the run marker first: if that fails nothing has started.
    const { error: _previous, ...record } = this.deps.read();
    this.deps.write({ ...record, running: kind });
    this.runningKind = kind;
    this.step = 'waiting';
    const setStep = (step: CindyMakeRemoteStep) => {
      this.step = step;
      this.publish();
    };
    this.current = (async () => {
      let failure: CindyMakeRemoteError | undefined;
      try {
        await this.deps.withSourceUse(async () => {
          try {
            await body(setStep);
          } finally {
            // Read the tip while the checkout is still protected from clearing.
            this.localTip = await this.readLocalTip();
          }
        });
      } catch (error) {
        failure = classifyRemoteGitError(error);
        this.deps.log?.warn('cindy-make personal remote failed', {
          operation: kind,
          step: this.step,
          code: failure,
        });
      } finally {
        try {
          const { running: _done, error: _stale, ...rest } = this.deps.read();
          this.deps.write({ ...rest, ...(failure ? { error: failure } : {}) });
        } catch {
          // The in-memory state below must still settle; a restart reports the run as interrupted.
        }
        this.runningKind = undefined;
        this.step = undefined;
        this.publish();
      }
    })();
    return this.publish();
  }

  private async requireIdentity(): Promise<GithubIdentity> {
    this.identityResult = await this.deps.identity();
    if (this.identityResult.status !== 'connected') throw remoteError('github');
    return this.identityResult.identity;
  }

  /**
   * `GIT_CONFIG_COUNT` needs Git 2.31 (older Git silently drops the credential) and the
   * merge comparison needs `--remerge-diff` from Git 2.36.
   */
  private async requireGitVersion(): Promise<void> {
    if (this.gitChecked) return;
    const match = /git version (\d+)\.(\d+)/.exec(await this.git(['--version']));
    const [major, minor] = match ? [Number(match[1]), Number(match[2])] : [0, 0];
    if (major < 2 || (major === 2 && minor < 36)) throw remoteError('gitOutdated');
    this.canReplay = major > 2 || minor >= 40;
    this.gitChecked = true;
  }

  private git(args: string[], options?: PersonalRemoteGitOptions): Promise<string> {
    return this.deps.git(args, this.deps.source, options);
  }

  private async readCommit(ref: string): Promise<string | undefined> {
    try {
      const commit = (
        await this.git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
      ).trim();
      return COMMIT.test(commit) ? commit : undefined;
    } catch {
      return undefined;
    }
  }

  private async readLocalTip(): Promise<string | undefined> {
    if (!this.deps.sourceExists()) return undefined;
    return this.readCommit(BRANCH_REF);
  }

  /** Legacy uncommitted personal files become a local commit before anything is uploaded. */
  private async normalizeSource(): Promise<void> {
    const git: ContentGit = (args, cwd, indexFile) =>
      this.deps.git(args, cwd, indexFile ? { indexFile } : undefined);
    if ((await this.git(['rev-parse', '--abbrev-ref', 'HEAD'])).trim() !== CINDY_PERSONAL_BRANCH)
      throw remoteError('source');
    await assertNoGitOperation(git, this.deps.source);
    if ((await this.git(['status', '--porcelain'])).trim())
      await commitPersonalFiles(git, this.deps.source);
  }

  private async remoteUrl(): Promise<string | undefined> {
    try {
      return (await this.git(['config', '--get', `remote.${PERSONAL_REMOTE_NAME}.url`])).trim();
    } catch (error) {
      if ((error as { exitCode?: number }).exitCode === 1) return undefined;
      throw error;
    }
  }

  private async exitsZero(args: string[]): Promise<boolean> {
    try {
      await this.git(args);
      return true;
    } catch (error) {
      if ((error as { exitCode?: number }).exitCode === 1) return false;
      throw error;
    }
  }

  private isAncestor(ancestor: string, descendant: string): Promise<boolean> {
    return this.exitsZero(['merge-base', '--is-ancestor', ancestor, descendant]);
  }

  /**
   * Every change on `from` also exists in `into` with the same patch. A patch
   * comparison cannot see what a merge commit adds beyond its automatic result, so
   * only merges whose remerge diff is empty (the check used before adopting an
   * official rebase) are accepted; any other merge, or an unreadable one, fails closed.
   */
  private async containsChanges(into: string, from: string): Promise<boolean> {
    const merges = await this.commits(['--merges', `${into}..${from}`]);
    if (!merges) return false;
    for (const merge of merges) {
      try {
        const extra = await this.git([
          'show',
          '--remerge-diff',
          '--no-ext-diff',
          '--no-color',
          '--format=',
          merge,
        ]);
        if (extra.trim()) return false;
      } catch {
        return false;
      }
    }
    // Every commit of `from` that `into` lacks has the same patch there.
    return (
      (
        await this.git(['rev-list', '--count', '--cherry-pick', '--right-only', '--no-merges', `${into}...${from}`])
      ).trim() === '0'
    );
  }

  /** Commit hashes for `rev-list` arguments; undefined when Git output was cut at its capture limit. */
  private async commits(args: string[]): Promise<string[] | undefined> {
    const listed = (await this.git(['rev-list', ...args]))
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => COMMIT.test(line));
    const count = Number((await this.git(['rev-list', '--count', ...args])).trim());
    return Number.isSafeInteger(count) && count === listed.length ? listed : undefined;
  }

  /** The local personal version consists of official commits only (a fresh computer). */
  private async hasNoPersonalCommits(local: string): Promise<boolean> {
    const base = await this.deps.officialBase();
    return !!base && COMMIT.test(base) && (base === local || (await this.isAncestor(local, base)));
  }

  /** The official base to publish next to `local`; omitted when it cannot be proven. */
  private async publishableBase(local: string): Promise<string | undefined> {
    const base = await this.deps.officialBase();
    if (!base || !COMMIT.test(base)) return undefined;
    return (await this.isAncestor(base, local)) ? base : undefined;
  }

  /** GitHub creates forks asynchronously; wait until the repository serves refs. */
  private async waitForFork(repository: string, identity: GithubIdentity): Promise<void> {
    const started = this.deps.now();
    const auth = { repository, token: identity.token };
    for (let attempt = 0; ; attempt += 1) {
      try {
        const refs = await this.git(['ls-remote', '--heads', githubRepositoryUrl(repository)], {
          auth,
        });
        if (/\trefs\/heads\//.test(refs)) return;
      } catch (error) {
        // A brand-new fork answers "not found" until GitHub finishes creating it;
        // keep waiting for that, but a rejected credential will not recover.
        if (classifyRemoteGitError(error) === 'github') throw error;
      }
      if (this.deps.now() - started >= FORK_WAIT_MS) throw remoteError('forkUnavailable');
      await this.deps.sleep(Math.min(2_000 * 2 ** attempt, 10_000));
    }
  }

  /**
   * Both computers added changes on the same official base. Replays this computer's
   * changes the fork does not have yet, oldest first, on top of the fork's version
   * using only Git objects: no checkout, worktree or hook runs, and nothing moves
   * until every change applied cleanly. A conflict, a merge commit that adds edits
   * of its own, or an older Git leaves both sides untouched.
   */
  private async replayOnto(
    local: string,
    remote: string,
    base: string,
  ): Promise<string | undefined> {
    if (!this.canReplay) return undefined;
    const fork = (await this.git(['merge-base', local, remote]).catch(() => '')).trim();
    if (!COMMIT.test(fork) || !(await this.isAncestor(base, fork))) return undefined;
    const merges = await this.commits(['--merges', `${fork}..${local}`]);
    if (!merges) return undefined;
    for (const merge of merges) {
      const extra = await this.git([
        'show',
        '--remerge-diff',
        '--no-ext-diff',
        '--no-color',
        '--format=',
        merge,
      ]).catch(() => undefined);
      if (extra === undefined || extra.trim()) return undefined;
    }
    // Output is size-limited; a truncated list must not silently drop the newest changes.
    const unique = await this.commits(['--cherry-pick', '--right-only', '--no-merges', `${remote}...${local}`]);
    const range = await this.commits(['--reverse', '--topo-order', '--no-merges', `${fork}..${local}`]);
    if (!unique || !range) return undefined;
    const missing = new Set(unique);
    const commits = range.filter((commit) => missing.has(commit));
    let tip = remote;
    let tree = (await this.git(['rev-parse', `${remote}^{tree}`])).trim();
    const temporary = await mkdtemp(path.join(os.tmpdir(), 'cindy-make-replay-'));
    try {
      for (const commit of commits) {
        const parent = (await this.git(['rev-parse', `${commit}^`])).trim();
        let merged: string;
        try {
          merged = (
            await this.git([
              'merge-tree',
              '--write-tree',
              '--no-messages',
              `--merge-base=${parent}`,
              tip,
              commit,
            ])
          )
            .split(/\r?\n/)[0]
            .trim();
        } catch {
          return undefined;
        }
        if (!COMMIT.test(merged)) return undefined;
        if (merged === tree) continue;
        // The raw object, unaffected by log formatting, signature display or user config.
        const object = await this.git(['cat-file', 'commit', commit]);
        const split = object.indexOf('\n\n');
        const headers = split < 0 ? object : object.slice(0, split);
        const author = /^author (.*) <([^<>\n]*)> (\d+ [+-]\d{4})$/m.exec(headers);
        const message = path.join(temporary, 'message');
        const body = split < 0 ? '' : object.slice(split + 2);
        await writeFile(message, body.endsWith('\n') ? body : body + '\n', 'utf8');
        // The replayed change keeps its author and date; an unreadable one falls back to Cindy Make.
        tip = (
          await this.git(
            ['-c', 'commit.gpgSign=false', 'commit-tree', merged, '-p', tip, '-F', message],
            {
              identity:
                author && author[1].trim() && author[2].trim()
                  ? { name: author[1].trim(), email: author[2].trim(), date: author[3] }
                  : MAKE_IDENTITY,
            },
          )
        ).trim();
        if (!COMMIT.test(tip)) return undefined;
        tree = merged;
      }
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
    return tip;
  }

  /** `commit` is contained in `local` through the adopted rewrites (patches may differ). */
  private async carriedByRewrites(commit: string, local: string): Promise<boolean> {
    // Records survive clearing the source; commits that no longer exist prove nothing.
    const contains = async (ancestor: string, descendant: string) => {
      if (ancestor === descendant) return true;
      try {
        return await this.isAncestor(ancestor, descendant);
      } catch {
        return false;
      }
    };
    const carried = [commit];
    for (const rewrite of this.deps.read().rewrites ?? []) {
      let included = false;
      for (const input of rewrite.from) {
        for (const known of carried)
          if (await contains(known, input)) {
            included = true;
            break;
          }
        if (included) break;
      }
      if (included) carried.push(rewrite.to);
    }
    for (const result of carried.slice(1)) if (await contains(result, local)) return true;
    return false;
  }

  /**
   * Remember an adopted history rewrite; called for every completed official update
   * or combine, including one restored at startup. Repeats are ignored.
   */
  recordRewrite(from: string[], to: string): void {
    if (!COMMIT.test(to) || !from.length || from.length > 2 || !from.every((c) => COMMIT.test(c)))
      return;
    const record = this.deps.read();
    const same = (rewrite: PersonalRewrite) =>
      rewrite.to === to &&
      rewrite.from.length === from.length &&
      rewrite.from.every((commit, index) => commit === from[index]);
    // Provenance must survive without a binding: the rewrite history carries the
    // unverified content through official updates even after a disconnect, so it
    // is recorded whenever there is content to carry.
    if (
      (!record.repository && !(record.unverifiedRemote ?? []).length) ||
      (record.rewrites ?? []).some(same)
    )
      return;
    const tips = record.unverifiedRemote ?? [];
    this.update({
      rewrites: [...(record.rewrites ?? []), { from, to }].slice(-MAX_REWRITES),
      // Unverified content this rewrite carried keeps its provenance under the new
      // commit: the tip list follows the content, so evicting old rewrite edges
      // (or dropping them on disconnect) can never orphan it.
      ...(tips.length && !tips.includes(to) ? { unverifiedRemote: [...tips, to] } : {}),
    });
  }

  /**
   * Remember a tip taken over from the fork before this computer verified it:
   * until a generated personal version covers it, the automatic task install
   * must not run lifecycle scripts on worktrees containing it.
   */
  recordUnverifiedRemote(commit: string): void {
    if (!COMMIT.test(commit)) return;
    const record = this.deps.read();
    const known = record.unverifiedRemote ?? [];
    if (known.includes(commit)) return;
    this.update({ unverifiedRemote: [...known, commit] });
  }

  /** Moving the checkout needs an idle, clean source on the personal branch. */
  private async movable(): Promise<boolean> {
    return (
      this.deps.sourceSettled(this.withinSync) &&
      !(await this.git(['status', '--porcelain'])).trim() &&
      (await this.git(['rev-parse', '--abbrev-ref', 'HEAD'])).trim() === CINDY_PERSONAL_BRANCH
    );
  }

  /** Decide on a locked snapshot what to upload, retrieve or only report. */
  private async decide(
    remote: string | undefined,
    remoteBase: string | undefined,
  ): Promise<UploadDecision> {
    const local = await this.readLocalTip();
    if (!local) throw remoteError('source');
    const record = this.deps.read();
    const tree = (await this.git(['rev-parse', `${local}^{tree}`])).trim();
    const established = !(
      (await this.deps.hasUnbuiltChanges(local, tree)) ||
      (await this.exitsZero([
        'show-ref',
        '--verify',
        '--quiet',
        `refs/cindy-make/failed-builds/${local}`,
      ]))
    );
    if (remote === local)
      return {
        local,
        sync: record.sync === 'retrieved' && !this.deps.isBuilt(local) ? 'retrieved' : 'synced',
      };
    /**
     * Take the GitHub version. Only when the source can move now: otherwise the reason
     * is reported as it is (not generated yet, or busy), never as unrelated versions,
     * which would offer replacing the GitHub version.
     */
    const retrieve = async (blocked: CindyMakeRemoteSync): Promise<UploadDecision> => {
      if (!remote) return { local, sync: blocked };
      if (!established) return { local, sync: 'buildFirst' };
      if (!(await this.movable())) return { local, sync: 'pending' };
      // The fork's own base when it publishes one; otherwise this computer's base still applies.
      const candidates = [remoteBase, await this.deps.officialBase()];
      for (const base of candidates)
        if (base && COMMIT.test(base) && (await this.isAncestor(base, remote)))
          return { local, adopt: true, base };
      return { local, sync: blocked };
    };
    if (!remote)
      return established
        ? { local, push: true, base: await this.publishableBase(local) }
        : { local, sync: 'pendingBuild' };
    if (await this.isAncestor(remote, local))
      return established
        ? { local, push: true, base: await this.publishableBase(local) }
        : { local, sync: 'pendingBuild' };
    if (await this.isAncestor(local, remote)) return retrieve('remoteAhead');
    // An official update or a combine rewrote history. Replace the fork's version only
    // when every change in it is proven to be here: it is this computer's own upload with
    // the same patches, or adopted rewrites carried it into this version.
    if (
      (remote === record.syncedCommit && (await this.containsChanges(local, remote))) ||
      (await this.carriedByRewrites(remote, local))
    )
      return established
        ? { local, push: true, replace: true, base: await this.publishableBase(local) }
        : { local, sync: 'pendingBuild' };
    // Another computer uploaded a rewritten or newer version that already has every local
    // change, or this computer has nothing GitHub did not already have (no personal changes
    // of its own, or none since its last sync — another computer then updated that same
    // version, for example resolving an official update once for both): retrieve it.
    if (
      local === record.syncedCommit ||
      (await this.containsChanges(remote, local)) ||
      (await this.hasNoPersonalCommits(local))
    )
      return retrieve('diverged');
    // Both sides have changes of their own. This computer's changes are combined only once
    // they are established (generated) and the source is idle and clean.
    if (!established) return { local, sync: 'buildFirst' };
    if (!(await this.movable())) return { local, sync: 'pending' };
    // Without a published official base the fork may already be on a newer official
    // version that cannot be told apart from personal changes: only reported.
    const base = await this.deps.officialBase();
    if (!base || !COMMIT.test(base) || !remoteBase || !(await this.isAncestor(remoteBase, remote)))
      return { local, sync: 'diverged' };
    // One side is already on a newer official version: the isolated combine replays the
    // other side's own changes onto it. Unrelated official lines are only reported.
    if (remoteBase !== base)
      return (await this.isAncestor(base, remoteBase)) || (await this.isAncestor(remoteBase, base))
        ? { local, sync: 'needsMerge' }
        : { local, sync: 'diverged' };
    const combined = await this.replayOnto(local, remote, base);
    // Overlapping edits (or history plumbing cannot replay) are combined by Sync's isolated rebase.
    return combined
      ? { local: combined, push: true, merged: { previous: local, base }, base }
      : { local, sync: 'needsMerge' };
  }

  /**
   * Check the bound repository, point the `personal` remote at it and fetch its
   * version and published official base into the tracking refs.
   */
  private async connect(
    repository: string,
    identity: GithubIdentity,
    setStep: (step: CindyMakeRemoteStep) => void,
  ): Promise<{
    auth: { repository: string; token: string };
    remote?: string;
    remoteBase?: string;
  }> {
    if (this.deps.inspectFork) {
      setStep('connecting');
      const health = await this.deps.inspectFork(identity, repository);
      if (health.repository !== repository) {
        // Renamed on GitHub: follow it, still only under the connected account.
        if (!sameGithubLogin(health.repository.split('/')[0], identity.login))
          throw remoteError('forkConflict');
        this.update({ repository: health.repository });
        repository = health.repository;
      }
      if (health.archived) throw remoteError('forkArchived');
      if (!health.canPush) throw remoteError('github');
    }
    const auth = { repository, token: identity.token };
    const url = githubRepositoryUrl(repository);
    // The project queue may still be finishing a generation or another source operation.
    setStep('waiting');
    await this.deps.withProject(async () => {
      setStep('connecting');
      const current = await this.remoteUrl();
      if (current === undefined) await this.git(['remote', 'add', PERSONAL_REMOTE_NAME, url]);
      else if (current !== url) await this.git(['remote', 'set-url', PERSONAL_REMOTE_NAME, url]);
    });
    setStep('connecting');
    const listed = await this.git(
      ['ls-remote', '--refs', PERSONAL_REMOTE_NAME, BRANCH_REF, BASE_BRANCH_REF],
      { auth },
    );
    const tips = new Map(
      listed
        .split(/\r?\n/)
        .map((line) => line.trim().split(/\s+/))
        .filter(([commit, ref]) => COMMIT.test(commit ?? '') && !!ref)
        .map(([commit, ref]) => [ref, commit] as const),
    );
    const remote = tips.get(BRANCH_REF);
    const remoteBase = tips.get(BASE_BRANCH_REF);
    const refspecs = [
      ...(remote ? [`+${BRANCH_REF}:${TRACKING_REF}`] : []),
      ...(remoteBase ? [`+${BASE_BRANCH_REF}:${BASE_TRACKING_REF}`] : []),
    ];
    if (refspecs.length)
      await this.git(
        [
          'fetch',
          '--no-tags',
          '--no-write-fetch-head',
          // Background maintenance must not repack while a build uses the same repository.
          '--no-auto-maintenance',
          PERSONAL_REMOTE_NAME,
          ...refspecs,
        ],
        { auth },
      );
    if (!remote) await this.git(['update-ref', '-d', TRACKING_REF]).catch(() => undefined);
    if (!remoteBase) await this.git(['update-ref', '-d', BASE_TRACKING_REF]).catch(() => undefined);
    return { auth, remote, remoteBase };
  }

  /**
   * The way out when the two personal versions cannot be combined (unrelated official
   * versions, or the user gave up a combine): keep one side, as the user chose. The
   * other side stays recoverable: this computer's version in a local backup ref, the
   * GitHub version in a local backup ref and, when it is replaced, in a backup branch
   * on the user's repository. Called under Sync's source reservation.
   */
  async keepSide(side: 'github' | 'local'): Promise<CindyMakeRemoteSync | undefined> {
    const record = this.deps.read();
    if (!record.repository) throw remoteError('source');
    const repository = record.repository;
    while (this.runningKind) await this.settled();
    this.withinSync = true;
    try {
      this.start('sync', async (setStep) => {
        const identity = await this.requireIdentity();
        if (!sameGithubLogin(record.login, identity.login)) throw remoteError('account');
        if (!(await this.readLocalTip())) throw remoteError('source');
        await this.requireGitVersion();
        const { auth, remote, remoteBase } = await this.connect(repository, identity, setStep);
        if (!remote) throw remoteError('source');
        setStep('waiting');
        await this.deps.withProject(async () => {
          setStep(side === 'github' ? 'retrieving' : 'uploading');
          const local = await this.readLocalTip();
          if (!local) throw remoteError('source');
          await this.git(['update-ref', `refs/cindy-make/backups/personal-remote/${remote}`, remote]);
          await this.git([
            'update-ref',
            `refs/cindy-make/backups/personal-remote-local/${local}`,
            local,
          ]);
          // A failed generation could still need to roll back what is here: generate first.
          const tree = (await this.git(['rev-parse', `${local}^{tree}`])).trim();
          if (await this.deps.hasUnbuiltChanges(local, tree)) {
            this.update({ sync: 'buildFirst' });
            return;
          }
          if (side === 'github') {
            // Its own official base is needed to continue from it.
            if (!remoteBase || !(await this.isAncestor(remoteBase, remote)))
              throw remoteError('failed');
            if (!(await this.movable())) throw remoteError('source');
            // Recorded before the move: an interrupted run must never lose the
            // provenance of content that is already on disk; over-marking after a
            // failed move is safe.
            this.recordUnverifiedRemote(remote);
            // The base ref moves first: interrupted between the two writes, the
            // conservative fact is the new base — never a new tip under a stale one.
            await this.git(['update-ref', PERSONAL_UPSTREAM_REF, remoteBase]);
            await this.git(['reset', '--keep', remote]);
            if ((await this.readLocalTip()) !== remote) throw remoteError('source');
            this.update({
              sync: this.deps.isBuilt(remote) ? 'synced' : 'retrieved',
              syncedAt: this.deps.now(),
              syncedCommit: remote,
            });
            this.deps.sourceChanged();
            return;
          }
          const base = await this.publishableBase(local);
          const backup = `refs/heads/cindy-personal-backup/${remote.slice(0, 12)}`;
          await this.git(
            [
              'push',
              '--porcelain',
              '--atomic',
              '--no-verify',
              '--no-follow-tags',
              `--force-with-lease=${backup}:`,
              `--force-with-lease=${BRANCH_REF}:${remote}`,
              ...(base ? [`--force-with-lease=${BASE_BRANCH_REF}:${remoteBase ?? ''}`] : []),
              PERSONAL_REMOTE_NAME,
              `${remote}:${backup}`,
              `${local}:${BRANCH_REF}`,
              ...(base ? [`${base}:${BASE_BRANCH_REF}`] : []),
            ],
            { auth },
          );
          await this.git(['update-ref', TRACKING_REF, local]);
          if (base) await this.git(['update-ref', BASE_TRACKING_REF, base]);
          this.update({ sync: 'synced', syncedAt: this.deps.now(), syncedCommit: local });
        });
      });
      await this.settled();
    } finally {
      this.withinSync = false;
    }
    const after = this.deps.read();
    if (after.error) throw remoteError(after.error);
    return after.sync;
  }

  private async upload(
    repository: string,
    identity: GithubIdentity,
    setStep: (step: CindyMakeRemoteStep) => void,
  ): Promise<void> {
    const { auth, remote, remoteBase } = await this.connect(repository, identity, setStep);

    setStep('waiting');
    const decision = await this.deps.withProject(async (): Promise<UploadDecision> => {
      setStep('connecting');
      const decided = await this.decide(remote, remoteBase);
      // A combined version is uploaded first; this computer moves to it afterwards.
      if (!('adopt' in decided) || !remote) return decided;
      // Retrieve: keep this computer's version reachable, then move to the GitHub version.
      setStep('retrieving');
      await this.git([
        'update-ref',
        `refs/cindy-make/backups/personal-remote-local/${decided.local}`,
        decided.local,
      ]);
      // Recorded before the move: an interrupted run must never lose the provenance
      // of content that is already on disk (over-marking is safe).
      this.recordUnverifiedRemote(remote);
      // The base ref moves first for the same reason (see `keepSide`).
      await this.git(['update-ref', PERSONAL_UPSTREAM_REF, decided.base]);
      await this.git(['reset', '--keep', remote]);
      if ((await this.readLocalTip()) !== remote) throw remoteError('source');
      return decided;
    });

    let sync: CindyMakeRemoteSync;
    let confirmed = decision.local;
    let uploaded = false;
    const { rewrites } = this.deps.read();
    if ('sync' in decision) sync = decision.sync;
    else if ('adopt' in decision) {
      confirmed = remote!;
      sync = this.deps.isBuilt(confirmed) ? 'synced' : 'retrieved';
      this.deps.sourceChanged();
    } else {
      setStep('uploading');
      if ('replace' in decision && decision.replace && remote)
        await this.git(['update-ref', `refs/cindy-make/backups/personal-remote/${remote}`, remote]);
      try {
        await this.git(
          [
            'push',
            '--porcelain',
            '--atomic',
            '--no-verify',
            '--no-follow-tags',
            `--force-with-lease=${BRANCH_REF}:${remote ?? ''}`,
            ...(decision.base ? [`--force-with-lease=${BASE_BRANCH_REF}:${remoteBase ?? ''}`] : []),
            PERSONAL_REMOTE_NAME,
            `${decision.local}:${BRANCH_REF}`,
            ...(decision.base ? [`${decision.base}:${BASE_BRANCH_REF}`] : []),
          ],
          { auth },
        );
      } catch (error) {
        this.update({ sync: 'pending' });
        throw error;
      }
      await this.git(['update-ref', TRACKING_REF, decision.local]);
      if (decision.base) await this.git(['update-ref', BASE_TRACKING_REF, decision.base]);
      uploaded = true;
      // A combine brought the other computer's changes into this upload; they still
      // have to be generated before this computer uses them.
      sync =
        !('merged' in decision) &&
        remote &&
        (rewrites ?? []).some((rewrite) => rewrite.from.slice(1).includes(remote)) &&
        !this.deps.isBuilt(decision.local)
          ? 'retrieved'
          : 'synced';
      if ('merged' in decision) {
        const { previous, base } = decision.merged;
        setStep('retrieving');
        const moved = await this.deps.withProject(async () => {
          // Something changed here while uploading: keep it; the next sync combines again.
          if ((await this.readLocalTip()) !== previous || !(await this.movable())) return false;
          await this.git([
            'update-ref',
            `refs/cindy-make/backups/personal-remote-local/${previous}`,
            previous,
          ]);
          // Recorded before the move (over-marking after a failed move is safe).
          if (remote) this.recordUnverifiedRemote(remote);
          await this.git(['update-ref', PERSONAL_UPSTREAM_REF, base]);
          await this.git(['reset', '--keep', decision.local]);
          if ((await this.readLocalTip()) !== decision.local) throw remoteError('source');
          return true;
        });
        if (moved) {
          this.deps.sourceChanged();
          // The combined version still has to be generated before this computer uses it.
          if (!this.deps.isBuilt(decision.local)) sync = 'retrieved';
        } else sync = 'pending';
      }
    }
    this.update({
      sync,
      // The fork's version was written by this computer even when it could not move to it yet.
      ...(sync === 'synced' || sync === 'retrieved' || uploaded
        ? { syncedAt: this.deps.now(), syncedCommit: confirmed }
        : {}),
    });
    this.deps.log?.info('cindy-make personal remote checked', { sync });
  }
}
