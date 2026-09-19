import path from 'node:path';
import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import { app, shell } from 'electron';
import { getDbClient } from '../localDb/client/current.js';
import { messages, sessions } from '../localDb/schema.js';
import { broadcastMessageAgentMetaUpdate } from '../localDb/ipc/messages.js';
import { withSessionRouteLock } from '../localDb/sessionRouteLock.js';
import {
  captureDataOwnerBroadcastScope,
  isDataOwnerBroadcastScopeCurrent,
} from '../device-link/broadcast-tap.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import { CURRENT_CINDY_REGION } from '../../shared/brandRegion.js';
import type {
  CindyMakeCompletionMeta,
  CindyMakeTestAction,
} from '../../shared/cindyMakeSession.js';
import { createMakeTestController, type MakeTestContext } from './testController.js';
import { launchMakeTest, makeTestError, verifyMakeTestWorkspace } from './testRunner.js';
import {
  createMakeToolchainEnvironment,
  resolveMakeToolEnvironment,
} from './toolchainEnvironment.js';
import { cindyMakeManager } from './manager.js';
import { isCindyMakeWorktreePath, makeSourceRoot } from './sourcePaths.js';
import {
  buildCindyPersonal,
  personalArtifactPath,
  personalBuildEnvironment,
  type PersonalArtifact,
} from './personalBuild.js';
import { untilAborted } from './doctor.js';
import { currentVersionProfile, rememberOriginalVersion } from './versionStartup.js';
import { captureMakeHistoryStore } from './historyOwner.js';
import { captureMakeHistoryCompletion } from './historyCapture.js';

let isRunning: (sessionId: string) => boolean = () => true;
export function configureCindyMakeTestRuntime(probe: typeof isRunning): void {
  isRunning = probe;
}

interface StoredContext extends MakeTestContext {
  client: ReturnType<typeof getDbClient>;
  scope: ReturnType<typeof captureDataOwnerBroadcastScope>;
}

function readCompletion(agentMeta: string | null): CindyMakeCompletionMeta {
  try {
    const meta = JSON.parse(agentMeta ?? '{}').cindyMakeCompletion;
    if (meta && typeof meta.reportedAt === 'number' && Number.isFinite(meta.reportedAt))
      return meta;
  } catch {}
  throw makeTestError('unavailable');
}

async function load(sessionId: string, completionId: string): Promise<StoredContext> {
  const client = getDbClient();
  const scope = captureDataOwnerBroadcastScope();
  const isCurrent = () => {
    try {
      return isDataOwnerBroadcastScopeCurrent(scope) && getDbClient() === client;
    } catch {
      return false;
    }
  };
  const db = client.drizzle;
  const [row] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
  const userData = app.getPath('userData');
  if (
    !isCurrent() ||
    !row ||
    row.source !== 'cindy-make' ||
    row.remoteHostId ||
    row.status !== 'active' ||
    !row.workingDir ||
    !isCindyMakeWorktreePath(userData, row.workingDir)
  )
    throw makeTestError('unavailable');
  const [card] = await db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.sessionId, sessionId),
        eq(messages.role, 'assistant'),
        isNull(messages.rewindAt),
        sql`json_type(CASE WHEN json_valid(${messages.agentMeta}) THEN ${messages.agentMeta} ELSE '{}' END, '$.cindyMakeCompletion') = 'object'`,
      ),
    )
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(1);
  if (
    !isCurrent() ||
    !card ||
    card.clientId !== completionId ||
    (row.clearedAt && card.createdAt <= row.clearedAt)
  )
    throw makeTestError('unavailable');
  const [laterUser] = await db
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.sessionId, sessionId),
        eq(messages.role, 'user'),
        isNull(messages.rewindAt),
        gt(messages.createdAt, card.createdAt),
      ),
    )
    .limit(1);
  if (!isCurrent() || laterUser) throw makeTestError('unavailable');
  const meta = readCompletion(card.agentMeta);
  return {
    sessionId,
    completionId,
    title: row.title ?? undefined,
    meta,
    client,
    scope,
    isCurrent,
    userData,
    workingDir: row.workingDir,
    runId: path.basename(row.workingDir),
    commit: meta.commit ?? '',
    tree: meta.tree,
  };
}

