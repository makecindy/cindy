import path from 'node:path';

import { getDbClient } from './client/current.js';
import { dialogueWorkspaceRootDir } from './dialogueWorkspace.js';
import { normalizeWorkingDirForStorage } from '../../shared/workingDir.js';

export function normalizeHistoryWorkingDir(raw: string | null | undefined): string | null {
  return normalizeWorkingDirForStorage(raw);
}

/** LIKE 模式转义: % / _ / 转义符本身, 配合 `ESCAPE '!'` 使用。 */
export function escapeLikePattern(value: string): string {
  return value.replace(/[!%_]/g, (m) => `!${m}`);
}

/**
 * app-managed dialogue 子树的 LIKE 排除模式(`<root><sep>%`, 正/反斜杠两种历史
 * 形态)。模式带路径分隔符边界——裸 `<root>%` 会把 `<root>-project` 这类相邻
 * 真实目录一并误排(greptile P1)。只匹配 root 的子路径;root 本身不会作为会话
 * workingDir 出现(managed cwd 固定是 <root>/<day>/<sessionId>)。
 */
export function managedDialogueRootLikePatterns(): string[] {
  const rawRoot = dialogueWorkspaceRootDir();
  const patterns = new Set<string>([`${escapeLikePattern(rawRoot)}${path.sep}%`]);
  const normRoot = normalizeWorkingDirForStorage(rawRoot);
  if (normRoot) patterns.add(`${escapeLikePattern(normRoot)}/%`);
  // 显式正斜杠变体兜底:win32 的 path.join 会把无盘符的 root(如测试 mock 的
  // POSIX 形态 userData)拼成反斜杠,而这种路径过不了归一化的 Windows 判定,
  // 上面两个模式双双落空——补一个强制 / 形态,mac 上与 normRoot 重合被 Set 去重。
  patterns.add(`${escapeLikePattern(rawRoot.replace(/\\/g, '/'))}/%`);
  return [...patterns];
}

/** 归一后的目录是否落在 app-managed dialogue root 之下。 */
function isUnderManagedDialogueRoot(normalizedDir: string): boolean {
  // 强制 / 形态再比:win32 的 path.join 对无盘符 root(测试 mock 的 POSIX
  // userData)产出反斜杠拼写,归一化的 Windows 判定认不出——与
  // managedDialogueRootLikePatterns 的兜底同一口径。
  const normRoot = (normalizeWorkingDirForStorage(dialogueWorkspaceRootDir()) ?? '').replace(/\\/g, '/');
  if (!normRoot) return false;
  return normalizedDir === normRoot || normalizedDir.startsWith(`${normRoot}/`);
}

/**
 * 解析目标目录在 sessions 表中实际存在的全部历史拼写,供 `IN (...)` 精确下推。
 *
 * 以「DB distinct working_dir + normalizeWorkingDirForStorage 相等」为准——与
 * listWorkdirsForHistory 的合组 key 用同一归一函数,保证「分组计数」与「按目录
 * 取会话 / 搜索」两条读路径对同一物理目录永远给出一致集合。旧实现按规则枚举
 * 变体(正/反斜杠、long-path 前缀),穷举不了尾斜杠等历史遗留形态,分组计数
 * 会大于点开后实际取到的会话数(PR #542 review)。
 *
 * 有界性(Codex review):distinct 扫描排除 app-managed dialogue 子树——那是
 * 每会话一目录的无界增长源,排除后剩余集合是用户项目数量级(几十到几百)。
 * 目标目录本身在 managed root 下时走等值探测快路径:managed cwd 由
 * path.join 代码生成、同机拼写唯一,不存在 slash-variant 并存,原样 + 归一
 * 两个探针足以命中。
 *
 * 返回空数组 ⟺ 输入为空 / 库里不存在该目录的任何拼写,调用方应直接返回空结果。
 */
export async function resolveStoredWorkingDirCandidates(
  raw: string | null | undefined,
): Promise<string[]> {
  const original = typeof raw === 'string' ? raw : '';
  const target = normalizeWorkingDirForStorage(original);
  if (!target) return [];

  if (isUnderManagedDialogueRoot(target)) {
    const probes = [...new Set([original, target])];
    const rows = await getDbClient().query<{ workingDir: string | null }>(
      `SELECT DISTINCT working_dir AS workingDir FROM sessions
        WHERE working_dir IN (${probes.map(() => '?').join(',')})`,
      probes,
    );
    return rows
      .map((row) => row.workingDir)
      .filter((stored): stored is string => typeof stored === 'string');
  }

  const exclusions = managedDialogueRootLikePatterns();
  const rows = await getDbClient().query<{ workingDir: string | null }>(
    `SELECT DISTINCT working_dir AS workingDir FROM sessions
      WHERE working_dir IS NOT NULL
        ${exclusions.map(() => "AND working_dir NOT LIKE ? ESCAPE '!'").join('\n        ')}`,
    exclusions,
  );
  const out = new Set<string>();
  for (const row of rows) {
    const stored = row.workingDir;
    if (typeof stored === 'string' && normalizeWorkingDirForStorage(stored) === target) {
      out.add(stored);
    }
  }
  return [...out];
}
