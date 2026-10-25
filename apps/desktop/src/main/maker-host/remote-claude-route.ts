import {createRemoteClaudeRoute} from '@cindy/app-runtime/remoteClaudeRoute';
import {isClaudeSubscriptionProviderId} from './subscription-account-auth.js';
import {readClaudeApiKey} from './auth-adapters.js';
import {isProviderRouteMutationInProgress,resolveProviderRouteDecision} from './provider-route.js';
export const {resolveRemoteClaudeRoute}=createRemoteClaudeRoute({isClaudeSubscriptionProviderId,readClaudeApiKey,isProviderRouteMutationInProgress,resolveProviderRouteDecision});
