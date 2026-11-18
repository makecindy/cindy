import path from 'node:path';
import { access, mkdir, stat } from 'node:fs/promises';
import { groupRepositoryKey, parseGroupRepository, readGroupRepository, type GroupRepository } from '@cindy/maker-shared/botGroupChat';
import type { GroupCheckoutResult, GroupProjectCheckouts } from './groupProjectCheckout.js';

/**
 * A group's project folder on this computer (bot-group-chat.md §7.5), in this order:
 *
 * 1. the folder chosen here in group management;
 * 2. a project registered in Cindy that is a checkout of the group's repository — GitHub, GitLab,
 *    CNB or any git host — (any of its git remotes, so a fork whose `upstream` is the repository
 *    counts), the most recently used one;
 * 3. Cindy's own folder for that repository (`groupProjectCheckout.ts`), cloned in the background;
 * 4. without a repository, the group's own folder under the conversation workspace.
 *
 * Finding the folder never waits on the network: work starts in it right away, and a repository
 * still being fetched is reported as `pending`. A chosen folder is binding: when it is gone the work
 * fails rather than running somewhere else. The others are found for the user, so a folder that
 * went away is simply looked up again.
 */
export interface GroupProjectRoom { id: string; name?: string; project?: GroupRepository | null }
export interface GroupProjectFolder {
  dir: string | null;
  /** Found from the group's repository, not chosen on this computer. */
  auto: boolean;
}
/** `pending`: the group's repository is not in `dir` yet, and why (`preparing`: being cloned now). */
export type GroupWorkFolder = GroupProjectFolder & { pending?: { status: 'preparing' } | Exclude<GroupCheckoutResult, { status: 'ready' }> };

/** How long a found folder is trusted, and how soon a miss is looked up again. */
const FOUND_MS = 5 * 60_000;
const MISSED_MS = 20_000;

export function createGroupProjectFolders(deps: {
  /** The folder chosen for this group on this computer. */
  chosen: (roomId: string) => string | null;
  /** Persisted automatic binding survives group rename and workspace setting changes. */
  fallback?: (room: GroupProjectRoom) => string | null;
  bindFallback?: (roomId: string, dir: string) => void;
  workspaceRoot?: () => { directory: string; isCustomized: boolean };
  /** Registered project folders that are checkouts of this repository, most recently used first. */
  findRegistered?: (repository: GroupRepository) => Promise<string[]>;
  checkouts?: Pick<GroupProjectCheckouts, 'ensure' | 'sync' | 'isManaged' | 'dirOf'>;
  /** The account is still the one this service runs for: a background clone stops otherwise. */
  owner?: () => boolean;
  /** An existing local directory usable as a project (same rules as a new task's project). */
  validate?: (dir: string) => Promise<{ ok: true; dir: string } | { ok: false }>;
}) {
  // Settings reads and every reply resolve the folder, and each lookup reads the git remotes of
  // local projects. A reply burst shares one lookup; a project registered just now is found soon.
  const registered = new Map<string, { until: number; dir: Promise<string | null> }>();
  const repoOf = (room: GroupProjectRoom) => readGroupRepository(room.project);
  const forget = (repo: GroupRepository) => { registered.delete(groupRepositoryKey(repo)); };
  function registeredFolder(repo: GroupRepository): Promise<string | null> {
    const key = groupRepositoryKey(repo);
    const cached = registered.get(key);
    if (cached && Date.now() < cached.until) return cached.dir;
    const entry: { until: number; dir: Promise<string | null> } = { until: Date.now() + FOUND_MS, dir: Promise.resolve(null) };
    // Several registered checkouts of one repository: the one used last is the one being worked in.
    // The user's own checkout always comes before Cindy's copy, even when the copy was used more
    // recently (2026-11-14: a copy fetched before the fork was recognized kept winning).
    entry.dir = (deps.findRegistered?.(repo) ?? Promise.resolve([]))
      .then(dirs => dirs.find(dir => !deps.checkouts?.isManaged(dir)) ?? dirs[0] ?? null, () => null)
      .then(dir => { if (!dir) entry.until = Date.now() + MISSED_MS; return dir; });
    registered.set(key, entry);
    return entry.dir;
  }
  const usable = async (dir: string) => {
    const checked = await deps.validate?.(dir).catch(() => null);
    return checked?.ok ? checked.dir : null;
  };

  const fallback = (room: GroupProjectRoom) => {
    const bound = deps.fallback?.(room);
    // A persisted location may be on an offline volume too. Never recreate its parents.
    if (bound) return { dir: bound, recursive: false };
    const workspace = deps.workspaceRoot?.();
    if (!workspace) throw new Error('WORKDIR_UNAVAILABLE');
    const name = `${(room.name ?? 'Group').replace(/[<>:\\\/|?*\x00-\x1f]/g, '-').slice(0, 80) || 'Group'}-${encodeURIComponent(room.id)}`;
    return { dir: path.join(workspace.directory, name), recursive: !workspace.isCustomized };
  };
  const defaultFolder = async (room: GroupProjectRoom, isCurrent: () => boolean) => {
    const { dir, recursive } = fallback(room);
    if (!isCurrent()) throw new Error('OWNER_CHANGED');
    try { await mkdir(dir, { recursive }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || !(await stat(dir)).isDirectory()) throw error;
    }
    if (!isCurrent()) throw new Error('OWNER_CHANGED');
    deps.bindFallback?.(room.id, dir);
    return { dir, auto: true };
  };

  /** The last attempt to fetch each repository that did not succeed, shown until one does. */
  const failed = new Map<string, Exclude<GroupCheckoutResult, { status: 'ready' }>>();
  /**
   * Cindy's folder for `repo`, there at once. Without the repository in it yet, a clone starts in the
   * background (one at a time per repository) and the folder is returned as pending.
   */
  async function managedFolder(room: GroupProjectRoom, repo: GroupRepository, options: { signIn: boolean; isCurrent: () => boolean }): Promise<GroupWorkFolder> {
    const checkouts = deps.checkouts;
    const dir = checkouts?.dirOf(repo);
    if (!checkouts || !dir) throw new Error('WORKDIR_UNAVAILABLE');
    if (!options.isCurrent()) throw new Error('OWNER_CHANGED');
    if (await access(path.join(dir, '.git')).then(() => true, () => false)) {
      // Brought up to date in the background; the request never waits for the network.
      void checkouts.sync(dir);
      return { dir, auto: true };
    }
    await mkdir(dir, { recursive: true });
    const owner = deps.owner ?? options.isCurrent;
    const key = groupRepositoryKey(repo);
    const last = failed.get(key);
    void checkouts.ensure(repo, { signIn: options.signIn, isCurrent: owner })
      ?.then(result => { if (result.status === 'ready') { failed.delete(key); forget(repo); } else failed.set(key, result); },
        () => undefined);
    return { dir, auto: true, pending: last ?? { status: 'preparing' } };
  }

  return {
    /** What group management shows: the chosen folder, else the folder work would use. Never clones. */
    async shown(room: GroupProjectRoom): Promise<GroupProjectFolder> {
      const chosen = deps.chosen(room.id);
      if (chosen) return { dir: chosen, auto: false };
      const repo = repoOf(room);
      return { dir: (repo ? await registeredFolder(repo) ?? deps.checkouts?.dirOf(repo) : null) ?? fallback(room).dir, auto: true };
    },
    /**
     * The folder work for this group runs in, checked to exist; never waits on the network.
     * `signIn`: a background clone may open Cindy's GitHub sign-in (the requester's own request).
     */
    async forWork(room: GroupProjectRoom, options: { signIn: boolean; isCurrent: () => boolean }): Promise<GroupWorkFolder> {
      // A host that cannot check folders has no project folders.
      if (!options.isCurrent()) throw new Error('OWNER_CHANGED');
      if (!deps.validate) throw new Error('WORKDIR_UNAVAILABLE');
      const chosen = deps.chosen(room.id);
      if (chosen) {
        const dir = await usable(chosen);
        if (!dir) throw new Error('WORKDIR_UNAVAILABLE');
        return { dir: chosen, auto: false };
      }
      const repo = repoOf(room);
      if (!repo) return defaultFolder(room, options.isCurrent);
      const found = await registeredFolder(repo);
      if (found && !deps.checkouts?.isManaged(found)) {
        const dir = await usable(found);
        if (dir) return { dir, auto: true };
        forget(repo);
      }
      return managedFolder(room, repo, options);
    },
  };
}
export type GroupProjectFolders = ReturnType<typeof createGroupProjectFolders>;

