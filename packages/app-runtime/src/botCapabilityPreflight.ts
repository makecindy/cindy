import { eq } from 'drizzle-orm';
import type { Session } from '@cindy/maker-core';
import type { MakerSessionCreateOpts } from '@cindy/orca-workflow/host/sessionTypes';
import type { DbClient } from '@cindy/runtime-db';
import { sessions, botSessionLinks } from '@cindy/runtime-db/schema';
import { dbToMakerAgentKind } from '@cindy/maker-shared/agent-kind-conversion';
import { permissionModeOrAsk } from '@cindy/maker-shared/permission-mode';
import { throwIpcError } from '@cindy/remote-agent/ipcValidate';
import { prepareBotCapabilityEpochBeforeSend, type BotCompactRuntimeRefreshCoordinator } from './botCompactRuntimeRefresh.js';

export function createBotCapabilityPreflight(host: {
  getDbClient(): DbClient;
  coordinator: BotCompactRuntimeRefreshCoordinator;
  buildCreateOptsWithStderr(options: MakerSessionCreateOpts): MakerSessionCreateOpts;
  synthesizeOrcaVendorOptionsFromDb(id: string, options: MakerSessionCreateOpts): Promise<unknown>;
  readSessionExtraDirsFromDb(id: string): Promise<string[]>;
  preflightBotRuntimeResources(options: MakerSessionCreateOpts): Promise<{ runtimeEpochChanged?: boolean } | null | undefined>;
}) {
const {getDbClient}=host;
return async(live:Session):Promise<void>=>{
    const outcome = await prepareBotCapabilityEpochBeforeSend(live, {
      coordinator: host.coordinator,
      readSession: async () => {
        const db = getDbClient().drizzle;
        const [row] = await db
          .select({
            role: botSessionLinks.role,
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
          .where(eq(sessions.id, live.id))
          .limit(1);
        return row;
      },
      preflight: async (row) => {
        const createOpts = host.buildCreateOptsWithStderr({
          id: live.id,
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
        await host.synthesizeOrcaVendorOptionsFromDb(live.id, createOpts);
        const extraDirs = await host.readSessionExtraDirsFromDb(live.id).catch(() => []);
        if (extraDirs.length > 0) createOpts.extraDirs = extraDirs;
        const snapshot = await host.preflightBotRuntimeResources(
          createOpts as MakerSessionCreateOpts,
        );
        return !!snapshot?.runtimeEpochChanged;
      },
    });
    if (outcome === 'deferred') {
      throwIpcError(
        'PRECONDITION_FAILED',
        '伙伴能力正在刷新，请稍后再发送',
      );
    }
};
}
