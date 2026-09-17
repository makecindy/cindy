import type { AgentKind } from '@cindy/model-providers';

export interface ProviderAccountUsageRequest {
  providerId: string;
  agent: AgentKind;
  forceRefresh?: boolean;
}

export interface DeepSeekBalanceLine {
  currency: string;
  totalBalance: string;
  grantedBalance: string;
  toppedUpBalance: string;
}

export interface DeepSeekAccountUsageSnapshot {
  kind: 'deepseek-balance';
  isAvailable: boolean;
  balances: DeepSeekBalanceLine[];
  fetchedAt: number;
}

export interface OpenRouterKeyUsageSnapshot {
  kind: 'openrouter-key-usage';
  limit: number | null;
  limitRemaining: number | null;
  limitReset: string | null;
  usage: number;
  usageDaily: number;
  usageWeekly: number;
  usageMonthly: number;
  fetchedAt: number;
}

export type ProviderAccountUsageSnapshot =
  | DeepSeekAccountUsageSnapshot
  | OpenRouterKeyUsageSnapshot;

export type ProviderAccountUsageError =
  | 'no-credentials'
  | 'updating'
  | 'superseded'
  | 'auth'
  | 'rate-limited'
  | 'network'
  | 'server'
  | 'invalid-response'
  | 'throttled'
  | 'unknown';

export type ProviderAccountUsageResult =
  | { status: 'unsupported' }
  | {
      status: 'unavailable';
      error: ProviderAccountUsageError;
      retryAt?: number;
    }
  | {
      status: 'ready';
      snapshot: ProviderAccountUsageSnapshot;
      stale: boolean;
      error?: ProviderAccountUsageError;
      retryAt?: number;
    };
