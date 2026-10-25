/**
 * `.xdmaker/` → `.cindy/` 目录约定的一次性搬迁（2026-07-20 品牌迁移收尾）。
 *
 * 语义：发现 rootDir 下还有旧 `.xdmaker/` 目录时，把它搬成 `.cindy/`；此后所有
 * 读写路径只认 `.cindy`，不做回落读取。幂等、可并发（rename 原子性天然兜底：
 * 并发第二个调用者撞 ENOENT 视为已被搬走）、任何失败只 warn 不抛错——调用方
 * 随后按 `.cindy` 缺失的语义继续（等同"该目录没有配置"）。
 *
 * 搬迁规则：
 * - `.xdmaker` 不存在（或不是目录）→ no-op；
 * - `.cindy` 不存在 → 整目录 rename；
 * - `.cindy` 已存在 → 逐个搬 `.xdmaker` 下在 `.cindy` 里缺失的子项，
 *   搬空后删掉旧空壳；仍非空（两边有同名子项）则保留旧目录并 warn，
 *   由用户自行合并处置——绝不覆盖 `.cindy` 侧已有内容。
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";

import type { Logger } from "@cindy/maker-core";

export const LEGACY_DIR_NAME = ".xdmaker";
export const CINDY_DIR_NAME = ".cindy";

export interface MigrationResult {
  /** true = migration complete (or nothing to migrate); false = conflict/failure, .cindy may be incomplete */
  complete: boolean;
}

/**
 * 同一 root 只做一次（进程内），并发调用 await 同一个 Promise，
 * 确保迁移真正完成后后续读取才继续。
 *
 * Returns `{ complete: true }` when migration finished or was unnecessary.
 * Returns `{ complete: false }` when conflicts or failures leave `.xdmaker`
 * with unmerged content — callers should skip destructive reconcile.
 */
export function createLegacyXdmakerMigration(
  log: Pick<Logger, "info" | "warn">,
) {
  const migrating = new Map<string, Promise<MigrationResult>>();

  async function migrateLegacyXdmakerDir(
    rootDir: string,
  ): Promise<MigrationResult> {
    if (!rootDir) return { complete: true };
    const key = path.resolve(rootDir);
    const existing = migrating.get(key);
    if (existing) return existing;

    const promise = doMigrate(key);
    migrating.set(key, promise);
    return promise;
  }

  async function mergeDir(src: string, dst: string): Promise<void> {
    const entries = await fs.readdir(src);
    for (const entry of entries) {
      const from = path.join(src, entry);
      const to = path.join(dst, entry);
      const toStat = await fs.stat(to).catch(() => null);
      if (!toStat) {
        await fs.rename(from, to);
      } else if (toStat.isDirectory() && (await fs.stat(from)).isDirectory()) {
        await mergeDir(from, to);
      }
    }
    if ((await fs.readdir(src)).length === 0) await fs.rmdir(src);
  }

  async function doMigrate(key: string): Promise<MigrationResult> {
    const oldRoot = path.join(key, LEGACY_DIR_NAME);
    const newRoot = path.join(key, CINDY_DIR_NAME);
    try {
      const oldStat = await fs.stat(oldRoot).catch(() => null);
      if (!oldStat?.isDirectory()) return { complete: true };

      const newExists = await fs
        .stat(newRoot)
        .then(() => true)
        .catch(() => false);
      if (!newExists) {
        await fs.rename(oldRoot, newRoot);
        log.info("migrated legacy .xdmaker dir to .cindy", { rootDir: key });
        return { complete: true };
      }

      await mergeDir(oldRoot, newRoot);

      const oldExists = await fs
        .stat(oldRoot)
        .then(() => true)
        .catch(() => false);
      if (!oldExists) {
        log.info("merged legacy .xdmaker dir into existing .cindy", {
          rootDir: key,
        });
        return { complete: true };
      }

      migrating.delete(key);
      const leftover = await fs.readdir(oldRoot);
      log.warn(
        "legacy .xdmaker dir left non-empty after merge (file conflicts in .cindy)",
        {
          rootDir: key,
          leftover,
        },
      );
      return { complete: false };
    } catch (err) {
      migrating.delete(key);
      log.warn("failed to migrate legacy .xdmaker dir", {
        rootDir: key,
        error: err instanceof Error ? err.message : String(err),
      });
      return { complete: false };
    }
  }

  /** 仅供测试：清掉进程内"已搬迁"标记。 */
  function resetLegacyXdmakerMigrationCacheForTest(): void {
    migrating.clear();
  }

  return { migrateLegacyXdmakerDir, resetLegacyXdmakerMigrationCacheForTest };
}
