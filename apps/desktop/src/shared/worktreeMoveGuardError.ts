import { extractIpcError } from './ipcError';

/**
 * 共享写路径拒绝「worktree 会话被移出绑定根」时使用的错误码与文案。
 *
 * 归属判定只有主进程一处权威（`main/localDb/ipc/sessions.ts` 的 `updateSessionInDb`
 * 守卫）。renderer 曾用异步镜像做过预检，但任何「先查询、再决定」都关不掉「查询通过后、
 * 写入前恰好回收」的竞态：缓存或复核拿到旧绑定时会把主进程本会放行的移动挡在请求之前，
 * 用户只能重试。因此 renderer 不再自行判定，只按这条错误识别「被归属守卫拒绝」，并复用
 * 同一条提示文案 —— 拦截与反馈都以共享写路径为准。
 */
export const WORKTREE_MOVE_BLOCKED_CODE = 'PRECONDITION_FAILED';

export const WORKTREE_MOVE_BLOCKED_MESSAGE =
  'A worktree session cannot be moved outside its worktree; worktree handoff is required';

/**
 * `extractIpcError` 对同一形状有两种返回：`isIpcError` 分支原样给出 `Error.message`
 * （仍带 `[CODE] ` 前缀），message 正则分支给的是去掉前缀的正文。统一按后者比较。
 */
function stripCodePrefix(message: string): string {
  return message.replace(/^\[[A-Z0-9_]+\]\s*/, '').trim();
}

/**
 * 判断错误是否来自 worktree 归属守卫。`PRECONDITION_FAILED` 也被其它守卫复用，所以必须
 * 同时匹配文案，避免把别的失败说成「worktree 会话不能移出」。
 */
export function isWorktreeMoveBlockedError(err: unknown): boolean {
  const ipcError = extractIpcError(err);
  return (
    ipcError?.code === WORKTREE_MOVE_BLOCKED_CODE &&
    stripCodePrefix(ipcError.message) === WORKTREE_MOVE_BLOCKED_MESSAGE
  );
}

/** 移动失败时该给用户的反馈：warning 是「产品暂不支持」的说明，error 是通用报错。 */
export interface SessionMoveFailureFeedback {
  level: 'warning' | 'error';
  key: string;
}

/**
 * 「移动到项目 / 移动到对话」失败后的提示选择。「移到对话」不改 workingDir，不会触发
 * 归属守卫；只有改目录的移动才可能命中它，这时用专门的说明而不是笼统的「移动失败」。
 */
export function sessionMoveFailureFeedback(
  moveKind: string,
  err: unknown,
): SessionMoveFailureFeedback {
  if (moveKind !== 'dialogue' && isWorktreeMoveBlockedError(err)) {
    return {
      level: 'warning',
      key: 'ccAgent.sidebar.sessionMenu.moveToProjectWorktreeBlocked',
    };
  }
  return {
    level: 'error',
    key:
      moveKind === 'dialogue'
        ? 'ccAgent.sidebar.sessionMenu.moveToDialogueFailed'
        : 'ccAgent.sidebar.sessionMenu.moveToProjectFailed',
  };
}
