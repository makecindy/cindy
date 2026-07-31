import type { AgentKind } from '@cindy/model-providers';

import type { ModelPriceQuote, MoneyCurrency } from './regionalMoney.js';

export interface ModelPriceOverrideTarget {
  providerId: string;
  agent: AgentKind;
  modelId: string;
}

/** Sparse local patch. Missing fields continue to follow the current remote reference price. */
export interface ModelPriceOverrideValues {
  currency?: MoneyCurrency;
  inputPerMtok?: number;
  outputPerMtok?: number;
  cacheReadPerMtok?: number | null;
  cacheCreatePerMtok?: number | null;
}

export interface ModelPriceOverrideDesiredQuote {
  currency: MoneyCurrency;
  inputPerMtok: number;
  outputPerMtok: number;
  cacheReadPerMtok?: number | null;
  cacheCreatePerMtok?: number | null;
}

export interface ModelPriceOverrideView {
  target: ModelPriceOverrideTarget;
  editable: boolean;
  reference: ModelPriceQuote | null;
  effective: ModelPriceQuote | null;
  override: ModelPriceOverrideValues | null;
  conflict: boolean;
  registryUpdatedAt: string | null;
  /** Currencies that can be projected into the active account ledger without guessing FX. */
  allowedCurrencies: MoneyCurrency[];
}
