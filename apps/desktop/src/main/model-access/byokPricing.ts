import type { ByokProvider } from '@cindy/model-providers';
import { gatewayModelPriceQuote, modelPricingKey } from '../../shared/modelPriceQuote.js';
import type { ModelPricingCatalog } from '../../shared/regionalMoney.js';
import {createByokPricing} from "@cindy/app-runtime/byokPricing";


export const {buildByokPricing,setByokPricing,getByokPricing}=createByokPricing({

});
