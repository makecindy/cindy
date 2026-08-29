import type { Maker } from '@cindy/maker-core';

import type { PiPackagesChangeOrigin } from './pi-package-store.js';

/**
 * Stop every live local ordinary Pi runtime after Settings changes the managed
 * package roster. Pi loads extensions only at process startup, so leaving an
 * existing process alive would make the Settings state a lie: disabled code
 * could keep exposing tools, or a newly enabled package would remain absent.
 *
 * Remote and Review runtimes never load this local managed-package roster and
 * are deliberately outside this invalidation boundary.
 */
export interface PiPackageRuntimeInvalidationResult {
  requestedSessionIds: string[];
  failedSessionIds: string[];
}

type InvalidationMaker = Pick<
  Maker,
  | 'advanceLocalPiPackageRuntimeGeneration'
  | 'listActiveSessions'
  | 'getSessionMeta'
  | 'closeSession'
>;

export async function invalidateLocalPiPackageRuntimesForObservedChange(
  maker: InvalidationMaker,
  origin: PiPackagesChangeOrigin,
): Promise<PiPackageRuntimeInvalidationResult | null> {
  if (origin !== 'external-runtime') return null;
  return invalidateLocalPiPackageRuntimes(maker);
}

export async function invalidateLocalPiPackageRuntimes(
  maker: InvalidationMaker,
): Promise<PiPackageRuntimeInvalidationResult> {
  // Advance before taking the active-session snapshot. A local Pi startup is
  // then either already published and included below, or observes the newer
  // generation and closes before it can publish with stale package bytes.
  maker.advanceLocalPiPackageRuntimeGeneration();
  const candidates = maker.listActiveSessions().filter((session) => session.agentKind === 'pi');
  const metadata = await Promise.all(candidates.map(async (session) => {
    try {
      const meta = await maker.getSessionMeta(session.id);
      return { session, meta, failed: meta === null };
    } catch {
      // Isolate lookup failures per record. We cannot safely close an unknown
      // remote/Review session, but one bad record must not stop known-local
      // siblings from converging.
      return { session, meta: null, failed: true as const };
    }
  }));
  const eligible = metadata.filter(({ meta }) => meta && !meta.remoteHostId && !meta.reviewMode);
  const metadataFailedSessionIds = metadata.flatMap(({ session, failed }) => (
    failed ? [session.id] : []
  ));

  // Queue every close before awaiting convergence. One slow process must not
  // leave sibling Pi runtimes running the extension merely because it happened
  // to appear earlier in the session map.
  const requestedSessionIds = eligible.map(({ session }) => session.id);
  const outcomes = await Promise.allSettled(
    requestedSessionIds.map((sessionId) => maker.closeSession(sessionId, 'requested')),
  );
  return {
    requestedSessionIds,
    failedSessionIds: [
      ...metadataFailedSessionIds,
      ...outcomes.flatMap((outcome, index) => (
        outcome.status === 'rejected' ? [requestedSessionIds[index]!] : []
      )),
    ],
  };
}