/**
 * Registered project folders that are checkouts of `repo`: any of their git remotes is it, so a
 * fork whose `upstream` is the repository counts. Main checkouts only: a linked worktree (`.git` is
 * a file) or a folder inside another match is the same project. Keeps the order of `dirs`.
 */
export async function findRepositoryFolders(dirs: readonly string[], repo: GroupRepository, read: {
  remotes(dir: string): Promise<string[]>;
  isMainCheckout(dir: string): Promise<boolean>;
}): Promise<string[]> {
  const wanted = groupRepositoryKey(repo);
  const matches: string[] = [];
  for (let start = 0; start < dirs.length; start += 8) {
    const batch = dirs.slice(start, start + 8);
    const found = await Promise.all(batch.map(async dir => {
      const remotes = await read.remotes(dir).catch(() => [] as string[]);
      return remotes.some(url => { const found = parseGroupRepository(url); return !!found && groupRepositoryKey(found) === wanted; })
        && await read.isMainCheckout(dir).catch(() => false) ? dir : null;
    }));
    for (const dir of found) if (dir) matches.push(path.resolve(dir));
  }
  const unique = [...new Set(matches)];
  return unique.filter(dir => !unique.some(other => other !== dir && dir.startsWith(other + path.sep)));
}

/**
 * The repositories a folder's git remotes point at (GitHub, GitLab, CNB or any git host), the group's
 * best guess first: `upstream` (a fork's source, the repository the group shares), then `origin`,
 * then the rest by name. Remotes that are no repository address are left out; the same repository
 * written differently is listed once.
 */
export function folderRepositories(remotes: readonly { name: string; url: string }[]): GroupRepository[] {
  const rank = (name: string) => name === 'upstream' ? 0 : name === 'origin' ? 1 : 2;
  const ordered = [...remotes].sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name));
  const seen = new Set<string>();
  const repos: GroupRepository[] = [];
  for (const remote of ordered) {
    const repo = parseGroupRepository(remote.url);
    if (!repo || seen.has(groupRepositoryKey(repo))) continue;
    seen.add(groupRepositoryKey(repo));
    repos.push(repo);
  }
  return repos;
}
