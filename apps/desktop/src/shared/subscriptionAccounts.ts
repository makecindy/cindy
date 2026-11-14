import type { ProviderGroupStrategy } from './providerGroup.js';
import type { ClaudeSubscriptionUsageSnapshot } from './claudeSubscriptionUsage.js';

export const SUBSCRIPTION_ACCOUNTS_CHANNEL = 'maker:subscription-accounts';
export const SUBSCRIPTION_ACCOUNTS_CHANGED = 'subscription-accounts:changed';
/** Appended to legacy remote quota queries when the caller needs the CLI default account itself. */
export const DEFAULT_ACCOUNT_USAGE_SCOPE = 'default-subscription-account';
export type SubscriptionProvider = 'anthropic' | 'openai';
/** Account-scoped target for the existing Codex reset control plane; never a model route. */
export const CODEX_POOL_RESET_PREFIX = 'openai-account:';
export function codexResetScope(accountId: string): string {
  return accountId === 'default' ? 'openai' : `${CODEX_POOL_RESET_PREFIX}${accountId}`;
}
export interface SubscriptionAccountConfig {
  id: string;
  /** Last identity confirmed by the official CLI, retained across logout/restart. No credentials. */
  lastConfirmedIdentity?: string;
  /** Owner-local recovery guard for an explicitly requested Claude re-login. No credentials. */
  reloginIdentity?: string;
  paused: boolean;
  /** Stored value; the enforced limit comes from effectiveConcurrencyLimit (unset = unlimited). */
  limit: number;
  /** Set when the user chose a limit in a client that understands unlimited concurrency. */
  limitSet?: true;
  weight: number;
}
export interface SubscriptionPoolConfig {
  disconnected?: boolean;
  /** Upgrade-only: preserve an already authorized private Cindy Codex home. */
  legacyCodexDefault?: boolean;
  /** Upgrade aliases: old connection ID -> pool account ID. Retained after removal to prevent re-import. */
  legacyCodexAccounts?: Record<string, string>;
  strategy: ProviderGroupStrategy;
  accounts: SubscriptionAccountConfig[];
}
interface SubscriptionCodexUsageWindow {
  usedPercent?: number;
  windowMinutes: number | null;
  /** Epoch seconds. */
  resetsAt: number | null;
}
/** One Codex app-server quota bucket, keyed by its limit id. */
export interface SubscriptionCodexUsageBucket {
  limitId: string | null;
  limitName: string | null;
  updatedAt: number | null;
  primary: SubscriptionCodexUsageWindow | null;
  secondary: SubscriptionCodexUsageWindow | null;
}
/** The account's own quota snapshot, shown with the provider's existing usage card. */
export interface SubscriptionAccountUsage {
  claude?: ClaudeSubscriptionUsageSnapshot;
  codex?: {
    buckets: Record<string, SubscriptionCodexUsageBucket>;
    credits: { hasCredits: boolean; unlimited: boolean; balance: string | null } | null;
  };
}
export interface SubscriptionAccountView extends Omit<SubscriptionAccountConfig, 'lastConfirmedIdentity' | 'reloginIdentity'> {
  legacy?: boolean;
  identity?: string;
  plan?: string;
  /** Advisory ISO date reported by this account's official CLI; older hosts omit it. */
  loginExpiresAt?: string;
  /** Host-selected reset target. Imported accounts retain their original connection and settings. */
  codexResetProviderId?: string;
  directory: string;
  status: 'ready' | 'signed-out' | 'unavailable' | 'limited';
  /** Advisory diagnosis only; absent on older hosts. Never includes CLI output. */
  authIssue?: 'codex-provider-managed-auth' | 'claude-account-mismatch';
  running: number;
  usage?: SubscriptionAccountUsage;
}
export interface SubscriptionPoolView {
  /**
   * The provider these accounts belong to: a built-in provider, or (2026-11-13) a provider Cindy
   * created for subscription accounts or a legacy Codex connection. Older hosts only report built-ins.
   */
  providerId: string;
  /** Pool kind of the provider (optional; older hosts omit it and only serve built-in providers). */
  kind?: SubscriptionProvider;
  configured: boolean;
  strategy: ProviderGroupStrategy;
  /** Present only for an explicitly task-scoped read; null means no recorded binding. */
  boundAccountId?: string | null;
  accounts: SubscriptionAccountView[];
  /**
   * `preview` only (2026-11-14): the CLI's own login is already in Cindy, so the add-provider wizard
   * offers no shortcut for it. Older hosts omit it; absence keeps the shortcut as before.
   */
  defaultAdded?: boolean;
}
export type SubscriptionAccountCommand =
  | { action: 'read'; providerId: string; taskId?: string }
  /** Advisory login presentation only; never binds detected system credentials. */
  | { action: 'preview'; providerId: SubscriptionProvider }
  | { action: 'add'; providerId: string; loginKey: string }
  /** Explicit wizard intent. Older hosts reject this action instead of reusing a different account. */
  | {
      action: 'connect';
      providerId: SubscriptionProvider;
      target: 'default' | 'new';
      loginKey: string;
    }
  /**
   * 2026-11-13: sign in another account as a separate provider (the wizard's default). Older hosts
   * reject the action instead of adding the account to the built-in provider.
   */
  | { action: 'create'; providerId: SubscriptionProvider; loginKey: string }
  /** 2026-11-13: move one account to another provider of the same kind, or out on its own (`target: null`). */
  | { action: 'place'; providerId: string; accountId: string; target: string | null }
  /** 2026-11-13: move every account of a provider into another provider of the same kind. */
  | { action: 'merge'; providerId: string; target: string }
  /** 2026-11-13: delete a provider Cindy created; its accounts stop being used (logins stay). */
  | { action: 'remove-provider'; providerId: string }
  | { action: 'login'; providerId: string; accountId: string; loginKey: string }
  | { action: 'cancel'; providerId: string; loginKey: string }
  | { action: 'remove'; providerId: string; accountId: string }
  | {
      action: 'configure';
      providerId: string;
      strategy?: ProviderGroupStrategy;
      accountId?: string;
      paused?: boolean;
      /** null clears the setting: unlimited concurrency. */
      limit?: number | null;
      weight?: number;
    };

