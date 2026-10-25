import { AsyncLocalStorage } from 'node:async_hooks';
import { createCindyProxyMediaService } from '../cindy-proxy-media/service.js';
import type { CindyProxyMediaService } from '../cindy-proxy-media/types.js';
import {
  createSeedance25Provider,
  createSeedanceProvider,
} from '../cindy-proxy-media/video/providers/seedance.js';
import { createHappyhorseProvider } from '../cindy-proxy-media/video/providers/happyhorse.js';
import { resolveSafe as resolveXdtImage } from '../imageCacheStore.js';
import { createBlobImageStorage, createBlobVideoStorage } from '../cindy-media/generatedMedia.js';
import { VideoProviderRegistry } from '../cindy-proxy-media/video/registry.js';
import { createLogger } from '../logger.js';
import { mediaErrorForLog } from '../cindy-media/mediaRequestLog.js';
import { getProviderSecretStore } from '../secrets/providerSecretStore.js';
import { effectiveXdGatewayBaseUrl } from '../model-access/effectiveEndpoint.js';
import { withCindyGatewayKeyRejectionReport } from '../model-access/gatewayKeyRejection.js';
import { getAppCapabilities } from '../appCapabilities.js';

import {isProviderModelRouteDisabled} from '../utility-model/oneShotCandidates.js';
import {createCindyProxyMediaHost} from '@cindy/app-runtime/media/proxyMediaHost';
export const {withCindyMediaBillingSession,getCindyProxyMediaService,getCindyVideoProviderRegistry}=createCindyProxyMediaHost({resolveXdtImage,createBlobImageStorage,createBlobVideoStorage,getProviderSecretStore,effectiveXdGatewayBaseUrl,withCindyGatewayKeyRejectionReport,getAppCapabilities,isProviderModelRouteDisabled,logger:createLogger('art'),fetch:(url,init)=>fetch(url,init),prepareGatewayMediaBilling:async input=>(await import('../usage/gatewayMediaBilling.js')).prepareGatewayMediaBilling(input)});
