/**
 * 显式指定 worktree 源分支的共同校验。
 *
 * 桌面新建任务的分支选择、Worker 的 `source_branch`、Agent 的 `create_task_worktree`
 * `base_ref` 走同一份判定：源分支会原样进入 git 命令的参数位（`git worktree add …
 * <sourceBranch>`、`git rev-parse --verify <sourceBranch>^{commit}`），因此必须挡住
 * 以 `-` 开头的选项注入形态与控制字符。其余合法性（引用是否真实存在）交给 git 解析，
 * 解析失败即报错，不静默回退默认分支。
 */

/** 源分支长度上限。 */
export const MAX_WORKTREE_SOURCE_REF_LENGTH = 1024;

export type WorktreeSourceRefCheck =
  | { ok: true; value: string }
  | { ok: false; message: string };

/**
 * 校验并归一化一个显式源分支。成功时返回去空白后的值；失败时给出可直接透给调用方的原因。
 */
export function checkWorktreeSourceRef(ref: string | null | undefined): WorktreeSourceRefCheck {
  if (typeof ref !== 'string') return { ok: false, message: 'source branch must be a string' };
  const value = ref.trim();
  if (!value) return { ok: false, message: 'source branch must not be empty' };
  if (value.length > MAX_WORKTREE_SOURCE_REF_LENGTH) {
    return {
      ok: false,
      message: `source branch must be at most ${MAX_WORKTREE_SOURCE_REF_LENGTH} characters`,
    };
  }
  // 以 `-` 开头会被 git 当成选项而不是引用。
  if (value.startsWith('-')) return { ok: false, message: 'source branch must not start with "-"' };
  if (Array.from(value).some((character) => character.charCodeAt(0) < 32)) {
    return { ok: false, message: 'source branch must not contain control characters' };
  }
  return { ok: true, value };
}
