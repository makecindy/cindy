/**
 * repoRoot.ts — 意识仓库根目录解析(userData/cindy-brain)+ 旧目录一次性迁移。
 *
 * 历史:仓库根最初叫 userData/brain,源码目录整体改名 cindy-brain 后落盘
 * 目录跟进对齐。首次解析时若旧目录在、新目录不在,原地 rename 迁移(同卷
 * 原子、瞬时,已装意识全数保留);rename 失败(如 Windows 句柄占用)则本次
 * 继续用旧目录——数据不丢,下次启动再试。依赖注入(规则 14),单测零 electron。
 */

import path from 'node:path';

export interface GhostRepoRootDeps {
  /** userData 绝对路径(生产:app.getPath('userData'))。 */
  userDataDir: string;
  exists(p: string): boolean;
  rename(from: string, to: string): void;
  log: {
    info(...args: unknown[]): void;
    warn(...args: unknown[]): void;
  };
}

export interface GhostRepoRootCacheEntry {
  ownerScopeKey: string;
  rootDir: string;
}

/** 解析意识仓库根;调用方自行缓存结果(迁移只应尝试一次)。 */
export function resolveGhostRepoRoot(deps: GhostRepoRootDeps): string {
  const root = path.join(deps.userDataDir, 'cindy-brain');
  const legacy = path.join(deps.userDataDir, 'brain');
  try {
    if (deps.exists(legacy)) {
      if (!deps.exists(root)) {
        deps.rename(legacy, root);
        deps.log.info('ghost repo dir migrated', { from: legacy, to: root });
      } else {
        // 两个目录并存(不应发生):按新目录走,旧目录留痕不动,避免误删。
        deps.log.warn('both legacy and new ghost repo dirs exist, using new dir', {
          legacy,
          root,
        });
      }
    }
  } catch (err) {
    deps.log.warn('ghost repo dir migration failed, keep using legacy dir', {
      err: String(err),
    });
    return legacy;
  }
  return root;
}

/** Cache the resolved repository root only for the owner scope that produced it. */
export function resolveCachedGhostRepoRoot(
  cache: GhostRepoRootCacheEntry | null,
  ownerScopeKey: string,
  deps: GhostRepoRootDeps,
): GhostRepoRootCacheEntry {
  if (cache?.ownerScopeKey === ownerScopeKey) return cache;
  return {
    ownerScopeKey,
    rootDir: resolveGhostRepoRoot(deps),
  };
}
