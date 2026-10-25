import {createOutboundFetch} from '@cindy/app-runtime/outboundFetch';
import {createMakerLogger} from './logger-adapter.js';
import {resolveDesktopOutboundProxy} from './outbound-proxy-resolver.js';
export type {ResolveOutboundDispatcherOptions} from '@cindy/app-runtime/outboundFetch';
export const {resolveConnectOptions,rewritePinnedProxyDispatchOptions,createPinnedProxyDispatcher,guardedOutboundFetch,resolveOutboundDispatcher,outboundFetch,outboundUndiciFetch,createOutboundHttpAgent,resetOutboundFetchStateForTest}=createOutboundFetch({logger:createMakerLogger('outbound-fetch'),resolveOutboundProxy:resolveDesktopOutboundProxy});
