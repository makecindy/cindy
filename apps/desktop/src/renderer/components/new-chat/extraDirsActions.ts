/**
 * 引用目录(extra dirs)增删逻辑 —— 从旧 ExtraDirsButton 菜单中抽出,供统一
 * composer 建议面板的「添加目录…」动作与目录列表行复用。
 *
 * 校验:选中路径与 workingDir 重叠时:子目录静默去重;父目录弹 confirm。
 * main 端 extraDirsValidator.ts 兜底 — 这里只做 UX 预判。
 */

import { createLogger } from '@/lib/logger';
import { stripTrailingPathSeparators } from '../../../shared/pathText';
import { normalizeWorkingDirForStorage } from '../../../shared/workingDir';

const log = createLogger('ExtraDirsActions');

/** 与 main 端 EXTRA_DIRS_MAX 保持一致;UI 满了 disable 添加入口。 */
export const MAX_EXTRA_DIRS = 10;

function normalizedPathForComparison(raw: string | null | undefined): string | null {
  const normalized = normalizeWorkingDirForStorage(raw);
  return normalized ? stripTrailingPathSeparators(normalized) : null;
}

/**
 * 判断 candidate 是否是 base 自身或子目录(简单字符串前缀,跨平台够用 —— main 端
 * extraDirsValidator 用 path.relative 做权威判定)。
 */
function isSelfOrSubdir(candidate: string, base: string): boolean {
  const c = normalizedPathForComparison(candidate);
  const b = normalizedPathForComparison(base);
  if (!c || !b) return false;
  if (c === b) return true;
  return c.startsWith(b + '/');
}

function isSameStoragePath(a: string, b: string): boolean {
  const normalizedA = normalizedPathForComparison(a);
  const normalizedB = normalizedPathForComparison(b);
  return !!normalizedA && !!normalizedB && normalizedA === normalizedB;
}

function hasExtraDir(extraDirs: readonly string[], candidate: string): boolean {
  return extraDirs.some((existing) => isSameStoragePath(existing, candidate));
}

/** candidate 是 base 父目录或祖先(反过来:base 是 candidate 的子目录)。 */
function isParentOrAncestor(candidate: string, base: string): boolean {
  const c = normalizedPathForComparison(candidate);
  const b = normalizedPathForComparison(base);
  if (!c || !b || c === b) return false;
  return isSelfOrSubdir(b, c);
}

export const __extraDirsPathOverlapForTesting = {
  hasExtraDir,
  isParentOrAncestor,
  isSelfOrSubdir,
};

/** 取目录名做行内显示;空回 '/' 。 */
export function extraDirBasename(p: string): string {
  const stripped = stripTrailingPathSeparators(p);
  const parts = stripped.split(/[\\/]/);
  return parts[parts.length - 1] || stripped || '/';
}

export interface PickAndAddExtraDirOptions {
  extraDirs: readonly string[];
  /** 另一授权组中的目录；用于总上限与跨组去重。 */
  otherDirs?: readonly string[];
  workingDir?: string | null;
  /** 本机可写目录由 Main picker 绑定到当前任务；只读引用目录不传。 */
  writableGrantScope?: string;
  onChange: (next: string[]) => void | Promise<void>;
  /** ConfirmDialogProvider 的 confirm(父目录警告)。 */
  confirm: (opts: {
    title: string;
    description: string;
    confirmText: string;
    cancelText: string;
  }) => Promise<boolean>;
  parentDirectoryConfirm: {
    title: string;
    description: (path: string) => string;
    confirmText: string;
    cancelText: string;
  };
}

/**
 * 打开系统目录选择器并把结果并入 extraDirs(带 UX 预判)。
 * 上限判断由调用方负责(达到 MAX_EXTRA_DIRS 时入口应 disabled)。
 */
export async function pickAndAddExtraDir({
  extraDirs,
  otherDirs = [],
  workingDir,
  writableGrantScope,
  onChange,
  confirm,
  parentDirectoryConfirm,
}: PickAndAddExtraDirOptions): Promise<void> {
  if (extraDirs.length + otherDirs.length >= MAX_EXTRA_DIRS) return;
  let picked: string | null = null;
  try {
    const r = await window.electronAPI.dialog.showOpenDirectory(
      writableGrantScope ? { writableGrantScope } : {},
    );
    picked = r?.success ? r.path : null;
  } catch (e) {
    log.warn('showOpenDirectory failed', { error: String(e) });
    return;
  }
  const normalizedPicked = normalizeWorkingDirForStorage(picked);
  if (!normalizedPicked) return;

  // UX 预判: 完全重复 / 是 workingDir 子目录 → 静默忽略(main validator 也会兜)。
  if (hasExtraDir([...extraDirs, ...otherDirs], normalizedPicked)) return;
  if (workingDir && isSelfOrSubdir(normalizedPicked, workingDir)) {
    log.debug('add: silently skipped (subdir of workingDir)', {
      picked: normalizedPicked,
      workingDir,
    });
    return;
  }

  // 父目录 / 祖先警告 — 通过则继续。
  if (workingDir && isParentOrAncestor(normalizedPicked, workingDir)) {
    const ok = await confirm({
      title: parentDirectoryConfirm.title,
      description: parentDirectoryConfirm.description(normalizedPicked),
      confirmText: parentDirectoryConfirm.confirmText,
      cancelText: parentDirectoryConfirm.cancelText,
    });
    if (!ok) return;
  }

  await onChange([...extraDirs, normalizedPicked]);
}
