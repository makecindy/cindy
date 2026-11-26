import { getMakerIfReady } from '../../maker-host/index.js';
import { rehydrateCloseSuppression } from '../../maker-host/rehydrateCloseSuppression.js';

/** Keep the idle Claude handle available until transcript relocation reads its resume ID. */
export async function closeIdleDesktopSessionForMove(sessionId: string, storedAgentKind: string): Promise<boolean> {
  const maker = getMakerIfReady();
  const live = maker?.getSession(sessionId);
  if (live?.isTurnRunning()) return false;
  if (maker && storedAgentKind !== 'cc') {
    await rehydrateCloseSuppression.withSuppressed(sessionId, () => maker.closeSession(sessionId));
  }
  return true;
}
