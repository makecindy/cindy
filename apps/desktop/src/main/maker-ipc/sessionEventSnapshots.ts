import { isOpenAiSubscriptionProviderId } from '../maker-host/codex-account-auth.js';
import { recordSessionContextSnapshot } from '../sessionSpendBroadcaster.js';
import { recordCodexAccountUsageSnapshot } from '../usageBroadcaster.js';
import { getSessionProvider } from '../maker-host/session-provider-store.js';
import {createSessionEventSnapshots} from '@cindy/app-runtime/sessionEventSnapshots';
export type * from '@cindy/app-runtime/sessionEventSnapshots';
export const {recordSessionEventSnapshots}=createSessionEventSnapshots({
isOpenAiSubscriptionProviderId: (...args) => isOpenAiSubscriptionProviderId(...args),
recordSessionContextSnapshot: (...args) => recordSessionContextSnapshot(...args),
recordCodexAccountUsageSnapshot: (...args) => recordCodexAccountUsageSnapshot(...args),
getSessionProvider: (...args) => getSessionProvider(...args)
});
