/**
 * Resolves the CLI env for a Claude account.
 *
 * - master → `{}`: the CLI uses its default config dir, exactly as before multi-account.
 * - extra  → `{ CLAUDE_CONFIG_DIR }`, but only after its profile links are prepared.
 *   A failed prepare blocks the spawn. It never falls back to master, which would silently
 *   run the task on the wrong account.
 */
import path from 'node:path';

import type { PrepareReport, ProfilePaths } from './profileLinker.js';
import { MASTER_ACCOUNT_ID, isExtraAccountId, type ClaudeAccount } from './types.js';

export type ClaudeAccountEnvErrorCode = 'invalid_account' | 'profile_unavailable';

export class ClaudeAccountEnvError extends Error {
  constructor(
    readonly code: ClaudeAccountEnvErrorCode,
    readonly accountId: string,
    message: string,
  ) {
    super(message);
    this.name = 'ClaudeAccountEnvError';
  }
}

export function profileDirFor(accountsRoot: string, accountId: string): string {
  if (!isExtraAccountId(accountId)) {
    throw new ClaudeAccountEnvError('invalid_account', accountId, `not an extra Claude account id: ${accountId}`);
  }
  return path.join(accountsRoot, accountId);
}

export interface ResolvedAccountEnv {
  env: Record<string, string>;
  accountId: string;
  report?: PrepareReport;
}

export async function resolveClaudeAccountEnv(options: {
  account: ClaudeAccount;
  accountsRoot: string;
  masterDir: string;
  prepare: (paths: ProfilePaths) => Promise<PrepareReport>;
}): Promise<ResolvedAccountEnv> {
  const { account } = options;
  const isMaster = account.id === MASTER_ACCOUNT_ID;
  if (isMaster !== (account.kind === 'master')) {
    throw new ClaudeAccountEnvError('invalid_account', account.id, 'account kind does not match its id');
  }
  if (isMaster) return { env: {}, accountId: account.id };
  const profileDir = profileDirFor(options.accountsRoot, account.id);
  let report: PrepareReport;
  try {
    report = await options.prepare({ profileDir, masterDir: options.masterDir, accountsRoot: options.accountsRoot });
  } catch (err) {
    throw new ClaudeAccountEnvError(
      'profile_unavailable',
      account.id,
      `Claude account "${account.label}" is not ready: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return { env: { CLAUDE_CONFIG_DIR: profileDir }, accountId: account.id, report };
}
