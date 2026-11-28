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

/**
 * 新建任务时 `base_ref` 入参的共同判定（本机创建、跨电脑发送端与接收端共用）。
 *
 * 基线只对同时新建的 worktree 有意义：没开 `use_worktree` 时拒绝而不是忽略，否则调用方以为
 * 任务在点名的分支上，实际落在共享工作树的当前分支。省略时原样通过，由调用方走默认基线。
 */
export function checkWorktreeBaseRefArg(
  baseRef: string | undefined,
  useWorktree: boolean | undefined,
): { ok: true; value: string | undefined } | { ok: false; message: string } {
  if (baseRef === undefined) return { ok: true, value: undefined };
  if (!useWorktree) return { ok: false, message: 'base_ref requires use_worktree=true.' };
  const checked = checkWorktreeSourceRef(baseRef);
  return checked.ok
    ? { ok: true, value: checked.value }
    : { ok: false, message: `base_ref ${checked.message}.` };
}
