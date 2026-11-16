/**
 * register.ts's binding of the cold Pi window check (createColdPiRehydrationForWindowVerification): how a
 * released Pi task's runtime is started to read its live window, from the task row (the start options the
 * row maps to, the working directory check, the Orca and directory option preparation, the bootstrap).
 * Moved verbatim so the Node Host starts it the same way with its own start functions.
 */
import type { Maker } from '@cindy/maker-core';
import { eq } from 'drizzle-orm';
import { getDbClient } from '../localDb/client/current.js';
import { sessions } from '../localDb/schema.js';
import { createColdPiRehydrationForWindowVerification } from './coldPiRehydration.js';
import { directoryGrantsForRuntime } from './extraDirsValidator.js';
import type { MakerSessionCreateOpts } from './sessionRequest.js';

type CreateOpts = MakerSessionCreateOpts;

/** register.ts's rehydrateColdPiRuntimeForWindowVerification, as register.ts bound it. */
export function createColdPiRehydrationBinding(ports: {
  maker: Pick<Maker, 'getSession'>;
  buildCreateOptsWithStderr: (opts: CreateOpts) => CreateOpts;
  checkWorkDirExists: (
    sessionId: string,
    workingDir: CreateOpts['workingDir'],
    agentKind: CreateOpts['agentKind'],
    remoteHostId: CreateOpts['remoteHostId'],
  ) => Promise<boolean>;
  synthesizeOrcaVendorOptionsFromDb: (sessionId: string, opts: CreateOpts) => Promise<unknown>;
  readSessionExtraDirsFromDb: (sessionId: string) => Promise<string[]>;
  bootstrapSession: (opts: CreateOpts) => Promise<unknown>;
}) {
  const {
    maker, buildCreateOptsWithStderr, checkWorkDirExists, synthesizeOrcaVendorOptionsFromDb,
    readSessionExtraDirsFromDb, bootstrapSession,
  } = ports;
  const rehydrateColdPiRuntimeForWindowVerification = createColdPiRehydrationForWindowVerification({
    hasLiveSession: (sessionId) => !!maker.getSession(sessionId),
    loadSessionRow: async (sessionId) => {
      const [row] = await getDbClient()
        .drizzle.select()
        .from(sessions)
        .where(eq(sessions.id, sessionId))
        .limit(1);
      return row;
    },
    buildCreateOpts: (sessionId, row) =>
      buildCreateOptsWithStderr({
        id: sessionId,
        agentKind: 'pi',
        workingDir: row.workingDir,
        model: row.model,
        providerId: row.providerId,
        effort: (row.effort ?? undefined) as CreateOpts['effort'],
        fastMode: (row.fastMode ?? false),
        permissionMode: (row.permissionMode ?? 'ask') as CreateOpts['permissionMode'],
        planMode: !!row.planModeEnabled,
        title: row.title ?? undefined,
        resumeSessionId: row.sdkSessionId,
        orcaRole: row.orcaRole ?? undefined,
      }),
    checkWorkDirExists: (sessionId, workingDir, agentKind, remoteHostId) =>
      checkWorkDirExists(sessionId, workingDir, agentKind, remoteHostId),
    prepareCreateOpts: async (sessionId, createOpts) => {
      await synthesizeOrcaVendorOptionsFromDb(sessionId, createOpts);
      const extraDirs = await readSessionExtraDirsFromDb(sessionId);
      Object.assign(createOpts, directoryGrantsForRuntime(extraDirs));
    },
    bootstrapSession: (createOpts) => bootstrapSession(createOpts),
  });
  return rehydrateColdPiRuntimeForWindowVerification;
}
