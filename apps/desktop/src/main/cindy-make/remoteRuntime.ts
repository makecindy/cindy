import { createHash } from 'node:crypto';
import { and, desc, eq, gt, isNull, or, sql } from 'drizzle-orm';
import { getDbClient } from '../localDb/client/current.js';
import { sessions, messages } from '../localDb/schema.js';
import {
  captureDataOwnerBroadcastScope,
  isDataOwnerBroadcastScopeCurrent,
} from '../device-link/broadcast-tap.js';
import {
  remoteResourceRegistry,
  RemoteResourceRegistryError,
} from '../device-link/remoteResourceRegistry.js';
import { resolvePreferredSystemLocale } from '../../shared/locale.js';
import { t } from '../i18n.js';
import { cindyMakeManager } from './manager.js';
import { actCindyMakeTest } from './testRuntime.js';
import {
  getCindyMakeHistory,
  cancelHistoryPersonalVersion,
  readCindyMakeBuildState,
} from './historyRuntime.js';
import { restoreCindyMakeTaskState, startCindyMakeTask } from './taskRuntime.js';
import { createMakeRemoteProvider } from './remoteProvider.js';
import { broadcastMakeRemoteChanged } from './remoteBroadcast.js';
import { projectMakeRemoteCard, type MakeRemoteSnapshot } from './remoteProjection.js';
import type { CindyMakeCompletionMeta } from '../../shared/cindyMakeSession.js';

const unavailable = () =>
  new RemoteResourceRegistryError('NOT_FOUND', 'Cindy Make task is unavailable');
