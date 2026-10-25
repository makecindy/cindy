import type { AgentInputQueuedMessage } from '@cindy/maker-shared/agent-input-queue';
export interface UsageLimitRecoverySnapshot {
  kind: 'active-turn' | 'queue-head';
  item: AgentInputQueuedMessage;
  error: string;
}

