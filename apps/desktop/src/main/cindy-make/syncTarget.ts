/**
 * Which official version Sync moves the personal version to.
 *
 * A personal version can only replace this computer's original Cindy when both
 * use the same database migrations (see `versionStore`). The personal app never
 * updates itself, so following a release whose migrations differ from the
 * installed original would produce a version that cannot be switched to. Sync
 * therefore follows the latest release only while its migrations match, and
 * otherwise stays on the original's own official version until Cindy is updated.
 */

const COMMIT = /^[0-9a-f]{40}$/i;
/** Database migrations shipped with the desktop app; their identity gates version switching. */
export const MIGRATIONS_PATH = 'apps/desktop/drizzle';

export interface SyncTargetVersion {
  ref: string;
  commit: string;
}
export interface SyncTarget extends SyncTargetVersion {
  /** A newer release whose migrations need this computer's Cindy updated first. */
  held?: SyncTargetVersion;
}

export interface SyncTargetDeps {
  latest: SyncTargetVersion & { channel: 'dev' | 'beta' | 'release' };
  /** The installed original Cindy, when known. */
  original?: { version?: string; commit?: string; dirty?: boolean };
  /** Commit of an official tag, or undefined when it does not exist. */
  tagCommit(tag: string): Promise<string | undefined>;
  /** Make official commits available locally (fetched by hash). */
  fetch(commits: string[]): Promise<void>;
  /** `git diff --quiet` exit status for the migrations between two commits: true when equal. */
  sameMigrations(from: string, to: string): Promise<boolean>;
  isAncestor(ancestor: string, descendant: string): Promise<boolean>;
}

/**
 * Never move a personal version to an older official version than it is on: when
 * the target is behind the current base (for example the base came from another
 * computer), the base itself is the target.
 */
export async function notBehindBase(
  target: SyncTargetVersion,
  base: string | undefined,
  isAncestor: (ancestor: string, descendant: string) => Promise<boolean>,
): Promise<SyncTargetVersion> {
  if (!base || !COMMIT.test(base) || base === target.commit) return target;
  return (await isAncestor(target.commit, base)) ? { ref: target.ref, commit: base } : target;
}

/**
 * The returned commit is always available locally. Development builds and an
 * unknown original follow the latest version; a known installed release that
 * cannot be compared fails closed (the caller reports it and moves nothing).
 */
export async function pickSyncTarget(deps: SyncTargetDeps): Promise<SyncTarget> {
  const { latest, original } = deps;
  const follow: SyncTarget = { ref: latest.ref, commit: latest.commit };
  // Development builds follow main and are not switched against an installed release.
  if (latest.channel === 'dev' || !original?.version) {
    await deps.fetch([latest.commit]);
    return follow;
  }
  const tag = `v${original.version}`;
  const installed =
    original.commit && !original.dirty && COMMIT.test(original.commit)
      ? original.commit
      : await deps.tagCommit(tag);
  if (!installed || !COMMIT.test(installed) || installed === latest.commit) {
    await deps.fetch([latest.commit]);
    return follow;
  }
  await deps.fetch([latest.commit, installed]);
  // A newer original (for example a beta) is never held back to an older release.
  if (!(await deps.isAncestor(installed, latest.commit))) return follow;
  if (await deps.sameMigrations(installed, latest.commit)) return follow;
  return { ref: tag, commit: installed, held: { ref: latest.ref, commit: latest.commit } };
}
