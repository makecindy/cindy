/**
 * 本机项目目录的轻量事实,给伙伴工作台的项目清单分档用。
 *
 * 只 stat `<dir>/.git` 是否存在(文件或目录都算:worktree / submodule 的 .git 是文件),
 * 不读任何文件内容;结果按目录缓存 5 分钟,之后重新 stat(用户可能刚 init 或删了仓库)。
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MAX_CACHED_DIRS = 4_096;
const PROBE_TTL_MS = 5 * 60_000;

export type StatExists = (target: string) => Promise<boolean>;

const defaultStatExists: StatExists = async (target) => {
  try {
    await fs.stat(target);
    return true;
  } catch {
    return false;
  }
};

export function createGitRepoProbe(statExists: StatExists = defaultStatExists, now: () => number = Date.now) {
  const cache = new Map<string, { isRepo: boolean; at: number }>();
  return async function gitRepoDirs(dirs: Iterable<string>): Promise<string[]> {
    const unique = [...new Set([...dirs].filter(Boolean))];
    const results = await Promise.all(
      unique.map(async (dir) => {
        const cached = cache.get(dir);
        if (cached && now() - cached.at < PROBE_TTL_MS) return [dir, cached.isRepo] as const;
        const isRepo = await statExists(path.join(dir, '.git'));
        if (cache.size >= MAX_CACHED_DIRS) cache.clear();
        cache.set(dir, { isRepo, at: now() });
        return [dir, isRepo] as const;
      }),
    );
    return results.filter(([, isRepo]) => isRepo).map(([dir]) => dir).sort();
  };
}

/** 渲染层过滤「不像用户项目」的目录要用到的本机路径;只给路径,不给内容。 */
export interface SessionImportPathHints {
  homeDir: string | null;
  userDataDir: string | null;
  tempDirs: string[];
}

export async function readSessionImportPathHints(userDataDir: string | null): Promise<SessionImportPathHints> {
  const tempDirs = new Set<string>();
  const tmp = os.tmpdir();
  tempDirs.add(tmp);
  try {
    tempDirs.add(await fs.realpath(tmp));
  } catch {
    // realpath 失败时保留原值即可。
  }
  return { homeDir: os.homedir() || null, userDataDir, tempDirs: [...tempDirs] };
}
