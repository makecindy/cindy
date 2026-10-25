import { getActiveCatalog } from '../maker-host/active-catalog.js';
import { getSessionProvider } from '../maker-host/session-provider-store.js';
import { isUserProviderSession } from '../maker-host/provider-route.js';
import { getSessionFastMode } from '../maker-host/session-effort-store.js';
import { isOpenAiSubscriptionProviderId } from '../maker-host/codex-account-auth.js';
import { isClaudeSubscriptionProviderId, isXaiSubscriptionProviderId } from '../maker-host/subscription-account-auth.js';
import {createTurnUsageContext} from '@cindy/app-runtime/turnUsageContext';
export type * from '@cindy/app-runtime/turnUsageContext';
export const {captureTurnUsageContext}=createTurnUsageContext({
getActiveCatalog: (...args) => getActiveCatalog(...args),
getSessionProvider: (...args) => getSessionProvider(...args),
isUserProviderSession: (...args) => isUserProviderSession(...args),
getSessionFastMode: (...args) => getSessionFastMode(...args),
isOpenAiSubscriptionProviderId: (...args) => isOpenAiSubscriptionProviderId(...args),
isClaudeSubscriptionProviderId: (...args) => isClaudeSubscriptionProviderId(...args),
isXaiSubscriptionProviderId: (...args) => isXaiSubscriptionProviderId(...args)
});
