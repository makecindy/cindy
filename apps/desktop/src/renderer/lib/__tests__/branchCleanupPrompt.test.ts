// @vitest-environment jsdom
/**
 * Test value: verifies V2 read-only-first workspace cleanup prompt assembly (including
 * injected active protected paths) and 7-day per-repo red-dot snooze persistence.
 * Tier: unit; pure functions + jsdom localStorage.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { TFunction } from 'i18next';
import { buildBranchCleanupPrompt } from '../branchCleanupPrompt';
import {
  CLUTTER_RED_DOT_SNOOZE_MS,
  isWorkspaceClutterSnoozed,
  snoozeWorkspaceClutterRedDot,
} from '@/hooks/useWorkspaceClutter';

const t = ((key: string, args?: Record<string, unknown>) =>
  args ? `${key}:${JSON.stringify(args)}` : key) as unknown as TFunction;

afterEach(() => {
  window.localStorage.clear();
});

describe('buildBranchCleanupPrompt', () => {
  it('assembles selected focus scopes and injects grounded protected worktree paths', () => {
    const prompt = buildBranchCleanupPrompt(t, {
      scopes: { merged: true, worktrees: true, unpushed: true },
      protectedWorktreePaths: ['/repo/.cindy-worktrees/a', '/repo/.cindy-worktrees/b'],
    });
    expect(prompt).toContain('newChat.workspaceCleanup.promptIntro');
    expect(prompt).toContain('newChat.workspaceCleanup.promptFocusMerged');
    expect(prompt).toContain('newChat.workspaceCleanup.promptFocusWorktrees');
    expect(prompt).toContain('newChat.workspaceCleanup.promptFocusUnpushed');
    expect(prompt).toContain('newChat.workspaceCleanup.promptStepProtect');
    expect(prompt).toContain('newChat.workspaceCleanup.promptStepOutput');
    expect(prompt).toContain('/repo/.cindy-worktrees/a, /repo/.cindy-worktrees/b');
  });

  it('omits protected-paths line when no active worktrees exist and falls back when scopes are empty', () => {
    const prompt = buildBranchCleanupPrompt(t, {
      scopes: { merged: false, worktrees: false, unpushed: false },
      protectedWorktreePaths: [],
    });
    expect(prompt).toContain('newChat.workspaceCleanup.promptFocusMerged');
    expect(prompt).toContain('newChat.workspaceCleanup.promptFocusWorktrees');
    expect(prompt).not.toContain('newChat.workspaceCleanup.promptProtectedList');
  });

  it('includes every protected path even after the old 12-item display limit', () => {
    const paths = Array.from({ length: 15 }, (_, index) => `/repo/.cindy-worktrees/live-${index}`);
    const prompt = buildBranchCleanupPrompt(t, {
      scopes: { merged: true, worktrees: true, unpushed: false },
      protectedWorktreePaths: paths,
    });
    expect(prompt).toContain(paths[14]);
    expect(prompt).not.toContain('(+');
  });
});

describe('workspace clutter 7-day red-dot snooze', () => {
  it('persists snooze per repo for 7 days and expires cleanly afterwards', () => {
    const now = 1_700_000_000_000;
    expect(isWorkspaceClutterSnoozed('/repo-a', now)).toBe(false);
    snoozeWorkspaceClutterRedDot('/repo-a', now);
    expect(isWorkspaceClutterSnoozed('/repo-a', now + 1000)).toBe(true);
    expect(isWorkspaceClutterSnoozed('/repo-b', now + 1000)).toBe(false);
    expect(isWorkspaceClutterSnoozed('/repo-a', now + CLUTTER_RED_DOT_SNOOZE_MS + 1)).toBe(false);
  });
});
