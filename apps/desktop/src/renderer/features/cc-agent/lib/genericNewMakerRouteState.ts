import { matchPath } from 'react-router-dom';
import { resolveAgentIslandVisibleSessionIdFromPath } from '@/lib/agentIslandVisibleSessionRoute';
import { sessionsStore } from '@/lib/sessionsStore';
import { canonicalBotSessionId, getBotProfiles } from '@/features/bots/botStore';
import { findBotProfileForSession } from '@/features/bots/botSessionOwners';
import { getStickySessionDeviceId } from '@/features/device-link/stickySessionOrigin';
import { remoteProjectsStore } from '@/features/device-link/remoteProjectsStore';
import type { Session } from '@/lib/ccAgent.types';
import { normalizeWorkingDirForProjectSettings } from '../../../../shared/workingDir';
import { makeDialogueNewMakerRouteState, type NewMakerRouteState } from './newMakerRouteState';

interface GenericNewMakerRouteOptions {
  /** ⌘N only: prefer the project visible in the current task over the saved draft. */
  inheritCurrentProject?: boolean;
}

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

function resolveCurrentTaskSession(pathname: string): Session | undefined {
  const sessionId =
    resolveAgentIslandVisibleSessionIdFromPath(pathname) ??
    matchPath('/cc-agent/orca/:sessionId', pathname)?.params.sessionId ??
    matchPath('/cc-agent/files/:sessionId', pathname)?.params.sessionId;
  if (!sessionId || sessionId === 'new') return undefined;

  // A sticky device origin is authoritative for device-link sessions. Do not fall back to a
  // coincidentally cached local row while the remote projection is reconnecting.
  const deviceId = getStickySessionDeviceId(sessionId);
  if (deviceId) {
    return remoteProjectsStore.getDeviceSessions(deviceId).find((session) => session.id === sessionId);
  }

  const session = sessionsStore.findById(sessionId);
  if (!session || session.remoteHostId) return undefined;
  return session;
}

function resolveCurrentTaskProjectWorkingDir(pathname: string): string | null | undefined {
  const session = resolveCurrentTaskSession(pathname);
  if (!session) return undefined;
  if (session.workspaceKind === 'project' && session.workingDir) {
    // Match the draft store's project entry before comparing targets or clearing project-bound state.
    // Only Cindy-managed worktrees fold back; explicitly selected user worktrees keep their cwd.
    return normalizeWorkingDirForProjectSettings(session.workingDir) ?? undefined;
  }
  if (session.workspaceKind === 'dialogue') return null;
  return undefined;
}

/** Capture the current task's computer at the new-task action, before leaving its route. */
export function makeGenericNewMakerRouteState(
  pathname: string,
  options?: GenericNewMakerRouteOptions,
): NewMakerRouteState {
  const deviceId = resolveCurrentTaskDevice(pathname);
  if (deviceId === undefined) return { workspacePrompt: 'generic' };
  const projectWorkingDir = options?.inheritCurrentProject
    ? resolveCurrentTaskProjectWorkingDir(pathname)
    : undefined;
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
      ...(projectWorkingDir !== undefined ? { projectWorkingDir } : {}),
    },
  };
}
