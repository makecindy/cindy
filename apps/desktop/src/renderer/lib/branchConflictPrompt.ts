import type { TFunction } from 'i18next';

export interface BranchConflictPromptInput {
  branch: string;
  remoteRef: string;
  ahead?: number;
  behind?: number;
  dirtyFiles?: number;
  conflictFiles?: readonly string[];
  pushAfterSync?: boolean;
}

export function formatConflictFilesSummary(files: readonly string[], maxVisible = 2): string {
  if (files.length === 0) return '';
  if (files.length <= maxVisible) return files.join(', ');
  return `${files.slice(0, maxVisible).join(', ')} +${files.length - maxVisible}`;
}

export function buildBranchConflictResolvePrompt(
  t: TFunction,
  input: BranchConflictPromptInput,
): string {
  const details: string[] = [];
  if (input.ahead || input.behind) {
    details.push(
      t('newChat.branchSync.agentPromptDivergedCounts', {
        ahead: input.ahead ?? 0,
        behind: input.behind ?? 0,
      }),
    );
  }
  if (input.conflictFiles && input.conflictFiles.length > 0) {
    details.push(
      t('newChat.branchSync.agentPromptConflictFiles', {
        files: input.conflictFiles.join(', '),
      }),
    );
  }
  if (input.dirtyFiles && input.dirtyFiles > 0) {
    details.push(t('newChat.branchSync.agentPromptDirty', { count: input.dirtyFiles }));
  }
  const detailLine = details.length > 0 ? `\n${details.join('；')}` : '';
  return t(
    input.pushAfterSync
      ? 'newChat.branchSync.agentPromptSyncAndPush'
      : 'newChat.branchSync.agentPromptSyncOnly',
    {
      branch: input.branch,
      remoteRef: input.remoteRef,
      details: detailLine,
    },
  );
}
