import {randomUUID} from 'node:crypto';
import {eq} from 'drizzle-orm';
import type {Maker,Session} from '@cindy/maker-core';
import type {MakerSessionCreateOpts} from '@cindy/orca-workflow/host/sessionTypes';
import type {DbClient} from '@cindy/runtime-db';
import type {DbLogger} from '@cindy/runtime-db/logging';
import {sessions,botSessionLinks,botLifecycleEvents} from '@cindy/runtime-db/schema';
import {dbToMakerAgentKind} from '@cindy/maker-shared/agent-kind-conversion';
import {permissionModeOrAsk} from '@cindy/maker-shared/permission-mode';
import {replaceBotRuntimeAfterPreflight,type BotCompactBoundary,type BotCompactRuntimeSession,type BotCompactRuntimeRefreshOutcome} from './botCompactRuntimeRefresh.js';
export interface BotRuntimeRefreshHost {
 getDbClient():DbClient;
 maker:Pick<Maker,'getSession'|'closeSession'>;
 log:DbLogger;
 withSendToSessionLock<T>(id:string,work:()=>Promise<T>):Promise<T>;
 hasPendingAgentInteractionForSession(id:string):boolean;
 hasPendingAgentSwitch(id:string):boolean;
 applyPendingAgentSwitch(id:string):Promise<unknown>;
 buildCreateOptsWithStderr(options:MakerSessionCreateOpts):MakerSessionCreateOpts;
 synthesizeOrcaVendorOptionsFromDb(id:string,options:MakerSessionCreateOpts):Promise<unknown>;
 readSessionExtraDirsFromDb(id:string):Promise<string[]>;
 checkWorkDirExists(id:string,dir:string,kind:MakerSessionCreateOpts['agentKind'],remoteHostId?:string):Promise<boolean>;
 ensureRemoteReadyForSessionStart(input:{createOpts:MakerSessionCreateOpts}):Promise<unknown>;
 withRehydrateCloseSuppressed<T>(id:string,work:()=>Promise<T>):Promise<T>;
 preflightBotRuntimeResources(options:MakerSessionCreateOpts):Promise<unknown>;
 bootstrapSession(options:MakerSessionCreateOpts):Promise<{session:Session}>;
 markOrcaRoleIfNeeded(id:string,role:MakerSessionCreateOpts['orcaRole']):Promise<unknown>;
 broadcastSessionCreated(id:string):void;
}
/** Original safe Bot refresh transaction; GUI and Node hosts supply lifecycle ports. */
export function createBotRuntimeRefreshHost(host:BotRuntimeRefreshHost): (session:BotCompactRuntimeSession,boundary:BotCompactBoundary)=>Promise<BotCompactRuntimeRefreshOutcome> {
 const {getDbClient,maker,log,withSendToSessionLock,hasPendingAgentInteractionForSession,buildCreateOptsWithStderr,synthesizeOrcaVendorOptionsFromDb,readSessionExtraDirsFromDb,checkWorkDirExists,ensureRemoteReadyForSessionStart,withRehydrateCloseSuppressed,preflightBotRuntimeResources,bootstrapSession,markOrcaRoleIfNeeded,broadcastSessionCreated}=host;
  async function recordBotCompactRuntimeLifecycle(input: {
    botId: string;
    sessionId: string;
    eventType: 'compact-runtime-refresh-requested' | 'compact-runtime-refresh-applied' |
      'compact-runtime-refresh-deferred' | 'compact-runtime-refresh-failed';
    boundary: BotCompactBoundary;
    profileVersion: number;
    reason?: string;
  }): Promise<void> {
    await getDbClient().drizzle.insert(botLifecycleEvents).values({
      id: randomUUID(),
      botId: input.botId,
      sessionId: input.sessionId,
      eventType: input.eventType,
      payloadJson: JSON.stringify({
        profileVersion: input.profileVersion,
        runtimeInstanceId: input.boundary.sessionInstanceId,
        compactBoundaryCount: input.boundary.boundaryCount,
        firstObservedAt: input.boundary.firstObservedAt,
        lastObservedAt: input.boundary.lastObservedAt,
        ...(input.reason ? { reason: input.reason } : {}),
      }),
      createdAt: Date.now(),
    });
  }

  return async (
    compactSession,
    boundary,
  ): Promise<BotCompactRuntimeRefreshOutcome> => {
    const expectedSession = compactSession as Session;
    return withSendToSessionLock(expectedSession.id, async () => {
      if (maker.getSession(expectedSession.id) !== expectedSession) return 'not-bot';

      const db = getDbClient().drizzle;
      const [row] = await db
        .select({
          botId: botSessionLinks.botId,
          role: botSessionLinks.role,
          profileVersion: botSessionLinks.profileVersion,
          source: sessions.source,
          status: sessions.status,
          title: sessions.title,
          workingDir: sessions.workingDir,
          workspaceKind: sessions.workspaceKind,
          agentKind: sessions.agentKind,
          model: sessions.model,
          providerId: sessions.providerId,
          effort: sessions.effort,
          fastMode: sessions.fastMode,
          permissionMode: sessions.permissionMode,
          planModeEnabled: sessions.planModeEnabled,
          sdkSessionId: sessions.sdkSessionId,
          remoteHostId: sessions.remoteHostId,
          orcaRole: sessions.orcaRole,
          codexHistoryHasProductPrompt: sessions.codexHistoryHasProductPrompt,
        })
        .from(sessions)
        .innerJoin(botSessionLinks, eq(botSessionLinks.sessionId, sessions.id))
        .where(eq(sessions.id, expectedSession.id))
        .limit(1);
      if (
        !row ||
        row.source !== 'bot' ||
        row.status !== 'active' ||
        (row.role !== 'canonical' && row.role !== 'delegation' && row.role !== 'group'
          && row.role !== 'channel' && row.role !== 'thread')
      ) {
        return 'not-bot';
      }
      if (row.role === 'delegation') {
        // These short-lived delegation runs own their own terminal archive
        // transaction. Rebuilding one here would race that owner and could
        // resurrect it.
        return 'not-bot';
      }
      if (
        expectedSession.isTurnRunning() ||
        expectedSession.listBackgroundTasks().length > 0 ||
        hasPendingAgentInteractionForSession(expectedSession.id)
      ) {
        await recordBotCompactRuntimeLifecycle({
          botId: row.botId,
          sessionId: expectedSession.id,
          eventType: 'compact-runtime-refresh-deferred',
          boundary,
          profileVersion: row.profileVersion,
          reason: 'runtime-busy',
        });
        return 'deferred';
      }
      if (!row.workingDir) {
        await recordBotCompactRuntimeLifecycle({
          botId: row.botId,
          sessionId: expectedSession.id,
          eventType: 'compact-runtime-refresh-failed',
          boundary,
          profileVersion: row.profileVersion,
          reason: 'working-dir-missing',
        });
        return 'not-bot';
      }

      // Only a canonical Bot may eagerly settle a settings switch. The ordinary
      // task picker retains its existing next-send semantics. Do not rebuild
      // from the pre-switch row or close a healthy runtime after a failed switch.
      if (host.hasPendingAgentSwitch(expectedSession.id)) {
        await host.applyPendingAgentSwitch(expectedSession.id);
        return host.hasPendingAgentSwitch(expectedSession.id) ? 'deferred' : 'not-bot';
      }

      const createOpts = buildCreateOptsWithStderr({
        id: expectedSession.id,
        agentKind: dbToMakerAgentKind(row.agentKind),
        workingDir: row.workingDir,
        workspaceKind: row.workspaceKind,
        model: row.model ?? undefined,
        providerId: row.providerId,
        effort: (row.effort ?? undefined) as MakerSessionCreateOpts['effort'],
        fastMode: (row.fastMode ?? false),
        permissionMode: permissionModeOrAsk(row.permissionMode),
        planMode: !!row.planModeEnabled,
        title: row.title ?? undefined,
        resumeSessionId: row.sdkSessionId ?? undefined,
        remoteHostId: row.remoteHostId ?? undefined,
        orcaRole: row.orcaRole as MakerSessionCreateOpts['orcaRole'],
        codexHistoryHasProductPrompt: row.codexHistoryHasProductPrompt ?? undefined,
      });
      await synthesizeOrcaVendorOptionsFromDb(expectedSession.id, createOpts);
      const extraDirs = await readSessionExtraDirsFromDb(expectedSession.id).catch((error) => {
        log.warn('Bot compact refresh could not read extra dirs; continuing without them', {
          sessionId: expectedSession.id,
          error: error instanceof Error ? error.message : String(error),
        });
        return [];
      });
      if (extraDirs.length > 0) createOpts.extraDirs = extraDirs;

      const workDirReady = await checkWorkDirExists(
        expectedSession.id,
        createOpts.workingDir,
        createOpts.agentKind,
        createOpts.remoteHostId,
      );
      if (!workDirReady) {
        await recordBotCompactRuntimeLifecycle({
          botId: row.botId,
          sessionId: expectedSession.id,
          eventType: 'compact-runtime-refresh-failed',
          boundary,
          profileVersion: row.profileVersion,
          reason: 'working-dir-unavailable',
        });
        return 'not-bot';
      }

      await recordBotCompactRuntimeLifecycle({
        botId: row.botId,
        sessionId: expectedSession.id,
        eventType: 'compact-runtime-refresh-requested',
        boundary,
        profileVersion: row.profileVersion,
      });
      try {
        await ensureRemoteReadyForSessionStart({ createOpts });
        // Resource drift is a runtime restart boundary, not a reason to destroy the
        // currently healthy runtime. Resolve the exact native Skill/MCP/
        // Toolset bundle before closeSession so a failed preflight leaves the
        // old process and its resume ownership untouched.
        await withRehydrateCloseSuppressed(expectedSession.id, async () => {
          const refreshed = await replaceBotRuntimeAfterPreflight({
            preflight: async () => {
              await preflightBotRuntimeResources(createOpts as MakerSessionCreateOpts);
            },
            isCurrentOwner: () => maker.getSession(expectedSession.id) === expectedSession,
            close: () => maker.closeSession(expectedSession.id, 'runtime-refresh'),
            bootstrap: async () => (await bootstrapSession(createOpts)).session,
          });
          await markOrcaRoleIfNeeded(refreshed.id, createOpts.orcaRole);
          broadcastSessionCreated(refreshed.id);
        });
        await recordBotCompactRuntimeLifecycle({
          botId: row.botId,
          sessionId: expectedSession.id,
          eventType: 'compact-runtime-refresh-applied',
          boundary,
          profileVersion: row.profileVersion,
        });
        return 'refreshed';
      } catch (error) {
        await recordBotCompactRuntimeLifecycle({
          botId: row.botId,
          sessionId: expectedSession.id,
          eventType: 'compact-runtime-refresh-failed',
          boundary,
          profileVersion: row.profileVersion,
          reason:
            error instanceof Error && error.name.trim()
              ? error.name.trim().slice(0, 120)
              : 'Error',
        }).catch(() => undefined);
        throw error;
      }
    });
  };


}
