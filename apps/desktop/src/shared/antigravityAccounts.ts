import type { SubscriptionCodexUsageBucket } from './subscriptionAccounts.js';

export const ANTIGRAVITY_ACCOUNTS_CHANNEL = 'maker:antigravity-accounts';
export const ANTIGRAVITY_SUBSCRIPTION_PROVIDER_ID = 'google-antigravity-subscription';
export const ANTIGRAVITY_ACCOUNT_BUSY = 'ANTIGRAVITY_ACCOUNT_BUSY';

export type AntigravityAccountCommand =
  | { action: 'read' | 'install' | 'configure' | 'add' | 'usage' }
  | { action: 'select' | 'remove'; id: string };

export interface AntigravityOwnerScope {
  dataOwnerId: string | null;
  ownerGeneration: number;
}

export interface AntigravityLoginTarget extends AntigravityOwnerScope {
  accountId: string;
}

export interface AntigravityAccountsView {
  configured: boolean;
  connected: boolean;
  activeId: string | null;
  accounts: Array<{ id: string; identity?: string }>;
  usage?: SubscriptionCodexUsageBucket[];
}
