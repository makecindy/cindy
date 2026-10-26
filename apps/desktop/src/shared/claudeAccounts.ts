/**
 * Claude multi-account IPC contract (renderer-safe: no paths, no secrets).
 * Design: docs/dev-rules/claude-multi-account.md.
 */

export const CLAUDE_ACCOUNT_ID_PATTERN = /^(master|acct_[a-z0-9]{8,32})$/;
export const CLAUDE_ACCOUNT_LOGIN_KEY_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
export const CLAUDE_ACCOUNT_LABEL_MAX = 40;

export interface ClaudeAccountView {
  id: string;
  kind: 'master' | 'extra';
  label: string;
  email?: string;
  subscriptionType?: string;
  lastUsedAt?: number;
  active: boolean;
}

export interface ClaudeAccountsListView {
  activeAccountId: string;
  accounts: ClaudeAccountView[];
}

export type ClaudeAccountAddFailure =
  | 'login_cancelled'
  | 'timeout'
  | 'local_unavailable'
  | 'login_failed'
  | 'not_a_subscription'
  | 'duplicate_identity'
  | 'invalid_label'
  | 'profile_unavailable'
  | 'no_owner';

export type ClaudeAccountAddResult = { ok: true; account: ClaudeAccountView } | { ok: false; reason: ClaudeAccountAddFailure };

export type ClaudeAccountSwitchFailure = 'unknown_account' | 'not_logged_in' | 'profile_unavailable' | 'no_owner';

export type ClaudeAccountSwitchResult = { ok: true } | { ok: false; reason: ClaudeAccountSwitchFailure };

export interface ClaudeAccountHealthView {
  accountId: string;
  label: string;
  loggedIn: boolean;
  email?: string;
  /** The CLI could not be asked (not installed / crashed). */
  checkFailed?: true;
  /** Extra accounts only. Names of shared entries and their state; never paths. */
  profile?: { healthy: boolean; mode: 'linked' | 'mirror'; problems: Array<{ name: string; state: string }> };
}

export type ClaudeHandoffPreview =
  | {
      available: true;
      recommended: 'resume' | 'brief';
      /** Context tokens a full resume re-reads uncached once; null if unknown. */
      resumeTokens: number | null;
      briefTokens: number;
      brief: string;
      goal?: string;
      userTurns: number;
      filesTouched: number;
      interruptedTool?: string;
    }
  | { available: false; reason: 'not_found' | 'not_claude' | 'unreadable' };
