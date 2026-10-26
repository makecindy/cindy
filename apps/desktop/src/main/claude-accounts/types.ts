/**
 * Claude multi-account types. Design: docs/dev-rules/claude-multi-account.md.
 *
 * An extra account is only a separate Claude Code CLI config directory; the CLI owns
 * login and credentials. Nothing here ever holds a token.
 */

/** The user's own `~/.claude` login. Always present, never removable. */
export const MASTER_ACCOUNT_ID = 'master';

/** Generated ids only; user input never becomes a path segment. */
export const EXTRA_ACCOUNT_ID_PATTERN = /^acct_[a-z0-9]{8,32}$/;

export type ClaudeAccountKind = 'master' | 'extra';

/** Display-only identity reported by `claude auth status --json`. */
export interface ClaudeAccountIdentity {
  email?: string;
  subscriptionType?: string;
}

export interface ClaudeAccount {
  id: string;
  kind: ClaudeAccountKind;
  label: string;
  createdAt: number;
  lastUsedAt?: number;
  identity?: ClaudeAccountIdentity;
}

export interface ClaudeAccountRegistryState {
  version: 1;
  activeAccountId: string;
  accounts: ClaudeAccount[];
}

export function isExtraAccountId(id: string): boolean {
  return EXTRA_ACCOUNT_ID_PATTERN.test(id);
}
