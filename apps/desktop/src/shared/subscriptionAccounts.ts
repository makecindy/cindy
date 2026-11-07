import type { ProviderGroupStrategy } from './providerGroup.js';

export const SUBSCRIPTION_ACCOUNTS_CHANNEL = 'maker:subscription-accounts';
export const SUBSCRIPTION_ACCOUNTS_CHANGED = 'subscription-accounts:changed';
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
export interface SubscriptionAccountView extends SubscriptionAccountConfig {
  legacy?: boolean;
  identity?: string;
  plan?: string;
  directory: string;
  status: 'ready' | 'signed-out' | 'unavailable' | 'limited';
  running: number;
  quota?: { usedPercent: number; resetAtMs: number | null; windowMs: number };
}
export interface SubscriptionPoolView {
  providerId: SubscriptionProvider;
  configured: boolean;
  strategy: ProviderGroupStrategy;
  accounts: SubscriptionAccountView[];
}
export type SubscriptionAccountCommand =
  | { action: 'read'; providerId: SubscriptionProvider }
  | { action: 'add'; providerId: SubscriptionProvider; loginKey: string }
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

export const DEFAULT_SUBSCRIPTION_ACCOUNT: SubscriptionAccountConfig = {
  id: 'default',
  paused: false,
  limit: 4,
  weight: 1,
};
export function isSubscriptionProvider(value: unknown): value is SubscriptionProvider {
  return value === 'anthropic' || value === 'openai';
}
