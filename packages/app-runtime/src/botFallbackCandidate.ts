import type { AgentKind } from '@cindy/maker-core';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { botSessionLinks, botProfileVersions, sessions } from '@cindy/runtime-db/schema';
import type { DbClient } from '@cindy/runtime-db/client/DbClient';
import { nextBotModelRoute } from '@cindy/companion-core/botModelChain';
import type { createBotModelChainSettings } from './botModelChainSettings.js';
import type { createSessionRuntimeControl, SessionRuntimeProfile } from './sessionRuntimeControl.js';
export function createBotFallbackCandidateReader(host: {
  getDbClient(): DbClient;
  readEffectiveBotModelChain: ReturnType<typeof createBotModelChainSettings>['readEffectiveBotModelChain'];
  getSessionRuntimeControlSnapshot: ReturnType<typeof createSessionRuntimeControl>['getSessionRuntimeControlSnapshot'];
}) {
const {getDbClient, readEffectiveBotModelChain, getSessionRuntimeControlSnapshot} = host;
const readBotFallbackCandidate = async (
    sessionId: string,
    current: SessionRuntimeProfile,
    controlSessionId = sessionId,
  ): Promise<{ isBot: boolean; candidate: SessionRuntimeProfile | null }> => {
    const [row] = await getDbClient()
      .drizzle.select({
        capabilitiesJson: botProfileVersions.capabilitiesJson,
        remoteHostId: sessions.remoteHostId,
      })
      .from(botSessionLinks)
      .innerJoin(
        botProfileVersions,
        and(
          eq(botProfileVersions.botId, botSessionLinks.botId),
          eq(botProfileVersions.version, botSessionLinks.profileVersion),
        ),
      )
      .innerJoin(sessions, eq(sessions.id, botSessionLinks.sessionId))
      .where(
        and(
          eq(botSessionLinks.sessionId, sessionId),
          isNull(botSessionLinks.archivedAt),
          inArray(botSessionLinks.role, ['canonical', 'delegation', 'group', 'channel', 'thread']),
        ),
      )
      .limit(1);
    if (!row) return { isBot: false, candidate: null };
    let config: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(row.capabilitiesJson) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        config = parsed as Record<string, unknown>;
      }
    } catch {
      return { isBot: true, candidate: null };
    }
    const chain = await readEffectiveBotModelChain(config);
    const toAgentKind = (harness: string): AgentKind =>
      harness === 'codex' ? 'codex' : harness === 'pi' ? 'pi' : 'claude-code';
    const currentHarness = current.agentKind === 'codex'
      ? 'codex'
      : current.agentKind === 'pi'
        ? 'pi'
        : 'claude';
    const control = getSessionRuntimeControlSnapshot(controlSessionId);
    const [controlSession] = controlSessionId === sessionId ? [{ remoteHostId: row.remoteHostId }]
      : await getDbClient().drizzle.select({ remoteHostId: sessions.remoteHostId })
        .from(sessions).where(eq(sessions.id, controlSessionId)).limit(1);
    const route = nextBotModelRoute(
      chain,
      { harness: currentHarness, model: current.model, providerId: current.providerId, agentDeviceId: current.agentDeviceId },
      control.visitedRoutes,
      (candidate) => !controlSession?.remoteHostId || candidate.harness === currentHarness,
    );
    return {
      isBot: true,
      candidate: route
        ? {
            agentKind: toAgentKind(route.harness),
            agentDeviceId: route.agentDeviceId ?? null,
            model: route.model,
            providerId: route.providerId,
            effort: (route.effort || null) as SessionRuntimeProfile['effort'],
            fastMode: route.fastMode,
          }
        : null,
    };
  };
return readBotFallbackCandidate;
}
