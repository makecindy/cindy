import type { AgentInputToolLoopDetails } from '@cindy/maker-shared/agent-input-queue';
import type { ProviderGroupUsageLimit } from '../shared/providerGroup.js';
export type AutoResumeAgentSwitchCause = 'usage-limit' | 'auth' | 'unavailable' | 'overload' | 'failed';
export interface InterruptedTurnErrorSignals { message?: string; sdkError?: string; reason?: string; errorStatus?: number; toolLoop?: AgentInputToolLoopDetails; usageLimit?: boolean; usageResetAt?: number; providerGroupUsageLimit?: ProviderGroupUsageLimit; codexErrorInfo?: string }
