import { createSessionLastLiveUsage } from '@cindy/app-runtime/sessionLastLiveUsage';
export type { SessionLastLiveUsage } from '@cindy/app-runtime/sessionLastLiveUsage';
export const {rememberSessionLastLiveUsage, getSessionLastLiveUsage, forgetSessionLastLiveUsage, _resetSessionLastLiveUsageForTests} = createSessionLastLiveUsage();
