import { stripTrailingPathSeparators } from './pathText.js';

export interface SessionCollaborationLike {
  orcaRole?: 'lead' | 'worker' | string | null;
}

export interface SessionWorktreeLike {
  worktreePath?: string | null;
}

export interface SessionWorkspaceLike {
  workingDir: string | null;
}

export interface SessionWorktreeInfo {
  path: string;
  name: string;
}

export function sessionCollaborationLabel(session: SessionCollaborationLike): string | null {
  if (session.orcaRole === 'lead') return '协作 Lead';
  if (session.orcaRole === 'worker') return '协作 Worker';
  if (typeof session.orcaRole === 'string' && session.orcaRole.trim()) {
    return `协作 ${session.orcaRole.trim()}`;
  }
  return null;
}

export function sessionCollaborationNotice(session: SessionCollaborationLike | null): string | null {
  if (!session) return null;
  if (session.orcaRole === 'lead') {
    return '这是桌面端 Orca Lead 任务。可以在手机上继续发消息聊天;创建 worker、切换 focus、fork/rewind、队列编辑和任务设置等编排操作请在电脑端完成。';
  }
  if (session.orcaRole === 'worker') {
    return '这是桌面端 Orca Worker 任务。手机版第一版只做安全查看,暂不提供发送消息、worker focus、归档 worker 或停止协作。';
  }
  return sessionCollaborationLabel(session)
    ? '这是桌面端协作任务。手机版第一版只做安全查看,协作编排操作请先在电脑端完成。'
    : null;
}

export function isCollaborationSession(session: SessionCollaborationLike | null): boolean {
  return !!session && !!sessionCollaborationLabel(session);
}

/**
 * 写编排操作的只读 reason:对所有协作任务(lead + worker + 其它角色)返回 reason,驱动 fork/rewind、
 * 队列编辑、任务设置写、pending interaction 等高风险写操作的 gating(这些操作 lead 也仍留在电脑端)。
 */
export function sessionCollaborationReadOnlyReason(session: SessionCollaborationLike | null): string | null {
  if (!isCollaborationSession(session)) return null;
  return '协作模式手机版第一版为只读安全降级。处理确认、队列编辑和任务写操作请先在电脑端完成。';
}

/**
 * 输入框(发消息)是否只读:只对**非 lead** 的协作任务(worker / 其它角色)返回 reason;对 Lead 任务
 * 返回 null —— Lead 允许在手机上发文字消息(集中在原对话里继续聊)。普通(非协作)任务也返回 null。
 * 与 sessionCollaborationReadOnlyReason(写编排只读)区分:composer 只读 ≠ 写编排只读。
 */
export function sessionCollaborationComposerReadOnlyReason(session: SessionCollaborationLike | null): string | null {
  if (!isCollaborationSession(session)) return null;
  if (session?.orcaRole === 'lead') return null;
  return '该协作子任务手机版为只读,发送消息请在电脑端完成。';
}

export function sessionWorktreeInfo(session: SessionWorktreeLike): SessionWorktreeInfo | null {
  const path = session.worktreePath?.trim();
  if (!path) return null;
  return {
    path,
    name: basename(path),
  };
}

export function sessionWorktreeLabel(session: SessionWorktreeLike): string | null {
  const info = sessionWorktreeInfo(session);
  return info ? `Worktree ${info.name}` : null;
}

export function sessionWorkspaceTitle(session: SessionWorkspaceLike): string {
  if (!session.workingDir) return 'Dialogue';
  return basename(session.workingDir);
}

function basename(value: string): string {
  const trimmed = stripTrailingPathSeparators(value);
  const parts = trimmed.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || value;
}
