import { describe, expect, it } from 'vitest';

import { createIpcError } from '../ipc-errors';
import {
  isWorktreeMoveBlockedError,
  sessionMoveFailureFeedback,
  WORKTREE_MOVE_BLOCKED_CODE,
  WORKTREE_MOVE_BLOCKED_MESSAGE,
} from '../worktreeMoveGuardError';

describe('isWorktreeMoveBlockedError', () => {
  it('recognises the guard error in both IPC shapes', () => {
    // 主进程 throwIpcError 的原样形状（同进程调用，如 MCP 工具）。
    expect(
      isWorktreeMoveBlockedError(
        createIpcError(WORKTREE_MOVE_BLOCKED_CODE, WORKTREE_MOVE_BLOCKED_MESSAGE),
      ),
    ).toBe(true);

    // 跨 IPC 后 Electron 只保留 message 前缀，code 从 `[CODE]` 里解出来。
    const overIpc = new Error(
      `Error invoking remote method 'session:update': Error: [${WORKTREE_MOVE_BLOCKED_CODE}] ${WORKTREE_MOVE_BLOCKED_MESSAGE}`,
    );
    expect(isWorktreeMoveBlockedError(overIpc)).toBe(true);

    // 文案尾随换行等噪声不影响判定。
    expect(
      isWorktreeMoveBlockedError(
        new Error(`[${WORKTREE_MOVE_BLOCKED_CODE}] ${WORKTREE_MOVE_BLOCKED_MESSAGE}\n`),
      ),
    ).toBe(true);
  });

  it('ignores other failures that share the code or the wording', () => {
    // PRECONDITION_FAILED 被多个守卫复用：只按码会把别的失败说成「worktree 会话不能移出」。
    expect(
      isWorktreeMoveBlockedError(createIpcError(WORKTREE_MOVE_BLOCKED_CODE, 'session is running')),
    ).toBe(false);
    expect(
      isWorktreeMoveBlockedError(createIpcError('NOT_FOUND', WORKTREE_MOVE_BLOCKED_MESSAGE)),
    ).toBe(false);
    expect(isWorktreeMoveBlockedError(new Error('plain failure'))).toBe(false);
    expect(isWorktreeMoveBlockedError(undefined)).toBe(false);
    expect(isWorktreeMoveBlockedError(null)).toBe(false);
  });
});

describe('sessionMoveFailureFeedback', () => {
  const blocked = createIpcError(WORKTREE_MOVE_BLOCKED_CODE, WORKTREE_MOVE_BLOCKED_MESSAGE);

  it('explains a rejected cross-root move instead of a generic failure', () => {
    expect(sessionMoveFailureFeedback('project', blocked)).toEqual({
      level: 'warning',
      key: 'ccAgent.sidebar.sessionMenu.moveToProjectWorktreeBlocked',
    });
    // browseProject 也是改目录的移动，同样命中。
    expect(sessionMoveFailureFeedback('browseProject', blocked).level).toBe('warning');
  });

  it('keeps the existing wording for other failures and for dialogue moves', () => {
    expect(sessionMoveFailureFeedback('project', new Error('boom'))).toEqual({
      level: 'error',
      key: 'ccAgent.sidebar.sessionMenu.moveToProjectFailed',
    });
    // 「移到对话」不改 workingDir，即使拿到同码错误也不该说成「不能移出 worktree」。
    expect(sessionMoveFailureFeedback('dialogue', blocked)).toEqual({
      level: 'error',
      key: 'ccAgent.sidebar.sessionMenu.moveToDialogueFailed',
    });
  });
});
