export const PROJECT_ARCHIVE_CHANNEL = 'local-db:sessions:project-archive' as const;

export type ProjectArchiveBlock = 'pinned' | 'attached' | 'running';
export interface ProjectArchiveMember {
  id: string;
  blocked: ProjectArchiveBlock | null;
  hasWorktree: boolean;
}
export type ProjectArchiveReceipt = 'updated' | 'changed' | ProjectArchiveBlock;

export type ProjectArchiveOperation =
  { operation: 'preview' } | { operation: 'apply'; sessionId: string };
export type ProjectArchiveRequest = ProjectArchiveOperation & {
  directory: string;
  remoteHostId?: string | null;
  action: 'archive' | 'unarchive' | 'archiveOnRemoval';
};
