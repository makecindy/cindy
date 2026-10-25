import {createClaudeSessionRouteRegistry} from '@cindy/app-runtime/claude-session-route-registry';
export type * from '@cindy/app-runtime/claude-session-route-registry';
export const {noteClaudeSessionRequest,recordClaudeRequestRoute,takeClaudeRequestRoute,readLatestClaudeSessionRequestId,recordClaudeSessionRoute,readClaudeSessionRoute,onClaudeSessionRouteChange,resetClaudeSessionRouteRegistryForTest}=createClaudeSessionRouteRegistry();
