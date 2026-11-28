import { createOutboundTransport } from './outbound-fetch.js';
import { createMakerLogger } from './logger-adapter.js';
import { resolveDesktopOutboundProxy } from './outbound-proxy-resolver.js';
export type { ResolveOutboundDispatcherOptions, OutboundSocketProxyDecision } from './outbound-fetch.js';

// Desktop keeps its original env + Chromium/system PAC resolver.
export const { resolveConnectOptions, rewritePinnedProxyDispatchOptions, createPinnedProxyDispatcher, guardedOutboundFetch, resolveOutboundDispatcher, outboundFetch, outboundUndiciFetch, createOutboundHttpAgent, createOutboundHttpAgentWithDecision, resetOutboundFetchStateForTest } = createOutboundTransport(resolveDesktopOutboundProxy, createMakerLogger('outbound-fetch'));