async function save(
  context: MakeTestContext,
  patch: Partial<CindyMakeCompletionMeta>,
): Promise<CindyMakeCompletionMeta> {
  return withSessionRouteLock(context.sessionId, async () => {
    if (!context.isCurrent()) throw makeTestError('unavailable');
    const fresh = await load(context.sessionId, context.completionId);
    if (!context.isCurrent() || fresh.workingDir !== context.workingDir)
      throw makeTestError('unavailable');
    const next = { ...fresh.meta, ...patch };
    // One owner-bound SQL write; preserve unrelated metadata that may arrive concurrently.
    const result = await fresh.client.drizzle
      .update(messages)
      .set({
        agentMeta: sql`json_set(${messages.agentMeta}, '$.cindyMakeCompletion', json(${JSON.stringify(next)}))`,
      })
      .where(
        and(
          eq(messages.sessionId, context.sessionId),
          eq(messages.clientId, context.completionId),
          isNull(messages.rewindAt),
        ),
      )
      .returning({ id: messages.id });
    if (!context.isCurrent() || !result.length) throw makeTestError('unavailable');
    captureMakeHistoryCompletion(
      captureMakeHistoryStore(),
      context.runId,
      context.completionId,
      next,
    );
    await broadcastMessageAgentMetaUpdate(context.sessionId, context.completionId, fresh.scope);
    return next;
  });
}

export const cindyMakeTestController = createMakeTestController({
  load,
  save,
  withUse: (context, run) => cindyMakeManager.withProjectUse(makeSourceRoot(context.userData), run),
  build: (context, signal, publish) => {
    let entered = false;
    const waiting = new AbortController();
    const abortWaiting = () => {
      if (!entered) waiting.abort();
    };
    signal.addEventListener('abort', abortWaiting, { once: true });
    if (signal.aborted) abortWaiting();
    const work = cindyMakeManager.withProject(
      makeSourceRoot(context.userData) + ':personal-build',
      async () => {
        entered = true;
        signal.throwIfAborted();
        const fresh = await load(context.sessionId, context.completionId);
        if (
          !context.isCurrent() ||
          fresh.workingDir !== context.workingDir ||
          fresh.meta.continuedAt ||
          isRunning(context.sessionId) ||
          cindyMakeManager.isTaskPreparing(context.sessionId)
        )
          throw makeTestError('unavailable');
        const environment = await createMakeToolchainEnvironment(context.userData);
        const env = await resolveMakeToolEnvironment(
          environment,
          ['git', 'node', 'pnpm', 'python'],
          signal,
        ).catch(() => {
          throw makeTestError('environment');
        });
        const node = await environment.probe('node', ['--version'], signal);
        const git = await environment.probe('git', ['--version'], signal);
        if (node.status !== 'ok' || !node.path || !path.isAbsolute(node.path))
          throw makeTestError('environment');
        const buildEnv = await personalBuildEnvironment(env, git.path);
        await rememberOriginalVersion(node.path);
        const historyStore = captureMakeHistoryStore();
        return buildCindyPersonal(
          {
            mode: 'personal',
            userData: context.userData,
            completionId: context.completionId,
            title: context.title,
            profile: currentVersionProfile(),
          },
          node.path,
          buildEnv,
          CURRENT_CINDY_REGION,
          signal,
          publish,
          () => {
            if (!context.isCurrent()) throw makeTestError('unavailable');
          },
          (run) => cindyMakeManager.withProject(makeSourceRoot(context.userData), run),
          {
            features: () =>
              historyStore.list().flatMap((record) => {
                const last = record.receipts.at(-1);
                return last ? [{ runId: record.runId, operationId: last.id }] : [];
              }),
          },
        );
      },
      signal,
    );
    return untilAborted(work, waiting.signal).finally(() =>
      signal.removeEventListener('abort', abortWaiting),
    );
  },
  openBuild: async (context) => {
    try {
      const artifact = await personalArtifactPath(
        context.userData,
        context.completionId,
        context.meta.personal as PersonalArtifact,
      );
      if (!context.isCurrent()) throw makeTestError('unavailable');
      shell.showItemInFolder(artifact);
    } catch {
      if (context.isCurrent())
        await save(context, { personal: { status: 'failed', error: 'unavailable' } });
      throw makeTestError('unavailable');
    }
  },
  launch: (context, signal) =>
    cindyMakeManager.withProject(
      makeSourceRoot(context.userData),
      async () => {
        signal.throwIfAborted();
        const fresh = await load(context.sessionId, context.completionId);
        if (
          !context.isCurrent() ||
          fresh.workingDir !== context.workingDir ||
          fresh.meta.continuedAt ||
          isRunning(context.sessionId) ||
          cindyMakeManager.isTaskPreparing(context.sessionId)
        )
          throw makeTestError('unavailable');
        const environment = await createMakeToolchainEnvironment(context.userData);
        const env = await resolveMakeToolEnvironment(
          environment,
          ['git', 'node', 'pnpm'],
          signal,
        ).catch(() => {
          throw makeTestError('environment');
        });
        await verifyMakeTestWorkspace(context, env, signal);
        const node = await environment.probe('node', ['--version'], signal);
        if (node.status !== 'ok' || !node.path || !path.isAbsolute(node.path))
          throw makeTestError('environment');
        signal.throwIfAborted();
        if (!context.isCurrent()) throw makeTestError('unavailable');
        return launchMakeTest(
          context,
          node.path,
          env,
          CURRENT_CINDY_REGION === 'cn' ? 'cn' : 'global',
          signal,
        );
      },
      signal,
    ),
});