/**
 * Read-only: which pooled account an existing task runs on, for its usage display. Sent on the
 * account channel; older hosts reject the action and callers keep their original readers.
 */
export interface SubscriptionSessionAccountQuery {
  action: 'session';
  providerId: SubscriptionProvider;
  /** The task id on the executing computer. */
  sessionId?: string;
  /** The task's native Claude / Codex session id. */
  nativeSessionId?: string;
  /**
   * Optional (2026-11-12): the task model. Newer hosts then report whether the bound account can
   * take it right now (`blocked`); older hosts ignore it.
   */
  model?: string;
  /** Optional: the executor's old Codex connection id; can stand alone before a native session exists. */
  legacyProviderId?: string;
  /** Actual task source, resolved on the executing computer; echoed before a new controller acts. */
  routeProviderId?: string;
}
export interface SubscriptionSessionAccount {
  isDefault: boolean;
  /** 1-based pool position, shown as 「账号 N」 when the identity is unknown. */
  number: number;
  identity?: string;
  plan?: string;
  paused: boolean;
  status: SubscriptionAccountView['status'];
  usage?: SubscriptionAccountUsage;
  /**
   * Only for a `model` query on a newer host: the bound account cannot take that model now
   * (remembered failure, exhausted trusted quota or signed out). Replacement admission is reported
   * separately by `switchAvailable`. Absent means usable or unknown; never set for paused accounts.
   */
  blocked?: true;
  /** For a blocked account, whether the executor can actually select another account, including concurrency and route grants. */
  switchAvailable?: boolean;
}
export type SubscriptionSessionAccountView = (
  /** No pool, only the CLI default, or a pre-pool task: the provider's original readers apply. */
  | { providerId: SubscriptionProvider; state: 'legacy' }
  /** The pool picks an account on the task's next turn. */
  | { providerId: SubscriptionProvider; state: 'unassigned' }
  /** The bound account was removed or the provider disconnected; nothing else stands in. */
  | { providerId: SubscriptionProvider; state: 'unavailable' }
  | { providerId: SubscriptionProvider; state: 'bound'; account: SubscriptionSessionAccount }
) & {
  /** Explicit executor admission for handing an own-computer legacy task to the merged route. */
  replacementProviderId?: string;
  /** Confirms that the executor understood the task's actual provider rather than only its kind. */
  routeProviderId?: string;
};

