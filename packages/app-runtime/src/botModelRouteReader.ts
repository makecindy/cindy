import {and,eq,inArray,isNull} from 'drizzle-orm';
import type {DbClient} from '@cindy/runtime-db';
import {botSessionLinks,botProfiles,botProfileVersions,sessions} from '@cindy/runtime-db/schema';
import type {Maker} from '@cindy/maker-core';
import {dbToMakerAgentKind} from '@cindy/maker-shared/agent-kind-conversion';
import type {PendingAgentSwitchRegistry} from '@cindy/im-runtime/sessionAgentSwitch';
import type {createBotModelChainSettings} from './botModelChainSettings.js';
import type {createSessionRuntimeControl} from './sessionRuntimeControl.js';
import type {createSessionRuntimeAxes} from './sessionRuntimeAxes.js';
import type {createSessionProviderStore} from './sessionProviderStore.js';
import type {BotRouteState} from './botModelRouteReconciler.js';
export interface BotModelRouteReaderHost extends Pick<ReturnType<typeof createSessionRuntimeAxes>,'getSessionEffort'|'getSessionFastMode'>, Pick<ReturnType<typeof createSessionProviderStore>,'getSessionProvider'|'hasSessionProvider'> {
 getDbClient():DbClient;
 maker:Pick<Maker,'getSession'>;
 readEffectiveBotModelSelection:ReturnType<typeof createBotModelChainSettings>['readEffectiveBotModelSelection'];
 getSessionRuntimeControlSnapshot:ReturnType<typeof createSessionRuntimeControl>['getSessionRuntimeControlSnapshot'];
 agentSwitchPending:Pick<PendingAgentSwitchRegistry,'get'>;
}
/** Same profile, lane, override and pending-route reader in GUI and Node hosts. */
export function createBotModelRouteReader(host:BotModelRouteReaderHost) {
 const {getDbClient,maker,readEffectiveBotModelSelection,getSessionRuntimeControlSnapshot,agentSwitchPending,getSessionProvider,hasSessionProvider,getSessionEffort,getSessionFastMode}=host;
 return async (sessionId:string,purpose:'apply'|'preview'):Promise<BotRouteState|null>=>{
      const [row] = await getDbClient().drizzle.select({
        capabilitiesJson: botProfileVersions.capabilitiesJson,
        agentKind: sessions.agentKind,
        agentDeviceId: sessions.agentDeviceId,
        model: sessions.model,
        providerId: sessions.providerId,
        effort: sessions.effort,
        fastMode: sessions.fastMode,
      }).from(botSessionLinks)
        .innerJoin(botProfiles, eq(botProfiles.id, botSessionLinks.botId))
        .innerJoin(botProfileVersions, and(
          eq(botProfileVersions.botId, botProfiles.id),
          eq(botProfileVersions.version, botProfiles.currentVersion),
        ))
        .innerJoin(sessions, eq(sessions.id, botSessionLinks.sessionId))
        .where(and(
          eq(botSessionLinks.sessionId, sessionId),
          // Group / IM channel lanes and private-chat topics follow the Bot's current model chain exactly like its canonical Chat.
          inArray(botSessionLinks.role, ['canonical', 'group', 'channel', 'thread']),
          isNull(botSessionLinks.archivedAt),
          // Paused settings may preview grants; sending still requires an active Bot.
          purpose === 'preview'
            ? inArray(botProfiles.status, ['active', 'paused'])
            : eq(botProfiles.status, 'active'),
          eq(sessions.source, 'bot'),
          eq(sessions.status, 'active'),
        )).limit(1);
      if (!row) return null;
      const selection = await readEffectiveBotModelSelection(JSON.parse(row.capabilitiesJson));
      const control = getSessionRuntimeControlSnapshot(sessionId);
      const intent = agentSwitchPending.get(sessionId);
      const live = maker.getSession(sessionId);
      return {
        chain: selection.chain,
        followsCindyDefault: selection.followsCindyDefault,
        current: {
          agentDeviceId: row.agentDeviceId,
          agentKind: live?.agentKind ?? dbToMakerAgentKind(row.agentKind),
          model: live?.model ?? row.model ?? '',
          providerId: live && hasSessionProvider(sessionId)
            ? getSessionProvider(sessionId) ?? null : row.providerId,
          effort: (live ? getSessionEffort(sessionId) : row.effort) ?? null,
          fastMode: live ? getSessionFastMode(sessionId) : (row.fastMode ?? false),
        },
        hasRuntimeOverride: control.effectiveOverride !== null || control.pending !== null || !!intent,
        next: intent ? { agentDeviceId: intent.targetAgentDeviceId === undefined ? row.agentDeviceId : intent.targetAgentDeviceId, agentKind: intent.targetAgentKind, model: intent.model,
          providerId: intent.providerId ?? null, effort: intent.effort ?? null, fastMode: intent.fastMode ?? false }
          : control.pending?.profile ?? control.effectiveOverride ?? undefined,
      };

 };
}
