// The desktop's turnUsageContext: its core (turnUsageContextCore.ts, shared with the Node Host), with the desktop
// functions it imported before bound to its ports (turnUsagePorts.ts), each resolved when called.
// The core calls no port while its module loads (export * evaluates it before the binding below runs);
// each port is resolved when it is called. This module's imports are the ones turnUsageContext.ts had.
import '../maker-host/subscription-account-auth.js';
import { isOpenAiSubscriptionProviderId } from '../maker-host/codex-account-auth.desktop.js';
import { bindTurnUsagePorts } from './turnUsagePorts.js';

bindTurnUsagePorts({
  isOpenAiSubscriptionProviderId: (...args) => isOpenAiSubscriptionProviderId(...args),
});

export * from './turnUsageContextCore.js';
