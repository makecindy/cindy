import type { ProviderGroupStrategy } from './providerGroup.js';
import type { ClaudeSubscriptionUsageSnapshot } from './claudeSubscriptionUsage.js';

export const SUBSCRIPTION_ACCOUNTS_CHANNEL = 'maker:subscription-accounts';
export const SUBSCRIPTION_ACCOUNTS_CHANGED = 'subscription-accounts:changed';
/** Appended to legacy remote quota queries when the caller needs the CLI default account itself. */
export const DEFAULT_ACCOUNT_USAGE_SCOPE = 'default-subscription-account';
export type SubscriptionProvider = 'anthropic' | 'openai';
export interface SubscriptionAccountConfig {
  id: string;
  paused: boolean;
  limit: number;
  weight: number;
}
export interface SubscriptionPoolConfig {
  disconnected?: boolean;
  /** Upgrade-only: preserve an already authorized private Cindy Codex home. */
  legacyCodexDefault?: boolean;
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
export interface SubscriptionAccountView extends SubscriptionAccountConfig {
  legacy?: boolean;
  identity?: string;
  plan?: string;
  directory: string;
  status: 'ready' | 'signed-out' | 'unavailable' | 'limited';
  /** Advisory diagnosis only; absent on older hosts. Never includes CLI output. */
  authIssue?: 'codex-provider-managed-auth';
  running: number;
  usage?: SubscriptionAccountUsage;
}
export interface SubscriptionPoolView {
  providerId: SubscriptionProvider;
  configured: boolean;
  strategy: ProviderGroupStrategy;
  accounts: SubscriptionAccountView[];
}
export type SubscriptionAccountCommand =
  | { action: 'read'; providerId: SubscriptionProvider }
  /** Advisory login presentation only; never binds detected system credentials. */
  | { action: 'preview'; providerId: SubscriptionProvider }
  | { action: 'add'; providerId: SubscriptionProvider; loginKey: string }
  /** Explicit wizard intent. Older hosts reject this action instead of reusing a different account. */
  | {
      action: 'connect';
      providerId: SubscriptionProvider;
      target: 'default' | 'new';
      loginKey: string;
    }
  | { action: 'login'; providerId: SubscriptionProvider; accountId: string; loginKey: string }
  | { action: 'cancel'; providerId: SubscriptionProvider; loginKey: string }
  | { action: 'remove'; providerId: SubscriptionProvider; accountId: string }
  | {
      action: 'configure';
      providerId: SubscriptionProvider;
      strategy?: ProviderGroupStrategy;
      accountId?: string;
      paused?: boolean;
      limit?: number;
      weight?: number;
    };

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
