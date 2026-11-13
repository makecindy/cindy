/**
 * The pool account an existing local task runs on, for the pre-send account moves (paused or
 * removed accounts in prepareSend.ts, exhausted or signed-out accounts in failover.ts).
 *
 * Read in the same order a resume uses (agent.ts): the task binding, then its native session,
 * then a merged legacy Codex connection's own account, then the official default home of a
 * pre-pool Claude task. Since 2026-11-13 merged connections move like every other account: after
 * the merge users can no longer pick another connection by hand, so every task must be able to
 * continue on another account (subscription-account-pools.md 账号间自动换号).
 *
 * SSH and tasks running on another computer are excluded; a same-account remote Agent task asks
 * its executing computer instead (`needsSubscriptionAccountHandoff`).
 */
import type { SubscriptionProvider } from '../../shared/subscriptionAccounts.js';
import { openAiRouteAllowsModel } from './legacyAccountAccess.js';
import { readAccountBinding, readLegacyCodexAccountId } from './store.js';

export interface TaskAccountSession {
  status: string;
  providerId: string | null;
  agentKind?: string | null;
  sdkSessionId?: string | null;
  remoteHostId?: string | null;
  agentDeviceId?: string | null;
}

export interface TaskPoolAccount {
  provider: SubscriptionProvider;
  accountId: string;
  /**
   * The merged legacy Codex connection id the task still routes through. That id always pins its
   * own account (agent.ts), so a task leaving the account continues on the merged `openai` route.
   */
  legacyRoute?: string;
}

const OPENAI_KINDS = ['codex', 'cc', 'claude-code', 'pi'];
const CLAUDE_KINDS = ['cc', 'claude-code'];

/** Which pool a local task uses and the account it is on; null when it is not a local pool task. */
export function readTaskPoolAccount(sessionId: string, row: TaskAccountSession): TaskPoolAccount | null {
  if (row.status === 'deleted' || row.remoteHostId || row.agentDeviceId) return null;
  const legacyAccount = row.providerId && row.providerId !== 'openai'
    ? readLegacyCodexAccountId(row.providerId) : undefined;
  const provider: SubscriptionProvider | null =
    (row.providerId === 'openai' || legacyAccount) && OPENAI_KINDS.includes(row.agentKind ?? '')
      ? 'openai'
      : row.providerId === 'anthropic' && CLAUDE_KINDS.includes(row.agentKind ?? '')
        ? 'anthropic'
        : null;
  if (!provider) return null;
  const accountId = readAccountBinding(`task:${sessionId}`, provider)?.accountId
    ?? (row.sdkSessionId ? readAccountBinding(`native:${row.sdkSessionId}`, provider)?.accountId : undefined)
    // A merged connection that has not run since the merge still runs on its own account.
    ?? legacyAccount
    // Pre-pool Claude tasks resume the official default home (same as agent.ts).
    ?? (provider === 'anthropic' && row.sdkSessionId ? 'default' : undefined);
  if (!accountId) return null;
  return { provider, accountId, ...(legacyAccount ? { legacyRoute: row.providerId! } : {}) };
}

/**
 * A task leaving a merged legacy connection continues on the merged OpenAI route. Moving must not
 * widen access: that route's own provider and model switches still apply (the replacement
 * account's own grants are checked separately when it is selected).
 */
export function mergedRouteAllowsModel(model: string | undefined): boolean {
  return openAiRouteAllowsModel(model);
}