const SESSION_ACCOUNT_STATUSES: ReadonlySet<unknown> = new Set([
  'ready',
  'signed-out',
  'unavailable',
  'limited',
]);
/** Validates a host reply; null when it is not a session-account view for this provider. */
export function parseSubscriptionSessionAccountView(
  raw: unknown,
  providerId: SubscriptionProvider,
): SubscriptionSessionAccountView | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const view = raw as Record<string, unknown>;
  if (view.providerId !== providerId) return null;
  const route = isSubscriptionPoolProviderIdShape(view.routeProviderId)
    ? { routeProviderId: view.routeProviderId } : {};
  const replacement = isSubscriptionPoolProviderIdShape(view.replacementProviderId)
    && (route.routeProviderId !== undefined || (providerId === 'openai' && view.replacementProviderId === 'openai'))
    ? { replacementProviderId: view.replacementProviderId } : {};
  if (view.state === 'legacy' || view.state === 'unassigned' || view.state === 'unavailable')
    return { providerId, state: view.state, ...route, ...replacement };
  if (view.state !== 'bound') return null;
  const account = view.account as Record<string, unknown> | null | undefined;
  if (!account || typeof account !== 'object' || Array.isArray(account)) return null;
  if (typeof account.isDefault !== 'boolean' || !Number.isInteger(account.number)) return null;
  if (!SESSION_ACCOUNT_STATUSES.has(account.status)) return null;
  const text = (value: unknown) =>
    typeof value === 'string' && value.trim() ? value.trim() : undefined;
  const usage = account.usage;
  return {
    providerId,
    state: 'bound',
    ...route,
    ...replacement,
    account: {
      isDefault: account.isDefault,
      number: account.number as number,
      ...(text(account.identity) ? { identity: text(account.identity) } : {}),
      ...(text(account.plan) ? { plan: text(account.plan) } : {}),
      paused: account.paused === true,
      status: account.status as SubscriptionAccountView['status'],
      ...(usage && typeof usage === 'object' && !Array.isArray(usage)
        ? { usage: usage as SubscriptionAccountUsage }
        : {}),
      ...(account.blocked === true && account.paused !== true ? { blocked: true as const } : {}),
      ...((account.blocked === true || (route.routeProviderId && account.paused === true)) && typeof account.switchAvailable === 'boolean'
        ? { switchAvailable: account.switchAvailable } : {}),
    },
  };
}

/** Accounts one provider pool can hold. */
export const MAX_SUBSCRIPTION_ACCOUNTS = 32;
export const DEFAULT_SUBSCRIPTION_ACCOUNT: SubscriptionAccountConfig = {
  id: 'default',
  paused: false,
  limit: 4,
  weight: 1,
};
/**
 * Before anything signs in, the host still lists the CLI default slot. Signed out, idle and with no
 * known identity it is not an account yet; a known identity that needs signing in again still is.
 */
export function isUnusedDefaultAccount(account: SubscriptionAccountView): boolean {
  return (
    account.id === 'default' &&
    account.status === 'signed-out' &&
    account.running === 0 &&
    !account.identity
  );
}
export function isSubscriptionProvider(value: unknown): value is SubscriptionProvider {
  return value === 'anthropic' || value === 'openai';
}
/**
 * Shape check for a provider that may own subscription accounts (built-in, created or a legacy
 * Codex connection). The executing host still resolves it against its own records.
 */
export function isSubscriptionPoolProviderIdShape(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9_-]{1,40}$/.test(value);
}
