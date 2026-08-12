/**
 * dialogueWorkdirSelfHeal — 无文件夹对话(dialogue)工作目录的自愈逻辑。
 *
 * 背景:dialogue 会话的 cwd 是 app 托管的一次性目录
 * `<userData>/dialogues/<YYYY-MM-DD>/<sessionId>`(见 dialogueWorkspace.ts)。
 * 两类场景会让 DB 里记录的路径在磁盘上消失,导致发消息撞 WORKDIR_MISSING:
 *  1. 身份翻转(2026-07-17)后 userData 从 `xdt-maker` 变为 `Cindy`,mToc 首登
 *     迁移只搬库/媒体,不改写 sessions.working_dir,老 dialogue 会话全部指向
 *     已消失的老目录(2026-07 实报:近 300 条会话发不了消息);
 *  2. 用户/清理工具删掉了 dialogues 下的某个日期桶。
 *
 * 两段自愈:
 *  - sweep(启动期,db ready 后 await 一次):把 legacy userData 前缀的 dialogue
 *    路径批量改写到当前 userData,幂等,改写后不再命中;
 *  - lazy heal(发送期,checkWorkDirExists ENOENT 分支):路径命中当前 dialogues
 *    根且形状合法时直接 mkdir -p 重建放行——这类目录本来就是 app 造的空目录,
 *    重建无副作用。
 *
 * 只认严格形状 `<root>/<YYYY-MM-DD>/<单段id>`,绝不触碰用户自选的 project 目录。
 * 可测试性(规则 14):全部依赖注入,不 import electron。
 */

import path from 'node:path';
import fsp from 'node:fs/promises';

import { normalizeWorkingDirForStorage } from '../../shared/workingDir.js';

/** dialogue 日期桶目录名(本地时区,见 dialogueWorkspaceDayKey)。 */
const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** userData 下 dialogue 根目录名(与 dialogueWorkspace.ts 保持一致)。 */
export const DIALOGUES_DIR_NAME = 'dialogues';

export interface DialogueWorkspacePathMatch {
  /** 日期桶,如 `2026-06-22`。 */
  dayKey: string;
  /** 目录末段(创建时等于 sessionId;fork 会话可能是父会话 id,不强校验)。 */
  sessionIdSegment: string;
}

/**
 * 判断 workingDir 是否是 `<dialoguesRoot>/<YYYY-MM-DD>/<单段>` 的 app 托管
 * dialogue 工作目录。用 path.relative 做前缀判断,天然处理平台分隔符与
 * Windows 大小写;形状不符(多层/越界/日期不合法)一律返回 null。
 */
export function matchDialogueWorkspacePath(
  workingDir: string,
  dialoguesRoot: string,
): DialogueWorkspacePathMatch | null {
  if (!workingDir || !dialoguesRoot) return null;
  const rel = path.relative(dialoguesRoot, workingDir);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  const segments = rel.split(path.sep);
  if (segments.length !== 2) return null;
  const [dayKey, sessionIdSegment] = segments;
  if (!DAY_KEY_RE.test(dayKey)) return null;
  if (!sessionIdSegment || sessionIdSegment === '.' || sessionIdSegment === '..') return null;
  return { dayKey, sessionIdSegment };
}

/**
 * 由当前 userData 推导 legacy userData 的 dialogues 根列表
 * (同级目录 `<parent>/<legacyName>/dialogues`,legacyName 来自 BRAND_IDENTITY)。
 */
export function buildLegacyDialogueRoots(
  userDataDir: string,
  legacyUserDataDirNames: readonly string[],
): string[] {
  const parent = path.dirname(userDataDir);
  return legacyUserDataDirNames
    .map((name) => path.join(parent, name, DIALOGUES_DIR_NAME))
    .filter((root) => root !== path.join(userDataDir, DIALOGUES_DIR_NAME));
}

export interface HealMissingDialogueWorkdirDeps {
  /** mkdir -p;注入以便单测,默认真实 fs。 */
  mkdirp?: (dir: string) => Promise<void>;
}

/**
 * lazy heal:workingDir 命中当前 dialogues 根的合法形状时,mkdir -p 原路径
 * 重建并返回 true;否则返回 false(交还调用方走原 WORKDIR_MISSING 流程)。
 * mkdir 失败(权限/只读盘)返回 false,不抛——这是错误兜底路径。
 */
