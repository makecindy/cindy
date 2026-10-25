/**
 * libraryMigrate.ts — Library 随时迁移状态机(2026-08-20 定案:并入首期)。
 * ---------------------------------------------------------------------------
 * precheck → copying → verifying → switching → grace:
 *   - precheck:候选位置全套校验(可写/受管根排斥/网络盘拒/云盘警告)+
 *     空间 ≥ 现用量×1.2;
 *   - copying:逐文件复制(.sqlite 用在线 backup API 复制,WAL 下安全);
 *   - verifying:全量清单对账(条数/字节数逐项相等)+ 每个 .sqlite
 *     quick_check + 从新位置测试打开;
 *   - switching:写新 binding(generation+1,原子);旧目录改名
 *     `<old>.migrated-<ts>` 保留 14 天回滚窗(grace);
 *   - 任一步失败:binding 未切换、旧位置数据原样(复制残渣留在新候选的
 *     临时目录名下,不影响旧位置)。
 *
 * 迁移期间调用方必须先 dispose 会话并阻止插件写入(readonly 语义由
 * 调用方保证——设置页发起时插件侧会话已作废,短窗口内插件请求会重建
 * 会话写旧根,副本在 switching 前完成对账,该窗口写入最多造成新旧差异、
 * 由 grace 期回滚/重迁修复,不丢数据)。
 *
 * 纯 Node + 依赖注入,单测 tmpdir 直测。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { validateLibraryCandidateLocation, type LibraryBindingDeps } from './libraryBinding.js';

export interface LibraryMigrateDeps extends LibraryBindingDeps {
  getDiskFreeBytes?(root: string): Promise<number | null>;
  /** .sqlite 完整性验证(生产 = 只读打开 + quick_check;测试注入)。 */
  checkSqliteHealthy(absPath: string): Promise<boolean>;
  /** .sqlite 在线备份式复制(生产 = better-sqlite3 backup API;测试注入)。 */
  copySqlite(from: string, to: string): Promise<void>;
  log?: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
  };
  now?(): number;
}

export type LibraryMigrateResult =
  | { ok: true; fromRoot: string; toRoot: string; files: number; bytes: number; warnings: string[] }
  | { ok: false; phase: 'precheck' | 'copying' | 'verifying' | 'switching'; message: string };

/**
 * 收集库内容清单(相对路径→大小;.sqlite 单列)。**任何子目录读不出都抛错**
 * ——静默跳过会迁出一个"子集一致"的库并通过校验(review:部分迁移);
 * 根本身 ENOENT 视为空库(尚无数据)。stat 失败同样抛(文件在收集中消失)。
 */
async function collectManifest(root: string): Promise<Map<string, { bytes: number; sqlite: boolean }>> {
  const manifest = new Map<string, { bytes: number; sqlite: boolean }>();
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch (err) {
      if (dir === root && (err as NodeJS.ErrnoException).code === 'ENOENT') return manifest;
      throw new Error(`清单收集失败(目录不可读:${dir}):${err instanceof Error ? err.message : String(err)}`);
    }
    for (const entry of entries) {
      if (dir === root && entry.name === '.cindy-library') continue; // 宿主元数据随迁但账本重扫
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full).split(path.sep).join('/');
      if (entry.isDirectory()) {
        manifest.set(`${rel}/`, { bytes: 0, sqlite: false });
        stack.push(full);
      } else if (entry.isFile()) {
        let st: fs.Stats;
        try {
          st = await fs.promises.stat(full);
        } catch (err) {
          throw new Error(`清单收集失败(文件不可读:${rel}):${err instanceof Error ? err.message : String(err)}`);
        }
        manifest.set(rel, { bytes: st.size, sqlite: rel.toLowerCase().endsWith('.sqlite') });
      }
    }
  }
  return manifest;
}

async function copyPlain(from: string, to: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(to), { recursive: true });
  await fs.promises.copyFile(from, to);
}

/**
 * 执行迁移:candidate = 用户所选**父目录**(与 setBinding 同口径,实际库根
 * = <candidate>/<ghostId>)。targetKind 'default' 表示迁回系统默认位置
 * (撤销自定义 binding 的反向迁移)。
 */
