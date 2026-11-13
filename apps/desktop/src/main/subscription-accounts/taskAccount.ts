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
import { subscriptionRouteAllowsModel } from './legacyAccountAccess.js';
import { readAccountBinding } from './store.js';
import { accountProviderId, pinnedOwnAccount, resolveSubscriptionPoolProvider } from './placement.js';

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
  /** The provider the account belongs to now; replacements are selected only here. */
  providerId: string;
  accountId: string;
  /**
   * The source saved before its account moved. After handing off the native history, the task
   * follows the account's current provider so a replacement stays inside that provider.
   */
  previousProviderId?: string;
}

const OPENAI_KINDS = ['codex', 'cc', 'claude-code', 'pi'];
const CLAUDE_KINDS = ['cc', 'claude-code'];

/** Which pool a local task uses and the account it is on; null when it is not a local pool task. */
export function readTaskPoolAccount(sessionId: string, row: TaskAccountSession): TaskPoolAccount | null {
  if (row.status === 'deleted' || row.remoteHostId || row.agentDeviceId) return null;
  const ref = resolveSubscriptionPoolProvider(row.providerId);
  if (!ref || !(ref.kind === 'openai' ? OPENAI_KINDS : CLAUDE_KINDS).includes(row.agentKind ?? '')) return null;
  const provider = ref.kind;
  const binding = readAccountBinding(`task:${sessionId}`, provider)
    ?? (row.sdkSessionId ? readAccountBinding(`native:${row.sdkSessionId}`, provider) : undefined);
  // A user-selected new source is handled by the ordinary source-switch handoff, not by failing
  // over inside the previous source. Moving an account does not change its binding's source.
  if (binding && ref.providerId !== (binding.via ?? provider)
    && accountProviderId(provider, binding.accountId) !== ref.providerId) return null;
  const accountId = binding?.accountId
    // A merged connection that has not run since the merge still runs on its own account.
    ?? pinnedOwnAccount(ref)
    // Pre-pool Claude tasks resume the official default home (same as agent.ts).
    ?? (ref.providerId === 'anthropic' && row.sdkSessionId ? 'default' : undefined);
  if (!accountId) return null;
  const providerId = accountProviderId(provider, accountId);
  return { provider, providerId, accountId,
    ...(ref.providerId !== providerId ? { previousProviderId: ref.providerId } : {}) };
}

/**
 * A task leaving a merged connection continues on the account's current provider. Moving must not
 * widen access: that provider's own provider and model switches still apply (the replacement
 * account's own grants are checked separately when it is selected).
 */
export function taskPoolRouteAllowsModel(task: TaskPoolAccount, model: string | undefined): boolean {
  return subscriptionRouteAllowsModel(task.providerId, model);
}
