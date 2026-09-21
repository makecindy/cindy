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
import { createLogger } from '../logger.js';
import { CURRENT_CINDY_REGION } from '../../shared/brandRegion.js';
import type {
  CindyMakeCompletionMeta,
  CindyMakeTestAction,
} from '../../shared/cindyMakeSession.js';
import { parseCindyMakeBuildLogs } from '../../shared/cindyMakeSession.js';
import { parseCindyMakeBuildDiagnostic } from '../../shared/cindyMakeBuildDiagnostic.js';
import { createMakeTestController, type MakeTestContext } from './testController.js';
import { launchMakeTest, makeTestError, verifyMakeTestWorkspace } from './testRunner.js';
import {
  createMakeToolchainEnvironment,
  resolveMakeToolEnvironment,
} from './toolchainEnvironment.js';
import { cindyMakeManager } from './manager.js';
import { isCindyMakeWorktreePath, makeSourceRoot, makeSourceCheckoutPath } from './sourcePaths.js';
import { historyBuildRollback } from './buildRollback.js';
import {
  getCindyMakeHistory,
  recoverHistoryBuildRollback,
  integrateCompletionForBuild,
} from './historyRuntime.js';
import {
  buildCindyPersonal,
  personalArtifactPath,
  personalBuildEnvironment,
  type PersonalArtifact,
} from './personalBuild.js';
import { untilAborted } from './doctor.js';
import { currentVersionProfile, rememberOriginalVersion } from './versionStartup.js';
import { hasPublishedPersonalVersionCommit } from './versionStore.js';
import { captureMakeHistoryStore } from './historyOwner.js';
import { captureMakeHistoryCompletion } from './historyCapture.js';
import { broadcastMakeRemoteChanged } from './remoteBroadcast.js';

let isRunning: (sessionId: string) => boolean = () => true;
const log = createLogger('cindy-make-test');
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
    if (meta && typeof meta.reportedAt === 'number' && Number.isFinite(meta.reportedAt)) {
      if (meta.personal) {
        const logs = parseCindyMakeBuildLogs(meta.personal.logs);
        return {
          ...meta,
          personal: {
            ...meta.personal,
            ...(logs ? { logs } : {}),
            diagnostic:
              meta.personal.status === 'failed'
                ? parseCindyMakeBuildDiagnostic(meta.personal.diagnostic)
                : undefined,
          },
        };
      }
      return meta;
    }
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
    if (patch.test) {
      const receipt = {
        runId: context.runId,
        completionId: context.completionId,
        status: patch.test.status,
        step: patch.test.step,
        error: patch.test.error,
      };
      if (patch.test.status === 'failed') log.warn('Isolated test failed', receipt);
      else log.debug('Isolated test state', receipt);
    }
    if (patch.personal) {
      const receipt = {
        runId: context.runId,
        completionId: context.completionId,
        buildId: patch.personal.buildId,
        status: patch.personal.status,
        checkStep: patch.personal.checkStep,
        error: patch.personal.error,
      };
      if (patch.personal.status === 'failed') log.warn('Personal build failed', receipt);
      else log.debug('Personal build state', receipt);
    }
    captureMakeHistoryCompletion(
      captureMakeHistoryStore(),
      context.runId,
      context.completionId,
      next,
    );
    await broadcastMessageAgentMetaUpdate(context.sessionId, context.completionId, fresh.scope);
    broadcastMakeRemoteChanged(context.sessionId, fresh.scope);
    return next;
  });
}

export const cindyMakeTestController = createMakeTestController({
  load,
  save,
  claimBuild: (context) =>
    cindyMakeManager.claimPersonalBuild([context.sessionId], () => context.isCurrent()),
  onBuildState: (context, state) => {
    if (!context.isCurrent()) throw makeTestError('unavailable');
    const store = captureMakeHistoryStore();
    store.saveBuild(state);
    if (state.status === 'ready' && state.commit) {
      for (const feature of state.includedFeatures ?? [])
        store.version(feature.runId, {
          operationId: feature.operationId,
          commit: state.commit,
          versionId: state.versionId,
          at: state.generatedAt ?? Date.now(),
        });
    }
  },
  withUse: (context, run) => cindyMakeManager.withProjectUse(makeSourceRoot(context.userData), run),
  build: (context, signal, publish) => {
    let entered = false;
    let enteredBuilder = false;
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
        await publish({ status: 'waiting', preparationStep: 'environment' });
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
        await publish({ status: 'waiting', preparationStep: 'original' });
        await rememberOriginalVersion(node.path);
        await integrateCompletionForBuild(context, signal, publish);
        signal.throwIfAborted();
        if (!context.isCurrent()) throw makeTestError('unavailable');
        const historyStore = captureMakeHistoryStore();
        enteredBuilder = true;
        return await buildCindyPersonal(
          {
            mode: 'personal',
            userData: context.userData,
            completionId: context.meta.personal?.buildId ?? context.completionId,
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
            ...historyBuildRollback(
              historyStore,
              makeSourceCheckoutPath(context.userData),
              (commit) => hasPublishedPersonalVersionCommit(context.userData, commit),
            ),
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
    return untilAborted(work, waiting.signal)
      .catch(async (error) => {
        if (!enteredBuilder && context.isCurrent()) {
          const merge = cindyMakeManager.getState().upstreamMerge;
          if (context.isCurrent() && !(merge?.hasWorkspace && merge.status !== 'merged'))
            await recoverHistoryBuildRollback(true);
        }
        throw error;
      })
      .finally(() => signal.removeEventListener('abort', abortWaiting));
  },
  openBuild: async (context) => {
    try {
      const artifact = await personalArtifactPath(
        context.userData,
        context.meta.personal?.buildId ?? context.completionId,
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
  launch: (context, signal, publish) =>
    cindyMakeManager.withProject(
      makeSourceRoot(context.userData),
      async () => {
        publish('environment');
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
        publish('workspace');
        await verifyMakeTestWorkspace(context, env, signal);
        const node = await environment.probe('node', ['--version'], signal);
        const pnpm = await environment.probe('pnpm', ['--version'], signal);
        if (
          node.status !== 'ok' ||
          !node.path ||
          !path.isAbsolute(node.path) ||
          pnpm.status !== 'ok' ||
          !pnpm.path ||
          !path.isAbsolute(pnpm.path)
        )
          throw makeTestError('environment');
        signal.throwIfAborted();
        if (!context.isCurrent()) throw makeTestError('unavailable');
        publish('stopping');
        return launchMakeTest(
          context,
          { node: node.path, pnpm: pnpm.path },
          env,
          CURRENT_CINDY_REGION === 'cn' ? 'cn' : 'global',
          signal,
          undefined,
          publish,
          (diagnostic) => {
            const entry = {
              runId: context.runId,
              completionId: context.completionId,
              ...diagnostic,
            };
            if (diagnostic.event === 'failed') log.warn('Isolated test launcher failed', entry);
            else log.debug('Isolated test launcher', entry);
          },
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
      let history = await getCindyMakeHistory(context.runId);
      if (!context.isCurrent()) throw makeTestError('unavailable');
      if (history.busy) throw makeTestError('unavailable');
      if (captureMakeHistoryStore().readBuildRollback().length) {
        await recoverHistoryBuildRollback();
        history = await getCindyMakeHistory(context.runId);
        if (!context.isCurrent() || history.busy) throw makeTestError('unavailable');
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
      code === 'environment' || code === 'changed' || code === 'stopFailed' ? code : 'unavailable',
    );
  }
}