export async function healMissingDialogueWorkdir(
  workingDir: string,
  dialoguesRoot: string,
  deps: HealMissingDialogueWorkdirDeps = {},
): Promise<boolean> {
  const match = matchDialogueWorkspacePath(workingDir, dialoguesRoot);
  if (!match) return false;
  const mkdirp =
    deps.mkdirp ??
    (async (dir: string) => {
      await fsp.mkdir(dir, { recursive: true });
    });
  try {
    await mkdirp(workingDir);
    return true;
  } catch {
    return false;
  }
}

/** sweep 需要的最小 DB 面(DbClient 子集,全异步)。 */
export interface DialogueSweepDb {
  query<T = unknown>(sql: string, params?: unknown[]): Promise<T[]>;
  exec(sql: string, params?: unknown[]): Promise<{ changes: number; lastInsertRowid: number | bigint }>;
}

export interface SweepLegacyDialogueWorkingDirsDeps {
  db: DialogueSweepDb;
  /** 当前 userData 绝对路径。 */
  userDataDir: string;
  /** 当前区域的历史 dialogue userData 目录名候选。 */
  legacyUserDataDirNames: readonly string[];
  /** Explicit current owner dialogue root; defaults to userDataDir/dialogues. */
  currentDialoguesRoot?: string;
  /** Extra old roots, such as the pre-owner-namespace userData/dialogues path. */
  additionalLegacyDialogueRoots?: readonly string[];
  log: {
    info(message: string, fields?: Record<string, unknown>): void;
    warn(message: string, fields?: Record<string, unknown>): void;
  };
  /** 路径存在探测;注入以便单测,默认真实 fs。 */
  pathExists?: (p: string) => Promise<boolean>;
  /** 递归复制目录(不覆盖已存在文件);注入以便单测,默认 fsp.cp。 */
  copyDir?: (src: string, dest: string) => Promise<void>;
}

export interface SweepLegacyDialogueWorkingDirsResult {
  /** LIKE 初筛候选行数。 */
  scanned: number;
  /** 同步阶段实际改写行数(不含转入后台的行)。 */
  rewritten: number;
  /** 需要内容搬运而转入后台的行数(copy→rewrite 在后台串行完成)。 */
  deferred: number;
  /**
   * 后台搬运完成信号(内部已捕获所有错误,绝不 reject)。调用方可以不 await
   * ——转入后台的行老目录仍在,改写前会话按老路径照常工作;测试与诊断用。
   */
  background: Promise<{ copied: number; rewritten: number }>;
}

type LegacySessionRow = { id: string; working_dir: string };

/**
 * 启动 sweep:把 sessions.working_dir 里 legacy userData 前缀的 dialogue 路径
 * 批量改写为当前 userData 前缀(保留日期桶与末段)。幂等——改写后不再命中
 * legacy 前缀。只改 working_dir,不动 updated_at(避免会话列表被动重排)。
 *
 * 内容保全:改写前若老目录仍在磁盘上而新位置缺失,先递归复制内容再改写
 * (agent 可能在 dialogue cwd 里写过真实文件;mToc 首登迁移已复制过 dialogues
 * 的用户此处探测到新位置已存在,直接改写)。复制失败则跳过该行(下次启动
 * 重试),绝不让改写把仍然存在的内容孤儿化;老目录已消失的行直接改写,目录
 * 材料化交给发送期的 lazy heal(healMissingDialogueWorkdir)。
 *
 * 阻塞边界:调用方在 ensure-ready IPC 返回前 await 本函数,因此**同步阶段只做
 * 廉价工作**(一条 LIKE 查询 + 每行两次 stat + 纯改写行的 UPDATE);需要递归
 * 复制内容的行全部转入后台串行处理(copy→rewrite),不阻塞登录。转入后台的
 * 行在改写前仍指向存在的老目录,会话照常可用,正确性不依赖后台完成时机。
 *
 * SQL LIKE 初筛只做候选收敛(`%`/`_` 通配只会多选不会漏选),真正的精确判定
 * 由 matchDialogueWorkspacePath 在 JS 侧完成,因此无需 ESCAPE 处理。
 * 远端会话(remote_host_id 非空)的 cwd 在远端机器上,永不触碰。
 */
