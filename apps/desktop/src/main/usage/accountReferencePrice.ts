import { providerCatalogId } from '@cindy/model-providers';
import { providerReferencePriceQuote } from '../../shared/modelPriceQuote.js';
import { getActiveCatalog } from '../maker-host/active-catalog.js';
import {createAccountReferencePrice} from "@cindy/app-runtime/accountReferencePrice";


export const {accountReferencePriceQuote}=createAccountReferencePrice({
getActiveCatalog:()=>getActiveCatalog()
});
