import {readLatestClaudeSessionRequestId,takeClaudeRequestRoute} from './claude-session-route-registry.js';
import {decodeUpstreamErrorBody} from './provider-upstream-error-observer.js';
import {createClaudeGatewayErrorTracker} from '@cindy/app-runtime/claude-gateway-error-observer';
export type * from '@cindy/app-runtime/claude-gateway-error-observer';
export const {createClaudeGatewayErrorObserver,consumeClaudeOpusPlanMismatch,resetClaudeGatewayErrorObserverForTest}=createClaudeGatewayErrorTracker({readLatestClaudeSessionRequestId,takeClaudeRequestRoute,decodeUpstreamErrorBody});
