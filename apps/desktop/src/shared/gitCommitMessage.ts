import type { FileStatus, ReviewData } from './gitReviewWire.js';

export function buildDeterministicCommitMessage(
  data: Pick<ReviewData, 'status'> | null,
): string {
  const files = [...(data?.status?.files ?? [])].sort((left, right) =>
    left.path.localeCompare(right.path),
  );
  if (files.length === 0) return '';
  const scope = commitScope(files.map((file) => file.path));
  return [
    `chore${scope ? `(${scope})` : ''}: 更新 ${files.length} 个工作区文件`,
    '',
    ...files.map(formatCommitFile),
  ].join('\n');
}

function commitScope(paths: string[]): 'desktop' | 'mobile' | 'packages' | null {
  if (paths.length === 0) return null;
  const scopes = [
    ['apps/desktop/', 'desktop'],
    ['apps/mobile/', 'mobile'],
    ['packages/', 'packages'],
  ] as const;
  return scopes.find(([prefix]) => paths.every((path) => path.startsWith(prefix)))?.[1] ?? null;
}

function formatCommitFile(file: FileStatus): string {
  const action = file.isUnmerged
    ? '解决冲突'
    : file.isUntracked || file.indexStatus === 'added'
      ? '新增'
      : file.worktreeStatus === 'deleted' || file.indexStatus === 'deleted'
        ? '删除'
        : file.worktreeStatus === 'renamed' || file.indexStatus === 'renamed'
          ? '重命名'
          : file.indexStatus === 'copied'
            ? '复制'
            : file.worktreeStatus === 'typechange' || file.indexStatus === 'typechange'
              ? '类型变更'
              : '修改';
  const path = file.oldPath ? `${file.oldPath} -> ${file.path}` : file.path;
  return `- ${action}：${path}`;
}
