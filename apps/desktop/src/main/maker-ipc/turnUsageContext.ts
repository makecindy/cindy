// The desktop's turnUsageContext: its core (turnUsageContextCore.ts, shared with the Node Host), with the desktop
// functions it imported before bound to its ports (turnUsagePorts.ts), each resolved when called.
// Bound before the core's code runs; this module's imports are the ones turnUsageContext.ts had.
import '../maker-host/subscription-account-auth.js';
import { isOpenAiSubscriptionProviderId } from '../maker-host/codex-account-auth.desktop.js';
import { bindTurnUsagePorts } from './turnUsagePorts.js';

bindTurnUsagePorts({
  isOpenAiSubscriptionProviderId: (...args) => isOpenAiSubscriptionProviderId(...args),
});

export * from './turnUsageContextCore.js';
