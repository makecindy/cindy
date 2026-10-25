import type {Catalog} from '@cindy/model-providers';
import {createXaiVideoProvider,type CreateXaiVideoProviderOptions} from './proxy/video/providers/xai.js';
import type {VideoProviderRegistry} from './proxy/video/registry.js';
export interface VideoProviderChannelsHost {
 getCindyVideoProviderRegistry():VideoProviderRegistry|null;
 getActiveCatalog():Pick<Catalog,'providers'>;
 hasGrokOAuthLogin():boolean;getGrokAccessToken():Promise<string>;getGrokOAuthCredentialGeneration():number;
 activeOwnerScopeKey():string;isAppSessionBoundaryPending():boolean;
 outboundFetch:typeof fetch;
 assertMediaModelStillEnabled(kind:'image'|'video',model:string):void;
 invalidateXaiBridgeAuth:NonNullable<CreateXaiVideoProviderOptions['onAuthRejected']>;
 isXdGatewayProviderReady(providerId:string):boolean;
}
export function createVideoProviderChannels(host:VideoProviderChannelsHost) {
const {getCindyVideoProviderRegistry,getActiveCatalog,hasGrokOAuthLogin,getGrokAccessToken,getGrokOAuthCredentialGeneration,activeOwnerScopeKey,isAppSessionBoundaryPending,outboundFetch,assertMediaModelStillEnabled,invalidateXaiBridgeAuth,isXdGatewayProviderReady}=host;
function getVideoProviderRegistry() {
  const registry = getCindyVideoProviderRegistry();
  if (!registry) return null;
  const xaiCatalogProvider = getActiveCatalog().providers.find((provider) => provider.id === 'xai');
  const xaiCatalogProviderId = xaiCatalogProvider?.id;
  const xaiAliases = xaiCatalogProvider?.videoModels?.map((model) => model.id) ?? [];
  const routableXaiAliases = xaiCatalogProviderId
    ? xaiAliases.filter(
        (alias) => !registry.hasAlias(alias) || registry.hasAlias(alias, xaiCatalogProviderId),
      )
    : [];
  if (xaiCatalogProviderId && routableXaiAliases.some((alias) => !registry.hasAlias(alias))) {
    registry.registerOrExtend(
      createXaiVideoProvider({
        modelAliases: routableXaiAliases,
        hasOAuthLogin: () => hasGrokOAuthLogin(),
        getAccessToken: () => getGrokAccessToken(),
        getCredentialGeneration: () => getGrokOAuthCredentialGeneration(),
        getOwnerScopeKey: () => activeOwnerScopeKey(),
        isOwnerBoundaryPending: () => isAppSessionBoundaryPending(),
        fetchImplementation: ((url, init) => outboundFetch(url as string, init)) as typeof fetch,
        beforeDispatch: (model) => assertMediaModelStillEnabled('video', model),
        onAuthRejected: (failure) => invalidateXaiBridgeAuth(failure),
      }),
      xaiCatalogProviderId,
    );
  }
  return registry;
}

/** 视频目录的 provider 级就绪判据；未知来源绝不投影成可选型号。 */
function isVideoCatalogProviderReady(providerId: string): boolean {
  if (providerId === 'xd') return isXdGatewayProviderReady(providerId);
  if (providerId === 'xai') {
    return !isAppSessionBoundaryPending() && hasGrokOAuthLogin();
  }
  return false;
}

return {getVideoProviderRegistry,isVideoCatalogProviderReady};
}
