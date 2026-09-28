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

export function isCollaborationSession(session: SessionCollaborationLike | null): boolean {
  return !!session && !!sessionCollaborationLabel(session);
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
