export { WORKING_PHASES, isCompactingWorkingStatus, readWorkingPhase, publicToolPhase, publicToolResultPhase, hasPublicWorkingSubject, WORKING_PHASE_KEYS, type WorkingPhase, type PlainAgentPhase } from '@cindy/maker-shared';
import type { WorkingPhase } from '@cindy/maker-shared';
import type { SupportedLocale } from './locale.js';

export interface WorkingStatusRequest {
  sessionId: string;
  phase: WorkingPhase;
  locale: SupportedLocale;
}
