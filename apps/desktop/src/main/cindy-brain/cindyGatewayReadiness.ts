import {getAppCapabilities} from '../appCapabilities.js';
import {effectiveXdGatewayBaseUrl} from '../model-access/effectiveEndpoint.js';
import {createCindyGatewayReadiness} from '@cindy/app-runtime/media/cindyGatewayReadiness';
export const {isXdGatewayProviderReady}=createCindyGatewayReadiness({getAppCapabilities,effectiveXdGatewayBaseUrl});
