/**
 * Renderer-visible state of the personal-version GitHub binding.
 *
 * Only public facts cross this boundary: the GitHub login and `<owner>/<repo>`
 * name. Tokens, authenticated URLs, local paths and raw Git output never do.
 */

export const CINDY_MAKE_REMOTE_STEPS = [
  'waiting',
  'preparing',
  'fork',
  'connecting',
  'retrieving',
  'uploading',
] as const;
export type CindyMakeRemoteStep = (typeof CINDY_MAKE_REMOTE_STEPS)[number];

export const CINDY_MAKE_REMOTE_ERRORS = [
  /** No usable GitHub connection, or GitHub rejected the credential. */
  'github',
  /** The connected GitHub login differs from the bound repository owner. */
  'account',
  /** The account already has a same-named repository that is not an official fork. */
  'forkConflict',
  /** GitHub accepted the fork request, but the repository never became reachable. */
  'forkUnavailable',
  /** The bound repository no longer exists on GitHub (deleted, or renamed beyond recognition). */
  'forkMissing',
  /** The bound repository is archived: GitHub accepts no uploads. */
  'forkArchived',
  'network',
  /** The credential lacks the `workflow` scope needed to push workflow file changes. */
  'workflowScope',
  /** The managed personal source is missing or not in a state that can be synchronized. */
  'source',
  /** Git older than 2.36 cannot receive a per-command credential or compare merges. */
  'gitOutdated',
  /** The application stopped while an operation was running; nothing is replayed. */
  'interrupted',
  'failed',
] as const;
export type CindyMakeRemoteError = (typeof CINDY_MAKE_REMOTE_ERRORS)[number];

export const CINDY_MAKE_REMOTE_SYNC = [
  /** GitHub holds exactly the local established personal version. */
  'synced',
  /** Local changes are not generated yet; only generated content is uploaded. */
  'pendingBuild',
  /**
   * Both sides have changes, and this computer's are not generated yet: generating
   * first lets the next Sync combine them with the other computer's.
   */
  'buildFirst',
  /** Changes from another computer were retrieved; generating makes them usable here. */
  'retrieved',
  /** Uploading failed; the local personal version is unaffected. */
  'pending',
  /** GitHub has changes from another computer that this computer does not have. */
  'remoteAhead',
  /** GitHub and this computer both have changes the other lacks. */
  'diverged',
  /**
   * Both sides have changes that could not be taken over automatically; Sync
   * combines them in an isolated folder, with a conflict task when needed.
   */
  'needsMerge',
] as const;
export type CindyMakeRemoteSync = (typeof CINDY_MAKE_REMOTE_SYNC)[number];

export interface CindyMakePersonalRemoteState {
  /** The user's persisted storage decision; undefined until they choose. */
  choice?: 'github' | 'local';
  /** Bound repository, `<owner>/<name>`. */
  repository?: string;
  /** GitHub login the repository was bound with. */
  login?: string;
  /** Live GitHub connection of this computer. */
  github: 'connected' | 'missing' | 'unavailable';
  githubLogin?: string;
  running?: 'save' | 'sync' | 'disconnect';
  step?: CindyMakeRemoteStep;
  sync?: CindyMakeRemoteSync;
  error?: CindyMakeRemoteError;
  syncedAt?: number;
  /** Before binding: the account already holds a personal version saved by another computer. */
  existingPersonal?: string;
  /** This computer has a prepared personal source. */
  sourceReady?: boolean;
  /** Keep offering "save to your GitHub" until bound or explicitly declined. */
  offerMigration: boolean;
}

export const CINDY_MAKE_REMOTE_ACTIONS = [
  'status',
  'refresh',
  'save',
  'sync',
  'keep-local',
  'disconnect',
] as const;
export type CindyMakePersonalRemoteAction = (typeof CINDY_MAKE_REMOTE_ACTIONS)[number];

const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const GITHUB_REPOSITORY_NAME = /^[A-Za-z0-9._-]{1,100}$/;

export function isGithubLogin(value: unknown): value is string {
  return typeof value === 'string' && GITHUB_LOGIN.test(value);
}

/** `<owner>/<name>` with GitHub's character rules; `.` and `..` are not repository names. */
export function isGithubRepository(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const [owner, name, ...rest] = value.split('/');
  return (
    rest.length === 0 &&
    isGithubLogin(owner) &&
    typeof name === 'string' &&
    GITHUB_REPOSITORY_NAME.test(name) &&
    name !== '.' &&
    name !== '..' &&
    !name.endsWith('.git')
  );
}

/** GitHub logins are case-insensitive. */
export function sameGithubLogin(left: string | undefined, right: string | undefined): boolean {
  return !!left && !!right && left.toLowerCase() === right.toLowerCase();
}
