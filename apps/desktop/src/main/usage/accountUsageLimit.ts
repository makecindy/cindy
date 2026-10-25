import {createAccountUsageLimit} from '@cindy/app-runtime/accountUsageLimit';
import {getActiveCatalog} from '../maker-host/active-catalog.js';
import {readClaudeSubscriptionUsageSnapshot,readCodexAccountUsageSnapshot,readXaiSubscriptionUsageSnapshot} from '../usageBroadcaster.js';
import {readSubscriptionAccountUsage} from './subscriptionAccountUsage.js';
export {claudeAccountUsageLimit,type AccountUsageLimit} from '@cindy/remote-agent/shared/accountUsageLimit';
const runtime=createAccountUsageLimit({getActiveCatalog:()=>getActiveCatalog(),readClaudeSubscriptionUsageSnapshot:(...args)=>readClaudeSubscriptionUsageSnapshot(...args),readCodexAccountUsageSnapshot:(...args)=>readCodexAccountUsageSnapshot(...args),readXaiSubscriptionUsageSnapshot:(...args)=>readXaiSubscriptionUsageSnapshot(...args),readSubscriptionAccountUsage:async id=>await readSubscriptionAccountUsage(id) as import('@cindy/maker-shared/subscription-usage').XaiSubscriptionUsageSnapshot|null});
export const {codexAccountUsageLimit,xaiAccountUsageLimit,subscriptionFamilyOf,sessionUsesOtherMachineAccount,readAccountUsageLimit,readRemoteAccountUsageLimit}=runtime;
