/**
 * extraDirs (附加只读引用目录) 校验 — main 端兜底。
 *
 * renderer 在 popover 里加目录时已经走 dialog.showOpenDirectory 拿绝对路径,
 * 又会本地预判"是否 workingDir 父/祖目录"弹 confirmDialog, 但任何来自 IPC 的
 * extraDirs 数组进来都要在这里再过一遍 —— 防止 renderer bug / 老 DB 残留 /
 * 直接调 IPC 的脚本传脏数据。
 *
 * 校验规则按顺序执行 (任何一条 reject 都不会进 valid):
 *   1. 空串 / trim 后为空 → reject 'empty'
 *   2. 不是绝对路径           → reject 'not-absolute'
 *   3. 完全重复 (字符串相等) → 静默去重 (不 reject 第一次出现)
 *   4. fs.stat 失败 / 不是目录 → reject 'not-exist' / 'not-dir'
 *   5. 是 workingDir 自身或子目录 → reject 'redundant-subdir' (静默去重语义)
 *   6. 超过上限 10 → reject 'over-limit'
 *
 * "父目录/祖先" 不在这里挡 — UI 已经弹 confirmDialog 警告过, 通过则放行。
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { createLogger } from '../logger.js';

const log = createLogger('extra-dirs-validator');

export const EXTRA_DIRS_MAX = 10;

export interface ValidateResult {
  /** 通过校验, 实际可用的绝对路径列表 (去重后, 顺序保留首次出现) */
  valid: string[];
  /** 被拒掉的条目, 含原因 — main 只 log; UI 也不会展示 (理论上 UI 已经预判过) */
  rejected: Array<{ path: string; reason: ValidateRejectReason }>;
}

export type ValidateRejectReason =
  | 'empty'
  | 'not-absolute'
  | 'not-exist'
  | 'not-dir'
  | 'redundant-subdir'
  | 'over-limit';

/**
 * 判断 candidate 是否是 base 自身或其子目录。
 * 走 path.relative — 跨 \/、不同盘符 (Windows) 都能正确处理。
 */
function isSelfOrSubdir(candidate: string, base: string): boolean {
  const rel = path.relative(base, candidate);
  // 同一个目录 → '' (Windows 也是)
  if (rel === '' || rel === '.') return true;
  // 子目录 → 不以 .. 开头, 也不是绝对路径 (跨盘符时 relative 会返回绝对路径)
  if (rel === '..' || rel.startsWith(`..${path.sep}`)) return false;
  if (path.isAbsolute(rel)) return false;
  return true;
}

export async function validateExtraDirs(
  rawDirs: string[] | undefined | null,
  workingDir: string | undefined | null,
): Promise<ValidateResult> {
  const valid: string[] = [];
  const rejected: ValidateResult['rejected'] = [];

  if (!Array.isArray(rawDirs) || rawDirs.length === 0) {
    return { valid, rejected };
  }

  const seen = new Set<string>();
  const wd = workingDir && workingDir.trim() ? workingDir : null;

  for (const raw of rawDirs) {
    if (typeof raw !== 'string') {
      rejected.push({ path: String(raw), reason: 'empty' });
      continue;
    }
    const dir = raw.trim();
    if (!dir) {
      rejected.push({ path: raw, reason: 'empty' });
      continue;
    }

    if (!path.isAbsolute(dir)) {
      rejected.push({ path: dir, reason: 'not-absolute' });
      continue;
    }

    // 完全重复 — 第一次出现已 push 到 valid; 后续直接静默丢
    if (seen.has(dir)) continue;

    let stat;
    try {
      stat = await fs.stat(dir);
    } catch {
      rejected.push({ path: dir, reason: 'not-exist' });
      continue;
    }
    if (!stat.isDirectory()) {
      rejected.push({ path: dir, reason: 'not-dir' });
      continue;
    }

    // workingDir 子目录 / 自身 — 静默去重 (UI 上不报警, 因为加进来无意义)
    if (wd && isSelfOrSubdir(dir, wd)) {
      rejected.push({ path: dir, reason: 'redundant-subdir' });
      continue;
    }

    if (valid.length >= EXTRA_DIRS_MAX) {
      rejected.push({ path: dir, reason: 'over-limit' });
      continue;
    }

    seen.add(dir);
    valid.push(dir);
  }

  if (rejected.length > 0) {
    log.debug('validateExtraDirs filtered', {
      kept: valid.length,
      rejectedCount: rejected.length,
      reasons: rejected.map((r) => r.reason),
    });
  }

  return { valid, rejected };
}

async function canonicalDirectoryKey(dir: string): Promise<string> {
  try {
    return await fs.realpath(dir);
  } catch {
    return path.resolve(dir);
  }
}

/** 阻止同一实体目录树同时出现在只读与可写授权中（含符号链接别名）。 */
export async function excludeDirectoryGrantConflicts(
  candidates: readonly string[],
  blocked: readonly string[],
): Promise<string[]> {
  if (candidates.length === 0) return [];
  const blockedKeys = await Promise.all(blocked.map(canonicalDirectoryKey));
  const result: string[] = [];
  const acceptedKeys: string[] = [];
  for (const candidate of candidates) {
    const candidateKey = await canonicalDirectoryKey(candidate);
    const overlapsBlockedTree = blockedKeys.some((blockedKey) =>
      isSelfOrSubdir(candidateKey, blockedKey) || isSelfOrSubdir(blockedKey, candidateKey));
    const overlapsAcceptedTree = acceptedKeys.some((acceptedKey) =>
      isSelfOrSubdir(candidateKey, acceptedKey) || isSelfOrSubdir(acceptedKey, candidateKey));
    if (!overlapsBlockedTree && !overlapsAcceptedTree) {
      result.push(candidate);
      acceptedKeys.push(candidateKey);
    }
  }
  return result;
}
