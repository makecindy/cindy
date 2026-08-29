import type { Maker } from '@cindy/maker-core';

/**
 * Stop every live local ordinary Pi runtime after Settings changes the managed
 * package roster. Pi loads extensions only at process startup, so leaving an
 * existing process alive would make the Settings state a lie: disabled code
 * could keep exposing tools, or a newly enabled package would remain absent.
 *
 * Remote and Review runtimes never load this local managed-package roster and
 * are deliberately outside this invalidation boundary.
 */
export async function invalidateLocalPiPackageRuntimes(
  maker: Pick<Maker, 'listActiveSessions' | 'getSessionMeta' | 'closeSession'>,
): Promise<string[]> {
  const candidates = maker.listActiveSessions().filter((session) => session.agentKind === 'pi');
  const eligible = (await Promise.all(candidates.map(async (session) => ({
    session,
    meta: await maker.getSessionMeta(session.id),
  })))).filter(({ meta }) => meta && !meta.remoteHostId && !meta.reviewMode);

  // Queue every close before awaiting convergence. One slow process must not
  // leave sibling Pi runtimes running the extension merely because it happened
  // to appear earlier in the session map.
  await Promise.all(eligible.map(({ session }) => maker.closeSession(session.id, 'requested')));
  return eligible.map(({ session }) => session.id);
}