export async function actCindyMakeTest(
  sessionId: unknown,
  completionId: unknown,
  action: unknown,
): Promise<CindyMakeCompletionMeta> {
  if (
    typeof sessionId !== 'string' ||
    !/^[A-Za-z0-9-]{1,128}$/.test(sessionId) ||
    typeof completionId !== 'string' ||
    !/^[A-Za-z0-9-]{1,128}$/.test(completionId) ||
    typeof action !== 'string' ||
    !['start', 'continue', 'status', 'build', 'open-build'].includes(action)
  )
    throwIpcError('INVALID_PARAMS', 'Invalid Cindy Make test action');
  try {
    if (action === 'build' && !cindyMakeTestController.isBuilding(sessionId)) {
      await cindyMakeTestController.stopTestForBuild(sessionId);
      const context = await load(sessionId, completionId);
      const { getCindyMakeHistory, actCindyMakeHistory } = await import('./historyRuntime.js');
      const history = await getCindyMakeHistory(context.runId);
      if (!context.isCurrent()) throw makeTestError('unavailable');
      if (
        !['integrated', 'unchanged'].includes(
          history.items.find((item) => item.runId === context.runId)?.integration ?? '',
        )
      ) {
        const updated = await actCindyMakeHistory(context.runId, 'integrate');
        if (
          updated.items.find((item) => item.runId === context.runId)?.integration !== 'integrated'
        )
          return save(context, {
            lastAction: 'build',
            personal: { status: 'failed', error: 'conflict' },
          });
      }
    }
    return await cindyMakeTestController.act(
      sessionId,
      completionId,
      action as CindyMakeTestAction,
    );
  } catch (error) {
    const code = (error as { code?: unknown })?.code;
    throwIpcError(
      'PRECONDITION_FAILED',
      code === 'environment' || code === 'changed' ? code : 'unavailable',
    );
  }
}