const parse = (raw: string | null): Record<string, unknown> => {
  try {
    const value = JSON.parse(raw ?? '{}');
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
};

/** Account-bound adapter. Only the explicit portable projection leaves this module. */
export function registerMakeRemoteResources(isRunning: (id: string) => boolean): void {
  let restored:
    { client: ReturnType<typeof getDbClient>; stamp: string; ready: Promise<void> } | undefined;
  const load = async (sessionId: string) => {
    if (!/^[A-Za-z0-9-]{1,128}$/.test(sessionId)) throw unavailable();
    const client = getDbClient();
    const scope = captureDataOwnerBroadcastScope();
    const isCurrent = () => {
      try {
        return isDataOwnerBroadcastScopeCurrent(scope) && getDbClient() === client;
      } catch {
        return false;
      }
    };
    const stamp = JSON.stringify(scope);
    if (!restored || restored.client !== client || restored.stamp !== stamp) {
      const ready = restoreCindyMakeTaskState();
      restored = { client, stamp, ready };
      void ready.catch(() => {
        if (restored?.ready === ready) restored = undefined;
      });
    }
    await restored.ready;
    if (!isCurrent()) throw unavailable();
    const db = client.drizzle;
    const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
    if (
      !session ||
      !isCurrent() ||
      session.source !== 'cindy-make' ||
      session.remoteHostId ||
      session.status !== 'active'
    )
      throw unavailable();
    const rows = await db
      .select({
        clientId: messages.clientId,
        role: messages.role,
        agentMeta: messages.agentMeta,
        createdAt: messages.createdAt,
      })
      .from(messages)
      .where(
        and(
          eq(messages.sessionId, sessionId),
          isNull(messages.rewindAt),
          or(eq(messages.role, 'assistant'), eq(messages.role, 'user')),
          session.clearedAt ? gt(messages.createdAt, session.clearedAt) : undefined,
        ),
      )
      .orderBy(desc(messages.createdAt), sql`rowid DESC`)
      .limit(100);
    if (!isCurrent()) throw unavailable();
    let completion: MakeRemoteSnapshot['completion'];
    let recoverable = false;
    let recoveryId: string | undefined;
    let sawTurnEnd = false;
    for (const row of rows) {
      const meta = parse(row.agentMeta);
      if (meta.parentUuid) continue;
      if (row.role === 'user') break;
      const done = meta.cindyMakeCompletion as CindyMakeCompletionMeta | undefined;
      if (done && typeof done.reportedAt === 'number' && Number.isFinite(done.reportedAt)) {
        completion = { id: row.clientId, meta: done };
        if (!sawTurnEnd) {
          recoverable = typeof done.continuedAt === 'number';
          if (recoverable) recoveryId = row.clientId;
        }
        break;
      }
      if (!sawTurnEnd && typeof meta.turnCompleted === 'boolean') {
        sawTurnEnd = true;
        recoverable = meta.turnCompleted;
        if (recoverable) recoveryId = row.clientId;
      }
    }
    if (completion && !completion.meta.continuedAt) {
      completion.meta = await actCindyMakeTest(sessionId, completion.id, 'status');
      if (!isCurrent()) throw unavailable();
    }
    const prep = Object.values(cindyMakeManager.getState().tasks ?? {}).find(
      (report) => report.task?.sessionId === sessionId,
    );
    const sharedBuild = readCindyMakeBuildState();
    const merge = cindyMakeManager.getState().upstreamMerge;
    const snapshot: MakeRemoteSnapshot = {
      sessionId,
      revision: '',
      busy: isRunning(sessionId),
      completion,
      preparation: session.lastTurnEndedAt == null && !session.clearedAt ? prep : undefined,
      sharedBuild:
        sharedBuild &&
        (!['ready', 'failed'].includes(sharedBuild.status) ||
          sharedBuild.buildId === completion?.meta.personal?.buildId)
          ? sharedBuild
          : undefined,
      recoverable,
      sourceMergePending:
        !!merge && merge.status !== 'merged' && (merge.hasWorkspace || merge.cancellationRequested),
    };
    snapshot.revision = createHash('sha256')
      .update(JSON.stringify([snapshot, rows[0]?.clientId, session.clearedAt]))
      .digest('hex')
      .slice(0, 24);
    return { snapshot, session, isCurrent, scope, recoveryId };
  };
  remoteResourceRegistry.register(
    createMakeRemoteProvider({
      load,
      translate(locale, key, values) {
        let text = t(key, locale ? resolvePreferredSystemLocale([locale]) : undefined);
        for (const [name, value] of Object.entries(values ?? {}))
          text = text.replaceAll(`{{${name}}}`, value);
        return text;
      },
      async act(sessionId, actionId, isCurrent) {
        const state = await load(sessionId);
        if (
          !isCurrent() ||
          !state.isCurrent() ||
          !projectMakeRemoteCard(state.snapshot, (key) => key).actions?.some(
            (action) => action.id === actionId && !action.disabled,
          )
        )
          throw unavailable();
        const [kind, id, action] = actionId.split(':');
        if (kind === 'test') await actCindyMakeTest(sessionId, id, action);
        else if (kind === 'build' && action === 'stop') await cancelHistoryPersonalVersion(id);
        else if (kind === 'prepare' && action === 'stop')
          cindyMakeManager.cancelTasksForSession(sessionId);
        else if (kind === 'prepare' && action === 'retry') {
          const history = await getCindyMakeHistory(id);
          const item = history.items.find((entry) => entry.runId === id);
          if (
            !isCurrent() ||
            !state.isCurrent() ||
            item?.sessionId !== sessionId ||
            !item.actions.includes('retry-prepare')
          )
            throw unavailable();
          await startCindyMakeTask(
            {
              runId: item.runId,
              request: item.request,
              title: item.title.slice(0, 200),
            },
            0,
          );
        } else if (
          kind === 'resume' &&
          id === state.snapshot.revision &&
          state.recoveryId &&
          (action === 'start' || action === 'build')
        ) {
          await actCindyMakeTest(sessionId, state.recoveryId, `resume-${action}`);
        } else throw unavailable();
        broadcastMakeRemoteChanged(sessionId, state.scope);
      },
    }),
  );
}
