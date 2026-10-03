import path from 'node:path';

import { readAtomicFileSync } from '../utils/atomicWriteFile.js';
import { parsePersonalRemoteTrust, type PersonalRewrite } from './personalRemote.js';
import { runSourceGit } from './sourceGit.js';
import { makeSourceCheckoutPath, makeSourceRoot } from './sourcePaths.js';
import { publishedPersonalVersionCommits } from './versionStore.js';

const COMMIT = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;

export interface InstallScriptsTrust {
  /** Fork tips taken over before this computer verified them (see `recordUnverifiedRemote`). */
  unverifiedRemote(): string[];
  /** Adopted history rewrites (official updates and combines), see `recordRewrite`. */
  rewrites(): PersonalRewrite[];
  /** Commits a generated personal version was published from. */
  published(): string[];
  /** Git ancestry in the managed checkout. */
  contains(ancestor: string, descendant: string): Promise<boolean>;
}

/**
 * `tip`'s content reached `target`, directly or through the adopted history rewrites:
 * an official update or combine replays content under new commits, and the provenance
 * travels with it (see `PersonalRemoteController.carriedByRewrites`).
 */
async function reaches(
  trust: InstallScriptsTrust,
  tip: string,
  target: string,
): Promise<boolean> {
  const carried = [tip];
  for (const rewrite of trust.rewrites()) {
    for (const input of rewrite.from) {
      let included = false;
      for (const known of carried)
        if (await trust.contains(known, input)) {
          included = true;
          break;
        }
      if (included) {
        if (!carried.includes(rewrite.to)) carried.push(rewrite.to);
        break;
      }
    }
  }
  for (const commit of carried) if (await trust.contains(commit, target)) return true;
  return false;
}

/**
 * Whether the automatic task-worktree install must skip lifecycle scripts and
 * pnpm hooks.
 *
 * Sync can take over `cindy-personal` content pushed to the user's fork by anyone
 * with write access to it. Installing that content would run its `postinstall` or
 * `.pnpmfile.cjs` at task creation, before anyone looks at it. Content is considered
 * verified — adopted by the user — once a generated personal version covers it:
 * generating runs the content's own checks and produces the application the user
 * chose to run. Until then the automatic install runs with `--ignore-scripts
 * --ignore-pnpmfile`; a task that really needs the scripts runs its own install,
 * visibly, as part of its work.
 */
export async function remoteContentScriptsUnverified(
  baseCommit: string,
  trust: InstallScriptsTrust,
): Promise<boolean> {
  if (!COMMIT.test(baseCommit)) return true;
  for (const tip of trust.unverifiedRemote()) {
    if (!COMMIT.test(tip) || !(await reaches(trust, tip, baseCommit))) continue;
    let verified = false;
    for (const commit of trust.published())
      if (COMMIT.test(commit) && (await reaches(trust, tip, commit))) {
        verified = true;
        break;
      }
    if (!verified) return true;
  }
  return false;
}

/** The real facts from the managed checkout and the published personal versions. */
export function installScriptsTrust(
  userData: string,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
): InstallScriptsTrust {
  const source = makeSourceCheckoutPath(userData);
  const git = (args: string[]) => runSourceGit(env, args, source, signal);
  const record = () =>
    // Corrupt content or an unknown schema proves nothing about trust: it throws,
    // and the caller keeps the guarded install path (see `parsePersonalRemoteTrust`).
    parsePersonalRemoteTrust(
      readAtomicFileSync(path.join(makeSourceRoot(userData), 'personal-remote.json')),
    );
  return {
    unverifiedRemote: () => record().unverifiedRemote ?? [],
    rewrites: () => record().rewrites ?? [],
    published: () => publishedPersonalVersionCommits(userData),
    contains: async (ancestor, descendant) => {
      try {
        await git(['merge-base', '--is-ancestor', ancestor, descendant]);
        return true;
      } catch (error) {
        // Exit 1 is a plain "not an ancestor"; anything else decides nothing.
        if ((error as { exitCode?: number }).exitCode === 1) return false;
        throw error;
      }
    },
  };
}
