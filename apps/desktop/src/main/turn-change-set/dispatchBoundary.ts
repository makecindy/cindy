import type { AgentKind } from '@cindy/maker-core';

import { beginTurnChangeSet, finalizeTurnChangeSet, waitForTurnChangeSetSeal } from './store.js';

/** The session fields the dispatch boundary reads. */
export interface TurnChangeSetDispatchSession {
  id: string;
  agentKind: AgentKind;
  workDir: string;
  remoteHostId: string | null;
}

/** Starts exact turn capture at the accepted, durable user-message boundary. */
export async function beginTurnChangeSetAtDispatch(
  session: TurnChangeSetDispatchSession,
  anchorClientId: string,
): Promise<void> {
  await waitForTurnChangeSetSeal(session.id);
  await finalizeTurnChangeSet(session.id, null, 'partial');
  await waitForTurnChangeSetSeal(session.id);
  await beginTurnChangeSet({
    sessionId: session.id,
    anchorClientId,
    provider: session.agentKind,
    cwd: session.workDir,
    remote: session.remoteHostId !== null,
  });
}
