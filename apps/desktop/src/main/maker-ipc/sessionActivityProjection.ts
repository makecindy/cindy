import { createSessionActivityReader, createPersistedSessionActivityReader } from '@cindy/app-runtime/sessionActivityProjection';
export * from '@cindy/app-runtime/sessionActivityProjection';
import type { SessionActivitySnapshot } from '@cindy/maker-shared/session-activity';
import { getAgentIslandService } from '../agent-island/service.js';
import { getDbClient } from '../localDb/client/current.js';
import { readLatestSessionTerminal } from '../localDb/sessionTerminal.js';
const readPersistedSessionActivityFacts=createPersistedSessionActivityReader(()=>getDbClient());
const readDefaultSessionActivity = createSessionActivityReader({
  getLiveSnapshot: (sessionId) =>
    getAgentIslandService()?.getSessionActivitySnapshot(sessionId) ?? null,
  getPersistedFacts: readPersistedSessionActivityFacts,
  getLatestTerminal: readLatestSessionTerminal,
});

/** Main-owned canonical activity read shared by UI-backed state and MCP probes. */
export function readCanonicalSessionActivity(
  sessionId: string,
): Promise<SessionActivitySnapshot> {
  return readDefaultSessionActivity(sessionId);
}
