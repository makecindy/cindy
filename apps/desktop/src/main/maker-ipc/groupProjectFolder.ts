import path from 'node:path';
import { groupRepositoryKey, parseGroupRepository, readGroupRepository, type GroupRepository } from '@cindy/maker-shared/botGroupChat';

export interface GroupProjectRoom { id: string; name?: string; project?: GroupRepository | null }
export interface GroupProjectFolder { dir: string | null; auto: boolean }

/** Only explicit URLs in the request can identify a repository. Never fetch one here. */
export function requestRepository(text: string): GroupRepository | null {
  const repositories = new Map<string, GroupRepository>();
  for (const match of text.matchAll(/https?:\/\/[^\s<>`（）「」，。]+/gi)) {
    const repo = parseGroupRepository(match[0].replace(/[).,;\]]+$/, ''));
    if (repo) repositories.set(groupRepositoryKey(repo), repo);
  }
  return repositories.size === 1 ? [...repositories.values()][0]! : null;
}

export function createGroupProjectFolders(deps: {
  chosen: (roomId: string) => string | null;
  findRegistered?: (repository: GroupRepository) => Promise<string[]>;
  executorProject?: (botId: string) => Promise<string | null>;
  validate?: (dir: string) => Promise<{ ok: true; dir: string } | { ok: false }>;
}) {
  // Group snapshots refresh often. Cache presentation only; every dispatch resolves current membership.
  const previews = new Map<string, { roomRepository: string; until: number; result: Promise<GroupProjectFolder> }>();
  async function resolve(room: GroupProjectRoom, request?: GroupRepository | null): Promise<GroupProjectFolder> {
    const chosen = deps.chosen(room.id);
    if (chosen) {
      const checked = await deps.validate?.(chosen);
      if (!checked?.ok) throw new Error('WORKDIR_UNAVAILABLE');
      return { dir: checked.dir, auto: false };
    }
    const roomRepository = readGroupRepository(room.project);
    const repositories = roomRepository && request && groupRepositoryKey(roomRepository) === groupRepositoryKey(request)
      ? [roomRepository] : [roomRepository, request];
    for (const repository of repositories) {
      if (!repository) continue;
      const matches = await deps.findRegistered?.(repository);
      if (matches?.length === 1) {
        const checked = await deps.validate?.(matches[0]!);
        if (checked?.ok) return { dir: checked.dir, auto: true };
      }
    }
    return { dir: null, auto: true };
  }

  return {
    registered: async (dir: string) => !!(await deps.validate?.(dir))?.ok,
    invalidate: () => previews.clear(),
    shown: async (room: GroupProjectRoom): Promise<GroupProjectFolder> => {
      const chosen = deps.chosen(room.id);
      if (chosen) return { dir: chosen, auto: false };
      const repo = readGroupRepository(room.project);
      if (!repo) return { dir: null, auto: true };
      const key = groupRepositoryKey(repo);
      const cached = previews.get(room.id);
      if (cached?.roomRepository === key && cached.until > Date.now()) return cached.result;
      if (previews.size >= 128) previews.clear();
      const result = resolve(room);
      previews.set(room.id, { roomRepository: key, until: Date.now() + 20_000, result });
      try { return await result; } catch (error) {
        if (previews.get(room.id)?.result === result) previews.delete(room.id);
        throw error;
      }
    },
    async forWork(room: GroupProjectRoom, options: {
      botId: string; request?: GroupRepository | null; isCurrent: () => boolean;
    }) {
      if (!options.isCurrent()) throw new Error('OWNER_CHANGED');
      const project = await resolve(room, options.request);
      if (!options.isCurrent()) throw new Error('OWNER_CHANGED');
      const dir = project.dir ?? await deps.executorProject?.(options.botId) ?? null;
      if (!options.isCurrent()) throw new Error('OWNER_CHANGED');
      return { ...project, dir, continueConversation: !project.dir && !room.project && !options.request };
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
