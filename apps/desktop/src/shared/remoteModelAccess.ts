import type { ProviderShareMemberBudget, ProviderShareBudgetStatus } from './providerShareBudget.js';
/** null follows all currently offered models; [] deliberately grants none. IDs are exact catalog IDs. */
export type RemoteModelSelection = string[] | null;

export interface RemoteModelAccessView {
  version: 1;
  providerName?: string;
  memberBudget?: ProviderShareMemberBudget | null;
  budgetStatus?: ProviderShareBudgetStatus;
  budgetSupported?: boolean;
  budgetAvailable?: boolean;
  /** Current provider catalog models eligible for member limits. */
  budgetModelIds?: string[];
  recommendationModelIds?: string[];
  models: RemoteModelSelection;
  providerModels: RemoteModelSelection;
  availableModels: Array<{ id: string; name: string }>;
}

export function isRemoteModelSelection(value: unknown): value is RemoteModelSelection {
  return value === null || (Array.isArray(value) && value.length <= 4096
    && value.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 512 && id.trim() === id)
    && new Set(value).size === value.length);
}
