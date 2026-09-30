import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { and, desc, eq, isNull, or, sql } from 'drizzle-orm';
import { app } from 'electron';
import { getDbClient } from '../localDb/client/current.js';
import { messages, sessions } from '../localDb/schema.js';
import { createMessage } from '../localDb/ipc/messages.js';
import { withSessionRouteLock } from '../localDb/sessionRouteLock.js';
import {
  captureDataOwnerBroadcastScope,
  isDataOwnerBroadcastScopeCurrent,
} from '../device-link/broadcast-tap.js';
import { collectCindyMakeChanges } from './completion.js';
import { cindyMakeManager } from './manager.js';
import { isCindyMakeWorktreePath, makeSourceRoot } from './sourcePaths.js';
import {
  createMakeToolchainEnvironment,
  resolveMakeToolEnvironment,
} from './toolchainEnvironment.js';
import { runSourceGit } from './sourceGit.js';
import { makeTestError } from './testRunner.js';
import { captureMakeHistoryStore } from './historyOwner.js';
import { captureMakeHistoryCompletion } from './historyCapture.js';
import { broadcastMakeRemoteChanged } from './remoteBroadcast.js';

/** Capture current files only for an explicit test/build click, never on opening the editor. */
export async function prepareCindyMakeTest(
  sessionId: string,
  messageId: string,
  isBusy: (sessionId: string) => boolean,
) {
  const client = getDbClient();
  const scope = captureDataOwnerBroadcastScope();
  const history = captureMakeHistoryStore();
  const userData = app.getPath('userData');
  const isCurrent = () => isDataOwnerBroadcastScopeCurrent(scope) && getDbClient() === client;
  const check = () => {
    if (!isCurrent() || isBusy(sessionId) || cindyMakeManager.isTaskPreparing(sessionId))
      throw makeTestError('unavailable');
  };
  return withSessionRouteLock(sessionId, async () => {
    const read = async () => {
      check();
      const [session] = await client.drizzle
        .select()
        .from(sessions)
        .where(eq(sessions.id, sessionId))
        .limit(1);
      if (
        !session ||
        session.source !== 'cindy-make' ||
        session.remoteHostId ||
        session.status !== 'active' ||
        !session.workingDir ||
        !isCindyMakeWorktreePath(userData, session.workingDir)
      )
        throw makeTestError('unavailable');
      const safeMeta = sql`CASE WHEN json_valid(${messages.agentMeta}) THEN ${messages.agentMeta} ELSE '{}' END`;
      const [anchor] = await client.drizzle
        .select()
        .from(messages)
        .where(
          and(
            eq(messages.sessionId, sessionId),
            isNull(messages.rewindAt),
            or(eq(messages.role, 'user'), eq(messages.role, 'assistant')),
            sql`json_extract(${safeMeta}, '$.parentUuid') IS NULL`,
          ),
        )
        .orderBy(desc(messages.createdAt), sql`rowid DESC`)
        .limit(1);
      check();
      if (
        !anchor ||
        anchor.clientId !== messageId ||
        anchor.role !== 'assistant' ||
        (session.clearedAt && anchor.createdAt <= session.clearedAt)
      )
        throw makeTestError('unavailable');
      let meta;
      try {
        meta = JSON.parse(anchor.agentMeta ?? '{}');
      } catch {
        throw makeTestError('unavailable');
      }
      const completion = meta.cindyMakeCompletion;
      if (
        !(
          completion &&
          Number.isFinite(completion.reportedAt) &&
          typeof completion.continuedAt === 'number'
        ) &&
        meta.turnCompleted !== true
      )
        throw makeTestError('unavailable');
      return { session, anchor };
    };
    const initial = await read();
    const workingDir = initial.session.workingDir!;
    return cindyMakeManager.withProject(makeSourceRoot(userData), async () => {
      const signal = AbortSignal.timeout(60_000);
      const environment = await createMakeToolchainEnvironment(userData);
      const env = await resolveMakeToolEnvironment(environment, ['git'], signal);
      const fresh = await read();
      if (
        fresh.session.workingDir !== workingDir ||
        fresh.session.clearedAt !== initial.session.clearedAt
      )
        throw makeTestError('unavailable');
      const facts = await collectCindyMakeChanges(
        (args, cwd, indexFile) => {
          check();
          return runSourceGit(
            { ...env, ...(indexFile ? { GIT_INDEX_FILE: indexFile } : {}) },
            args,
            cwd,
            signal,
          );
        },
        userData,
        workingDir,
      );
      const current = await read();
      if (
        current.session.workingDir !== workingDir ||
        current.session.clearedAt !== initial.session.clearedAt
      )
        throw makeTestError('unavailable');
      const completionId = randomUUID();
      const meta = { ...facts, reportedAt: Date.now() };
      await createMessage(
        sessionId,
        {
          clientId: completionId,
          role: 'assistant',
          content: '',
          agentMeta: { cindyMakeCompletion: meta },
          createdAt: Math.max(meta.reportedAt, initial.anchor.createdAt + 1),
        },
        {
          expectedClearBoundaryMs: initial.session.clearedAt,
          broadcastOwnerScope: scope,
          shouldBroadcast: isCurrent,
        },
      );
      check();
      captureMakeHistoryCompletion(history, path.basename(workingDir), completionId, meta);
      broadcastMakeRemoteChanged(sessionId, scope);
      return { completionId, isCurrent };
    });
  });
}
