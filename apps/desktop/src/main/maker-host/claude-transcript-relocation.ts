import { createClaudeTranscriptRelocation } from '@cindy/app-runtime/claudeTranscriptRelocation';
import { getDbClient } from '../localDb/client/current.js';
import { createLogger } from '../logger.js';
import { defaultClaudeConfigDirCandidates } from '../maker-orchestration/claudeTranscriptAnchors.js';
export type * from '@cindy/app-runtime/claudeTranscriptRelocation';
export const { setLiveCcSessionBridge, collectClaudeSdkSessionIds, relocateClaudeTranscriptsForSessionMove } = createClaudeTranscriptRelocation({
 getDbClient: () => getDbClient(), defaultClaudeConfigDirCandidates: () => defaultClaudeConfigDirCandidates(),
 logger: createLogger('claude-transcript-relocation'),
});
