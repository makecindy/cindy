import path from 'node:path';
import { githubRepositoryOfRemote, type GroupCheckoutResult, type GroupProjectCheckouts } from './groupProjectCheckout.js';

/**
 * A group's project folder on this computer (bot-group-chat.md §7.5), in this order:
 *
 * 1. the folder chosen here in group management;
 * 2. the one project registered in Cindy whose git `origin` is the group's repository;
 * 3. Cindy's own checkout of that repository, cloned on first need (`groupProjectCheckout.ts`).
 *
 * A chosen folder is binding: when it is gone the work fails rather than running somewhere else.
 * The other two are found for the user, so a folder that went away is simply looked up again.
 */
export interface GroupProjectRoom { id: string; project?: { kind: 'github'; repo: string } | null }
export interface GroupProjectFolder {
  dir: string | null;
  /** Found from the group's repository, not chosen on this computer. */
  auto: boolean;
}
/** `pending`: why the group's repository is not on this computer yet; `dir` is null then. */
export type GroupWorkFolder = GroupProjectFolder & { pending?: Exclude<GroupCheckoutResult, { status: 'ready' }> };

/** How long a found folder is trusted, and how soon a miss is looked up again. */
const FOUND_MS = 5 * 60_000;
const MISSED_MS = 20_000;

export function createGroupProjectFolders(deps: {
  /** The folder chosen for this group on this computer. */
  chosen: (roomId: string) => string | null;
  /** Registered project folders whose git `origin` is this repository. */
  findRegistered?: (repo: string) => Promise<string[]>;
  checkouts?: Pick<GroupProjectCheckouts, 'ensure' | 'sync' | 'isManaged'>;
  /** An existing local directory usable as a project (same rules as a new task's project). */
  validate?: (dir: string) => Promise<{ ok: true; dir: string } | { ok: false }>;
}) {
  // Settings reads and every reply resolve the folder, and each lookup reads the git remotes of
  // local projects. A reply burst shares one lookup; a project registered just now is found soon.
  const registered = new Map<string, { until: number; dir: Promise<string | null> }>();
  const repoOf = (room: GroupProjectRoom) => room.project?.kind === 'github' ? room.project.repo : null;
  const forget = (repo: string) => { registered.delete(repo.toLowerCase()); };
  function registeredFolder(repo: string): Promise<string | null> {
    const key = repo.toLowerCase();
    const cached = registered.get(key);
    if (cached && Date.now() < cached.until) return cached.dir;
    const entry: { until: number; dir: Promise<string | null> } = { until: Date.now() + FOUND_MS, dir: Promise.resolve(null) };
    // Several registered checkouts of one repository: Cindy does not guess which one is meant.
    entry.dir = (deps.findRegistered?.(repo) ?? Promise.resolve([]))
      .then(dirs => dirs.length === 1 ? dirs[0]! : null, () => null)
      .then(dir => { if (!dir) entry.until = Date.now() + MISSED_MS; return dir; });
    registered.set(key, entry);
    return entry.dir;
  }
  const usable = async (dir: string) => {
    const checked = await deps.validate?.(dir).catch(() => null);
    return checked?.ok ? checked.dir : null;
  };

  return {
    /** What group management shows: the chosen folder, else the registered project. Never clones. */
    async shown(room: GroupProjectRoom): Promise<GroupProjectFolder> {
      const chosen = deps.chosen(room.id);
      if (chosen) return { dir: chosen, auto: false };
      const repo = repoOf(room);
      return { dir: repo ? await registeredFolder(repo) : null, auto: true };
    },
    /**
     * The folder work for this group runs in, checked to exist. `signIn`: Cindy may open its GitHub
     * sign-in to clone the repository (the requester's own request, on their computer).
     */
    async forWork(room: GroupProjectRoom, options: { signIn: boolean; isCurrent: () => boolean }): Promise<GroupWorkFolder> {
      // A host that cannot check folders has no project folders.
      if (!deps.validate) return { dir: null, auto: false };
      const chosen = deps.chosen(room.id);
      if (chosen) {
        const dir = await usable(chosen);
        if (!dir) throw new Error('WORKDIR_UNAVAILABLE');
        return { dir, auto: false };
      }
      const repo = repoOf(room);
      if (!repo) return { dir: null, auto: true };
      const found = await registeredFolder(repo);
      if (found && !deps.checkouts?.isManaged(found)) {
        const dir = await usable(found);
        if (dir) return { dir, auto: true };
        forget(repo);
      }
      // Cindy's own checkout is a convenience: a clone that cannot run leaves the work without the project.
      const checkout = await deps.checkouts?.ensure(repo, options)
        ?.catch(error => { if (!options.isCurrent()) throw error; return null; });
      if (!checkout) return { dir: null, auto: true };
      if (checkout.status !== 'ready') return { dir: null, auto: true, pending: checkout };
      // Registered by the clone: group management shows it from now on.
      forget(repo);
      const dir = await usable(checkout.dir);
      if (dir) await deps.checkouts!.sync(dir);
      return { dir, auto: true };
    },
  };
}
export type GroupProjectFolders = ReturnType<typeof createGroupProjectFolders>;

/**
 * Registered project folders that are checkouts of `repo` (their `origin`), main checkouts only:
 * a linked worktree (`.git` is a file) or a folder inside another match is the same project.
 */
export async function findRepositoryFolders(dirs: readonly string[], repo: string, read: {
  origin(dir: string): Promise<string | null>;
  isMainCheckout(dir: string): Promise<boolean>;
}): Promise<string[]> {
  const wanted = repo.toLowerCase();
  const matches: string[] = [];
  for (let start = 0; start < dirs.length; start += 8) {
    const batch = dirs.slice(start, start + 8);
    const found = await Promise.all(batch.map(async dir => {
      const origin = await read.origin(dir).catch(() => null);
      return origin && githubRepositoryOfRemote(origin)?.toLowerCase() === wanted && await read.isMainCheckout(dir).catch(() => false) ? dir : null;
    }));
    for (const dir of found) if (dir) matches.push(path.resolve(dir));
  }
  const unique = [...new Set(matches)];
  return unique.filter(dir => !unique.some(other => other !== dir && dir.startsWith(other + path.sep)));
}
