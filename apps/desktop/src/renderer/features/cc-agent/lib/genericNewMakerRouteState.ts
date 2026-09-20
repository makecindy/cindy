import { matchPath } from 'react-router-dom';
import { resolveAgentIslandVisibleSessionIdFromPath } from '@/lib/agentIslandVisibleSessionRoute';
import { sessionsStore } from '@/lib/sessionsStore';
import { canonicalBotSessionId, getBotProfiles } from '@/features/bots/botStore';
import { findBotProfileForSession } from '@/features/bots/botSessionOwners';
import { getStickySessionDeviceId } from '@/features/device-link/stickySessionOrigin';
import { remoteProjectsStore } from '@/features/device-link/remoteProjectsStore';
import { makeDialogueNewMakerRouteState, type NewMakerRouteState } from './newMakerRouteState';

/** undefined preserves the draft; null is affirmative evidence of local execution. */
function resolveCurrentTaskDevice(pathname: string): string | null | undefined {
  const remoteBot = matchPath('/bots/remote/:deviceId/:botId', pathname);
  if (remoteBot) return remoteBot.params.deviceId;

  const botTask =
    matchPath('/bots/:botId/session/:sessionId', pathname) ??
    matchPath('/bots/:botId/history/:sessionId', pathname);
  const botId = (botTask ?? matchPath('/bots/:botId', pathname))?.params.botId;
  if (botId) {
    if (botId === 'roster' || botId === 'remote') return undefined;
    const bot = getBotProfiles().find((profile) => profile.id === botId);
    if (!bot) return undefined;
    const sessionId = botTask?.params.sessionId ?? canonicalBotSessionId(bot);
    if (!sessionId || !findBotProfileForSession([bot], sessionId)) return undefined;
    return sessionsStore.findById(sessionId)?.remoteHostId ? undefined : null;
  }

  const sessionId =
    resolveAgentIslandVisibleSessionIdFromPath(pathname) ??
    matchPath('/cc-agent/orca/:sessionId', pathname)?.params.sessionId ??
    matchPath('/cc-agent/files/:sessionId', pathname)?.params.sessionId;
  if (!sessionId || sessionId === 'new') return undefined;

  const deviceId = getStickySessionDeviceId(sessionId);
  if (deviceId) return deviceId;
  // The ordinary cache includes SSH rows but excludes Bot rows. Neither a
  // cache hit nor a miss alone proves the task runs on this computer.
  const session = sessionsStore.findById(sessionId);
  if (session?.remoteHostId) return undefined;
  if (session || findBotProfileForSession(getBotProfiles(), sessionId)) return null;
  return undefined;
}

/** Capture the current task's computer at the new-task action, before leaving its route. */
export function makeGenericNewMakerRouteState(pathname: string): NewMakerRouteState {
  const deviceId = resolveCurrentTaskDevice(pathname);
  if (deviceId === undefined) return { workspacePrompt: 'generic' };
  const state = makeDialogueNewMakerRouteState(
    deviceId
      ? {
          deviceId,
          deviceName:
            remoteProjectsStore.getDeviceList().find((device) => device.deviceId === deviceId)
              ?.deviceName ?? deviceId,
        }
      : null,
  );
  return {
    ...state,
    workspacePrompt: 'generic',
    dialogueTargetRequest: {
      ...state.dialogueTargetRequest,
      preserveWorkspaceIfSameDevice: true,
    },
  };
}