export async function sweepLegacyDialogueWorkingDirs(
  deps: SweepLegacyDialogueWorkingDirsDeps,
): Promise<SweepLegacyDialogueWorkingDirsResult> {
  const pathExists =
    deps.pathExists ??
    (async (p: string) => {
      try {
        await fsp.access(p);
        return true;
      } catch {
        return false;
      }
    });
  const copyDir =
    deps.copyDir ??
    (async (src: string, dest: string) => {
      // force:false + errorOnExist:false = 不覆盖已存在文件(merge 语义)。
      await fsp.cp(src, dest, { recursive: true, force: false, errorOnExist: false });
    });
  const rewriteRow = async (row: LegacySessionRow, healedDir: string): Promise<number> => {
    try {
      const result = await deps.db.exec(
        'UPDATE sessions SET working_dir = ? WHERE id = ?',
        [healedDir, row.id],
      );
      return result.changes;
    } catch (err) {
      deps.log.warn('dialogue workdir sweep: rewrite failed (non-fatal)', {
        sessionId: row.id,
        workingDir: row.working_dir,
        error: err instanceof Error ? err.message : String(err),
      });
      return 0;
    }
  };

  const currentRoot = deps.currentDialoguesRoot ?? path.join(deps.userDataDir, DIALOGUES_DIR_NAME);
  const legacyRoots = [
    ...buildLegacyDialogueRoots(deps.userDataDir, deps.legacyUserDataDirNames),
    ...(deps.additionalLegacyDialogueRoots ?? []),
  ].filter((root, index, roots) => root !== currentRoot && roots.indexOf(root) === index);
  let scanned = 0;
  let rewritten = 0;
  const needsCopy: Array<{ row: LegacySessionRow; healedDir: string }> = [];
  for (const legacyRoot of legacyRoots) {
    // DB 里的 working_dir 是 storage 规范形(Windows 反斜杠已归一为 `/`,见
    // normalizeWorkingDirForStorage),LIKE 前缀必须用同一形态才能命中。
    const legacyRootStored = normalizeWorkingDirForStorage(legacyRoot);
    if (!legacyRootStored) continue;
    const rows = await deps.db.query<LegacySessionRow>(
      `SELECT id, working_dir FROM sessions
        WHERE remote_host_id IS NULL AND working_dir LIKE ?`,
      [`${legacyRootStored}/%`],
    );
    scanned += rows.length;
    for (const row of rows) {
      const match = matchDialogueWorkspacePath(row.working_dir, legacyRoot);
      if (!match) continue;
      const healedDir = normalizeWorkingDirForStorage(
        path.join(currentRoot, match.dayKey, match.sessionIdSegment),
      );
      if (!healedDir) continue;
      if (!(await pathExists(healedDir)) && (await pathExists(row.working_dir))) {
        needsCopy.push({ row, healedDir });
        continue;
      }
      rewritten += await rewriteRow(row, healedDir);
    }
  }
  // 需要内容搬运的行转后台串行处理:不阻塞 ensure-ready,失败下次启动重试。
  const background = (async () => {
    let copied = 0;
    let bgRewritten = 0;
    for (const { row, healedDir } of needsCopy) {
      try {
        await copyDir(row.working_dir, healedDir);
        copied += 1;
      } catch (err) {
        deps.log.warn('dialogue workdir sweep: content copy failed, skip row this round', {
          sessionId: row.id,
          workingDir: row.working_dir,
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }
      bgRewritten += await rewriteRow(row, healedDir);
    }
    if (copied > 0 || bgRewritten > 0) {
      deps.log.info('dialogue workdir sweep: background content moves completed', {
        deferred: needsCopy.length,
        copied,
        rewritten: bgRewritten,
      });
    }
    return { copied, rewritten: bgRewritten };
  })();
  if (rewritten > 0 || needsCopy.length > 0) {
    deps.log.info('dialogue workdir sweep: legacy paths processed', {
      scanned,
      rewritten,
      deferred: needsCopy.length,
      legacyRoots,
    });
  }
  return { scanned, rewritten, deferred: needsCopy.length, background };
}
