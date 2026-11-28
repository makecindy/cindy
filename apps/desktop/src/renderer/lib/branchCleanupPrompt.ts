import type { TFunction } from 'i18next';

export interface BranchCleanupFocusScopes {
  merged: boolean;
  worktrees: boolean;
  unpushed: boolean;
}

export interface BranchCleanupPromptParams {
  scopes: BranchCleanupFocusScopes;
  protectedWorktreePaths?: readonly string[];
}

/**
 * Builds the battle-tested V2 read-only-first AI workspace cleanup prompt.
 * Incorporates real-repo dry-run safeguards:
 * - Strict read-only phase 1 (no delete/reset/checkout/fetch/full-branch diff on partial clones)
 * - GitHub plugin GraphQL batch check + mandatory HEAD SHA === PR headRefOid / ancestor verification
 * - Candidate-only fast disk sizing (never recursive du on main repo; honest APFS CoW distinction)
 * - Triple active protection: unarchived Cindy sessions (injected when known) + live OS processes + OPEN/DRAFT PRs
 * - Grouped summary on large repos + numbered user confirmation before any mutation
 */
export function buildBranchCleanupPrompt(
  t: TFunction,
  params: BranchCleanupPromptParams,
): string {
  const focusParts: string[] = [];
  if (params.scopes.merged) focusParts.push(t('newChat.workspaceCleanup.promptFocusMerged'));
  if (params.scopes.worktrees) focusParts.push(t('newChat.workspaceCleanup.promptFocusWorktrees'));
  if (params.scopes.unpushed) focusParts.push(t('newChat.workspaceCleanup.promptFocusUnpushed'));
  if (focusParts.length === 0) {
    focusParts.push(t('newChat.workspaceCleanup.promptFocusMerged'));
    focusParts.push(t('newChat.workspaceCleanup.promptFocusWorktrees'));
  }

  const lines = [
    t('newChat.workspaceCleanup.promptIntro'),
    t('newChat.workspaceCleanup.promptStepFocus', { focus: focusParts.join('; ') }),
    t('newChat.workspaceCleanup.promptStepProtect'),
    t('newChat.workspaceCleanup.promptStepOutput'),
  ];

  const protectedPaths = (params.protectedWorktreePaths ?? []).filter(Boolean);
  if (protectedPaths.length > 0) {
    const shown = protectedPaths.slice(0, 12);
    const suffix =
      protectedPaths.length > shown.length ? ` (+${protectedPaths.length - shown.length})` : '';
    lines.push(
      t('newChat.workspaceCleanup.promptProtectedList', {
        count: protectedPaths.length,
        paths: `${shown.join(', ')}${suffix}`,
      }),
    );
  }

  return lines.join('\n');
}
