/**
 * Cindy 托管 worktree 的分支命名事实源。
 *
 * 新建分支统一写入 `cindy/<name>`；升级前创建的 `xdt/<name>` 永久保留读取兼容，
 * 现有分支不要求改名。这里仅管理 worktree 分支，不涉及 `refs/xdt/*` 快照引用。
 */
export const MANAGED_WORKTREE_BRANCH_PREFIX = 'cindy';
export const LEGACY_MANAGED_WORKTREE_BRANCH_PREFIX = 'xdt';

export const MANAGED_WORKTREE_BRANCH_PREFIXES = [
  MANAGED_WORKTREE_BRANCH_PREFIX,
  LEGACY_MANAGED_WORKTREE_BRANCH_PREFIX,
] as const;

/** 当前写入前缀本身若已是分支，Git 无法再创建其下任何 `cindy/*` ref。 */
export function blocksManagedWorktreeBranchNamespace(branch: string): boolean {
  return branch === MANAGED_WORKTREE_BRANCH_PREFIX;
}

/**
 * 返回某条现有分支占用的新 Worktree 名。
 *
 * 当前前缀下的后代 ref（如 `cindy/foo/bar`）会阻止创建 `cindy/foo`，因此
 * 预留首个路径段；旧前缀只把精确的 `xdt/<name>` 视为恢复候选，嵌套 ref
 * 不会与新写入的 `cindy/<name>` 形成层级冲突。
 */
export function getManagedWorktreeReservedName(branch: string): string | null {
  const currentMarker = `${MANAGED_WORKTREE_BRANCH_PREFIX}/`;
  if (branch.startsWith(currentMarker)) {
    return branch.slice(currentMarker.length).split('/')[0] || null;
  }

  const legacyMarker = `${LEGACY_MANAGED_WORKTREE_BRANCH_PREFIX}/`;
  if (branch.startsWith(legacyMarker)) {
    const name = branch.slice(legacyMarker.length);
    return name && !name.includes('/') ? name : null;
  }
  return null;
}

/** 新建 Cindy 托管 worktree 使用的分支名。 */
export function getBranchName(name: string): string {
  return `${MANAGED_WORKTREE_BRANCH_PREFIX}/${name}`;
}

/** 按优先级列出当前与历史托管分支候选。 */
export function getManagedWorktreeBranchCandidates(name: string): string[] {
  return MANAGED_WORKTREE_BRANCH_PREFIXES.map((prefix) => `${prefix}/${name}`);
}

/** 从当前或历史托管分支中解析 worktree 名；其它分支返回 null。 */
export function getManagedWorktreeNameFromBranch(branch: string): string | null {
  for (const prefix of MANAGED_WORKTREE_BRANCH_PREFIXES) {
    const marker = `${prefix}/`;
    if (branch.startsWith(marker) && branch.length > marker.length) {
      const name = branch.slice(marker.length);
      // Worktree name 永远是单个合法路径段。`cindy/foo/bar` 仅是会阻塞
      // `cindy/foo` 的 ref 后代，`xdt/foo/bar` 则只是普通 legacy 命名空间分支；
      // 两者都不是托管 Worktree 的精确分支。
      return name.includes('/') ? null : name;
    }
  }
  return null;
}

/** 判断分支是否是指定名字对应的当前或历史自动生成分支。 */
export function isManagedWorktreeBranchForName(branch: string, name: string): boolean {
  return getManagedWorktreeBranchCandidates(name).includes(branch);
}
