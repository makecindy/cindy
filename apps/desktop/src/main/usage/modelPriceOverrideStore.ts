/**
 * Per-(provider instance, runtime, model id) local reference-price patches.
 *
 * The JSON file is an internal persistence detail. Users edit it only through Settings.
 * Records are sparse and keep the remote reference used when they were saved; if that
 * reference later changes, the local patch wins and the UI exposes a conflict/reset state.
 */

import type { AgentKind, ModelRegistry } from '@cindy/model-providers';

import { modelPricingKey } from '../../shared/modelPriceQuote.js';
import { accountReferencePriceQuote as providerReferencePriceQuote } from './accountReferencePrice.js';
import type {
  ModelPriceOverrideDesiredQuote,
  ModelPriceOverrideTarget,
  ModelPriceOverrideValues,
  ModelPriceOverrideView,
} from '../../shared/modelPriceOverride.js';
import type {
  ModelPriceQuote,
  ModelPricingCatalog,
  MoneyCurrency,
} from '../../shared/regionalMoney.js';
import { ownerScopedUserDataPath } from '../appSessionState.js';
import { createOverrideSettingsFile } from '../maker-host/override-settings-file.js';
import { desktopMakerLogger } from '../maker-host/logger-adapter.js';
import { currentLedgerCurrency } from './ledgerCurrency.js';
import {createModelPriceOverrideStore} from "@cindy/app-runtime/modelPriceOverrideStore";


export const {readModelPriceOverrideView,setModelPriceOverride,clearModelPriceOverride,stageProviderModelPriceOverridesClear,readModelPriceOverridesSnapshot,mergeStoredModelPriceOverride,applyModelPriceOverrides,__testing}=createModelPriceOverrideStore({
providerReferencePriceQuote:(...args)=>providerReferencePriceQuote(...args),
ownerScopedUserDataPath:(...args)=>ownerScopedUserDataPath(...args),
log:desktopMakerLogger.child("model-price-overrides"),
currentLedgerCurrency:()=>currentLedgerCurrency()
});
export type {ModelPriceOverridesSnapshot} from "@cindy/app-runtime/modelPriceOverrideStore";
