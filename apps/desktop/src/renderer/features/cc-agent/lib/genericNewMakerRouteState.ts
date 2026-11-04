import { matchPath } from 'react-router-dom';
import { resolveAgentIslandVisibleSessionIdFromPath } from '@/lib/agentIslandVisibleSessionRoute';
import { sessionsStore } from '@/lib/sessionsStore';
import { canonicalBotSessionId, getBotProfiles } from '@/features/bots/botStore';
import { findBotProfileForSession } from '@/features/bots/botSessionOwners';
import { getStickySessionDeviceId } from '@/features/device-link/stickySessionOrigin';
import { remoteProjectsStore } from '@/features/device-link/remoteProjectsStore';
import { readAgentSwitchIntent } from '@/lib/agentSwitchIntentReader';
import { readComposerOptimisticSelection } from '@/lib/composerOptimisticSelection';
import type { Session } from '@/lib/ccAgent.types';
import { resolveComposerModelSelection } from '@/components/new-chat/composerModelSelection';
import { dbToMakerAgentKind, makerToDbAgentKind } from '../../../../shared/agentKindConversion';
import {
  makeDialogueNewMakerRouteState,
  type NewMakerModelInheritanceRequest,
  type NewMakerRouteState,
} from './newMakerRouteState';

/** 普通任务路由上正在查看的任务 id;非任务页为 null。 */
function resolveCurrentTaskSessionId(pathname: string): string | null {
  const sessionId =
    resolveAgentIslandVisibleSessionIdFromPath(pathname) ??
    matchPath('/cc-agent/orca/:sessionId', pathname)?.params.sessionId ??
    matchPath('/cc-agent/files/:sessionId', pathname)?.params.sessionId;
  return sessionId && sessionId !== 'new' ? sessionId : null;
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

  const sessionId = resolveCurrentTaskSessionId(pathname);
  if (!sessionId) return undefined;

  const deviceId = getStickySessionDeviceId(sessionId);
  if (deviceId) return deviceId;
  // The ordinary cache includes SSH rows but excludes Bot rows. Neither a
  // cache hit nor a miss alone proves the task runs on this computer.
  const session = sessionsStore.findById(sessionId);
  if (session?.remoteHostId) return undefined;
  if (session || findBotProfileForSession(getBotProfiles(), sessionId)) return null;
  return undefined;
}

let modelInheritanceRequestSequence = 0;

/**
 * 当前任务此刻显示的模型(与任务输入框同一份口径:待生效的切换意图 > 远程乐观切换 >
 * 运行中的 pending > 实际生效值)。Bot 任务的模型链另有规则，不参与继承。
 */
function resolveCurrentTaskModel(pathname: string): NewMakerModelInheritanceRequest | undefined {
  const sessionId = resolveCurrentTaskSessionId(pathname);
  if (!sessionId) return undefined;
  const taskDeviceId = getStickySessionDeviceId(sessionId) ?? null;
  const findRemote = (rows: readonly Session[]) => rows.find((row) => row.id === sessionId);
  const session = taskDeviceId
    ? (findRemote(remoteProjectsStore.getDeviceSessions(taskDeviceId)) ??
      findRemote(remoteProjectsStore.getMergedRemoteSessions()))
    : sessionsStore.findById(sessionId);
  if (!session) return undefined;
  const remoteHostId = taskDeviceId ? null : (session.remoteHostId ?? null);
  // SSH 任务没有跨引擎切换事务，输入框也不读意图(见 ChatInput agentSwitchIntent)。
  const intent = remoteHostId ? null : readAgentSwitchIntent(sessionId);
  const { display } = resolveComposerModelSelection({
    current: {
      agentKind: dbToMakerAgentKind(session.agentKind),
      model: session.model ?? '',
      providerId: session.providerId ?? null,
      effort: session.effort || null,
      fastMode: session.fastMode ?? false,
    },
    effective: session.runtimeEffective,
    pending: session.runtimePending,
    intent,
    // 远程任务刚切模型、被控端还没回流时，输入框乐观显示的那一份(本机任务恒无)。
    optimistic: readComposerOptimisticSelection(sessionId),
  });
  if (!display.model) return undefined;
  const agentDeviceId = remoteHostId
    ? null
    : intent && intent.agentDeviceId !== undefined
      ? intent.agentDeviceId
      : (session.agentDeviceId ?? null);
  modelInheritanceRequestSequence += 1;
  return {
    requestId: `${Date.now()}-${modelInheritanceRequestSequence}`,
    vendor: makerToDbAgentKind(display.agentKind),
    model: display.model,
    providerId: display.providerId || null,
    effort: display.effort || null,
    fastMode: display.fastMode ?? false,
    agentDeviceId: agentDeviceId || null,
    taskDeviceId,
    remoteHostId,
  };
}

/** 新建任务默认沿用当前任务的模型;创建页只在任务电脑相同时套用(见 isSameNewMakerTaskComputer)。 */
export function withCurrentTaskModelInheritance<T extends NewMakerRouteState>(
  state: T,
  pathname: string,
): T {
  const modelInheritanceRequest = resolveCurrentTaskModel(pathname);
  return modelInheritanceRequest ? { ...state, modelInheritanceRequest } : state;
}

/** Capture the current task's computer at the new-task action, before leaving its route. */
export function makeGenericNewMakerRouteState(pathname: string): NewMakerRouteState {
  return withCurrentTaskModelInheritance(makeGenericDeviceRouteState(pathname), pathname);
}

function makeGenericDeviceRouteState(pathname: string): NewMakerRouteState {
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
