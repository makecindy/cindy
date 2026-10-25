import {createProviderUpstreamErrorObservers} from '@cindy/app-runtime/provider-upstream-error-observer';
export type * from '@cindy/app-runtime/provider-upstream-error-observer';
export const {setProviderUpstreamErrorBroadcaster,reportProviderUpstreamError,decodeUpstreamErrorBody,createProviderUpstreamErrorObserver}=createProviderUpstreamErrorObservers();