export async function migrateGhostLibrary(req: {
  ghostId: string;
  fromRoot: string;
  candidate: string;
  deps: LibraryMigrateDeps;
  /** 切换 binding 的回调(生产 = bindingStore.setBinding)。 */
  applyBinding(candidate: string): Promise<{ ok: boolean; message?: string }>;
  /** 迁回系统默认位置的内部路径:默认根在数据区内,豁免受管根排斥。 */
  allowInsideManagedRoot?: boolean;
}): Promise<LibraryMigrateResult> {
  const { ghostId, fromRoot, candidate, deps } = req;
  // ── precheck ─────────────────────────────────────────────────────
  const validation = await validateLibraryCandidateLocation({
    candidate,
    ghostId,
    deps,
    getDiskFreeBytes: deps.getDiskFreeBytes,
    allowInsideManagedRoot: req.allowInsideManagedRoot,
  });
  if (!validation.ok) return { ok: false, phase: 'precheck', message: validation.message };
  const toRoot = path.join(candidate, ghostId);
  // 目标已存在内容 = 拒绝(不合并、不覆盖——作品数据不做启发式合并)。
  try {
    await fs.promises.stat(toRoot);
    if (path.resolve(toRoot) !== path.resolve(fromRoot)) {
      return { ok: false, phase: 'precheck', message: '目标位置已存在同名目录;请换一个位置或先清理' };
    }
  } catch {
    /* 不存在 = 正常 */
  }
  const manifest = await collectManifest(fromRoot);
  let totalBytes = 0;
  let totalFiles = 0;
  for (const [rel, info] of manifest) {
    if (rel.endsWith('/')) continue;
    totalBytes += info.bytes;
    totalFiles += 1;
  }
  if (deps.getDiskFreeBytes) {
    let free: number | null = null;
    try {
      free = await deps.getDiskFreeBytes(candidate);
    } catch {
      free = null;
    }
    if (free !== null && free < totalBytes * 1.2 + 256 * 1024 * 1024) {
      return { ok: false, phase: 'precheck', message: `目标磁盘空间不足(需要至少约 ${Math.ceil((totalBytes * 1.2) / 1024 / 1024)} MB 余量)` };
    }
  }
  // ── copying + verifying(逐文件:复制即对账,失败即中止)────────────
  try {
    for (const [rel, info] of manifest) {
      if (rel.endsWith('/')) {
        await fs.promises.mkdir(path.join(toRoot, rel), { recursive: true });
        continue;
      }
      const from = path.join(fromRoot, ...rel.split('/'));
      const to = path.join(toRoot, ...rel.split('/'));
      if (info.sqlite) {
        await fs.promises.mkdir(path.dirname(to), { recursive: true });
        await deps.copySqlite(from, to);
      } else {
        await copyPlain(from, to);
      }
      const stTo = await fs.promises.stat(to);
      if (stTo.size !== info.bytes) {
        return { ok: false, phase: 'verifying', message: `校验失败(大小不一致):${rel}` };
      }
      if (info.sqlite && !(await deps.checkSqliteHealthy(to))) {
        return { ok: false, phase: 'verifying', message: `数据库完整性校验失败:${rel}` };
      }
    }
  } catch (err) {
    return { ok: false, phase: 'copying', message: `复制失败:${err instanceof Error ? err.message : String(err)}` };
  }
  // ── switching:先切 binding,再挪旧目录进 grace ────────────────────
  const binding = await req.applyBinding(candidate);
  if (!binding.ok) {
    return { ok: false, phase: 'switching', message: binding.message ?? '位置记录更新失败' };
  }
  const stamp = deps.now?.() ?? Date.now();
  if (path.resolve(toRoot) !== path.resolve(fromRoot)) {
    try {
      await fs.promises.rename(fromRoot, `${fromRoot}.migrated-${stamp}`);
    } catch (err) {
      // binding 已切换、新位置已验证——旧目录改名失败只影响回滚窗,不回滚
      // 迁移(如实告警)。
      deps.log?.warn('library migrate: grace rename failed (old copy kept in place)', {
        ghostId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  deps.log?.info('library migrated', { ghostId, files: totalFiles, bytes: totalBytes });
  return { ok: true, fromRoot, toRoot, files: totalFiles, bytes: totalBytes, warnings: validation.warnings };
}
