import {getAppCapabilities} from '../appCapabilities.js';
import * as authManager from '../authManager.js';
import * as imageCacheStore from '../imageCacheStore.js';
import * as videoCacheStore from '../videoCacheStore.js';
import {createLogger} from '../logger.js';
import {ServerApiError} from '../serverApiClient.js';
import {getCurrentDbClientUserId,getDbClient} from '../localDb/client/current.js';
import {effectiveXdGatewayBaseUrl} from '../model-access/effectiveEndpoint.js';
import {reportCindyGatewayKeyRejected} from '../model-access/gatewayKeyRejection.js';
import {outboundFetch} from '../maker-host/outbound-fetch.js';
import {fetchMediaInvocationGuide,listAvailableMediaModels,listExecutableMediaModels,MediaGuideCompatibilityError,MediaModelCatalogError} from '../model-access/mediaModels.js';
import {getProviderSecretStore} from '../secrets/providerSecretStore.js';
import * as blobStore from './blobStore.js';
import {ingestMedia} from './ingest.js';
import {downloadMediaResult} from './mediaDownload.js';
import {invokeProviderMedia,resolveProviderMediaModel,resolveProviderVideoConnection} from './providerMediaRuntime.js';
import {fetchVideoTaskContent} from './videoTaskContent.js';
import * as invocationStore from './mediaInvocationStore.js';
import {createMediaInvocationService} from '@cindy/app-runtime/media/invocationService';
export const {callCindyMedia}=createMediaInvocationService({
  ...invocationStore,logger:createLogger('cindyMediaInvocation'),getAppCapabilities,authManager,imageCacheStore,videoCacheStore,
  ServerApiError,MediaGuideCompatibilityError,MediaModelCatalogError,getDbClient,getCurrentDbClientUserId,
  effectiveXdGatewayBaseUrl,reportCindyGatewayKeyRejected,outboundFetch,getProviderSecretStore,blobStore,ingestMedia,
  downloadMediaResult,fetchVideoTaskContent,fetchMediaInvocationGuide,listAvailableMediaModels,listExecutableMediaModels,
  invokeProviderMedia,resolveProviderMediaModel,resolveProviderVideoConnection,
  prepareGatewayMediaBilling: input => import('../usage/gatewayMediaBilling.js').then(module => module.prepareGatewayMediaBilling(input)),
});
