import { assembleSystemPromptSections, TASK_SYSTEM_PROMPT, type AgentKind, type Maker } from '@cindy/maker-core';
import { parseRuntimePluginSettings } from '../../shared/pluginRuntime.js';
import { RuntimePluginControlError, type createRuntimePluginControl } from '../cindy-brain/runtimeControl.js';
import { resolveGhostUserHookModel, withGhostUserHookModel } from '../cindy-brain/subscriptionGateway.js';
import type { createRuntimePluginHost } from '../cindy-brain/runtimePluginHostCore.js';
import { readRuntimePluginSettings, type writeRuntimePluginSettings as WriteRuntimePluginSettings } from '../maker-host/runtime-plugin-settings.js';
import { withRehydrateCloseSuppressed } from '../maker-host/rehydrateCloseSuppression.js';
import { createHostSendFailure } from '../maker-host/send-outcome.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import type { AgentInputCoordinatorDeps } from './agent-input-coordinator.js';
import type { MakerSendTransactionDeps } from './makerSendTransaction.js';
import { createTaskRuntimePlugins } from './runtimePlugins.js';
import type { MakerSessionCreateOpts as CreateOpts } from './sessionRequest.js';
import type { createReadSessionRuntimeProfiles } from './sessionRuntimeSelectionLanding.js';

type PluginHost = ReturnType<typeof createRuntimePluginHost>;
type ReadProfiles = ReturnType<typeof createReadSessionRuntimeProfiles>;

/** The task prompt installed at session creation, with the same check before each send. */
export function createRuntimePluginTaskPrompt({ maker, ghostTaskSystemPrompt, readSessionRuntimeProfiles }: {
  maker: Pick<Maker, 'createSession' | 'getSession' | 'closeSession'>;
  ghostTaskSystemPrompt: PluginHost['ghostTaskSystemPrompt'];
  readSessionRuntimeProfiles: ReadProfiles;
}) {
  const appliedTaskPrompts = new WeakMap<Awaited<ReturnType<typeof maker.createSession>>, string>();
  const readTaskPrompt = (sessionId: string, agentKind: AgentKind, agentDeviceId?: string | null) =>
    ghostTaskSystemPrompt(sessionId, agentKind === 'claude-code' ? 'cc' : agentKind, !(agentKind === 'pi' && agentDeviceId));
  const createSessionWithRuntimePlugins = (o: CreateOpts, signal?: AbortSignal) => {
    if (o.id && maker.getSession(o.id)) return maker.createSession(o, signal);
    const taskPrompt = o.id ? readTaskPrompt(o.id, o.agentKind, o.agentDeviceId) : '';
    if (!taskPrompt) return maker.createSession(o, signal);
    const runtimeOpts = { ...o,
      ...(o.agentKind === 'pi' ? { [TASK_SYSTEM_PROMPT]: taskPrompt } : {
        userPrompt: assembleSystemPromptSections(o.userPrompt?.trim() ?? '', [{ name: 'task', order: 0, text: taskPrompt }]),
      }),
    };
    return maker.createSession(runtimeOpts, signal).then(session => {
      appliedTaskPrompts.set(session, taskPrompt);
      return session;
    });
  };
  const prepareTaskPromptForSend = (sessionId: string): Promise<void> | undefined => {
    const live = maker.getSession(sessionId);
    if (!live) {
      if (!readRuntimePluginSettings(sessionId)?.['system-prompt']?.length) return undefined;
      return readSessionRuntimeProfiles(sessionId).then(profiles => {
        if (!profiles) throw new RuntimePluginControlError('block', '', true, 'task-unavailable');
        readTaskPrompt(sessionId, profiles.effective.agentKind, profiles.effective.agentDeviceId);
      });
    }
    if (live.isTurnRunning() || (appliedTaskPrompts.get(live) ?? '') === readTaskPrompt(sessionId, live.agentKind, live.agentDeviceId)) return undefined;
    return withRehydrateCloseSuppressed(sessionId, () => maker.closeSession(sessionId, 'agent-switch'));
  };
  const assertTaskPromptCurrent = (sessionId: string) => {
    const live = maker.getSession(sessionId);
    if (live && (appliedTaskPrompts.get(live) ?? '') !== readTaskPrompt(sessionId, live.agentKind, live.agentDeviceId)) {
      throw new RuntimePluginControlError('block', '', true, 'prompt-selection-changed');
    }
  };
  return { createSessionWithRuntimePlugins, prepareTaskPromptForSend, assertTaskPromptCurrent };
}

export function createPrepareTaskRuntimePluginTurn({
  maker, runtimePluginControl, readSessionRuntimeProfiles, isPluginModelRouteAvailableNow, applyRoute, log,
}: {
  maker: Pick<Maker, 'getSession'>;
  runtimePluginControl: ReturnType<typeof createRuntimePluginControl>;
  readSessionRuntimeProfiles: ReadProfiles;
  isPluginModelRouteAvailableNow: PluginHost['isPluginModelRouteAvailableNow'];
  applyRoute: Parameters<typeof createTaskRuntimePlugins>[0]['applyRoute'];
  log: Pick<MakerSendTransactionDeps['log'], 'info'>;
}): NonNullable<MakerSendTransactionDeps['prepareRuntimeTurn']> {
  const taskRuntimePlugins = createTaskRuntimePlugins({
    control: runtimePluginControl, readSettings: readRuntimePluginSettings,
    requestSupported: sessionId => !maker.getSession(sessionId)?.remoteHostId,
    readRoute: async sessionId => {
      const profiles = await readSessionRuntimeProfiles(sessionId);
      if (!profiles) throw new Error('Task runtime unavailable');
      const route = profiles.pendingMutation?.profile ?? profiles.effective;
      return { agentKind: route.agentKind === 'claude-code' ? 'cc' : route.agentKind,
        model: route.model, providerId: route.providerId ?? 'xd',
        ...(route.agentDeviceId ? { agentDeviceId: route.agentDeviceId } : {}),
        ...(route.effort ? { effort: route.effort } : {}), fastMode: route.fastMode };
    },
    routeAvailable: route => isPluginModelRouteAvailableNow({ ...route, effort: route.effort ?? '', fastMode: route.fastMode ?? false }),
    applyRoute,
    changed: (sessionId, pluginId, phase) => log.info('runtime plugin changed model request', { sessionId, pluginId, phase }),
  });
  return (sessionId, message, signal) => {
    const prepared = taskRuntimePlugins.prepare(sessionId, message, signal);
    return prepared?.then(options => ({ options })).catch(error => ({ failure: {
      accepted: false as const,
      reason: error instanceof RuntimePluginControlError && error.action === 'skip' ? 'PLUGIN_TURN_SKIPPED' as const : 'PLUGIN_TURN_BLOCKED' as const,
      outcome: createHostSendFailure(error instanceof RuntimePluginControlError && error.action === 'skip' ? 'PLUGIN_TURN_SKIPPED' : 'PLUGIN_TURN_BLOCKED',
        'The selected runtime plugin stopped this reply.'),
    } }));
  };
}

/** The callers are responsible for authorizing their own renderer and transport. */
export function createRuntimePluginSettingsHandler<Owner, Caller = unknown>({
  maker, assertCaller, captureDataOwnerBroadcastScope, isDataOwnerBroadcastScopeCurrent, assertReviewSettingsUnlocked,
  resolveGhostControlPointPlugin, writeRuntimePluginSettings, broadcastSessionPatched,
}: {
  maker: Pick<Maker, 'getSessionMeta'>;
  assertCaller(caller: Caller): void;
  captureDataOwnerBroadcastScope(): Owner;
  isDataOwnerBroadcastScopeCurrent(owner: Owner): boolean;
  assertReviewSettingsUnlocked(sessionId: string): Promise<void>;
  resolveGhostControlPointPlugin: PluginHost['resolveGhostControlPointPlugin'];
  writeRuntimePluginSettings: typeof WriteRuntimePluginSettings;
  broadcastSessionPatched(sessionId: string, patch: { runtimePluginsSelected: boolean }): void;
}) {
  return async (caller: Caller, sessionId: unknown, value: unknown) => {
    assertCaller(caller);
    const owner = captureDataOwnerBroadcastScope();
    if (typeof sessionId !== 'string' || !sessionId || !await maker.getSessionMeta(sessionId)) {
      throwIpcError('NOT_FOUND', 'Task not found');
    }
    if (!isDataOwnerBroadcastScopeCurrent(owner)) throwIpcError('PRECONDITION_FAILED', 'Account changed');
    if (value === undefined) return readRuntimePluginSettings(sessionId) ?? {};
    await assertReviewSettingsUnlocked(sessionId);
    const settings = parseRuntimePluginSettings(value);
    if (!settings) throwIpcError('INVALID_PARAMS', 'Invalid runtime plugin settings');
    for (const [point, targets] of Object.entries(settings)) {
      for (const target of targets ?? []) resolveGhostControlPointPlugin(point as Parameters<typeof resolveGhostControlPointPlugin>[0], target.pluginId);
    }
    if (!isDataOwnerBroadcastScopeCurrent(owner)) throwIpcError('PRECONDITION_FAILED', 'Account changed');
    await writeRuntimePluginSettings(sessionId, settings);
    if (!isDataOwnerBroadcastScopeCurrent(owner)) throwIpcError('PRECONDITION_FAILED', 'Account changed');
    broadcastSessionPatched(sessionId, { runtimePluginsSelected: !!readRuntimePluginSettings(sessionId) });
    return readRuntimePluginSettings(sessionId) ?? {};
  };
}

type InputHooks = 'screenUserMessage' | 'onUserMessageBlocked' | 'onUserMessageRewritten';
type InputItem = Parameters<NonNullable<AgentInputCoordinatorDeps['screenUserMessage']>>[2];
export function createRuntimePluginInputHooks({
  getStableSessionForTurnBoundary, screenGhostUserMessage, rollbackAgentIslandUserPrompt, revokeTrustedDesktopQueueOrigin,
  broadcastGhostMessageBlocked, broadcastGhostMessageRewritten,
}: {
  getStableSessionForTurnBoundary(sessionId: string): ReturnType<Maker['getSession']> | null;
  screenGhostUserMessage: PluginHost['screenGhostUserMessage'];
  rollbackAgentIslandUserPrompt(sessionId: string, clientId: string, source: string): void;
  revokeTrustedDesktopQueueOrigin(item: InputItem): void;
  broadcastGhostMessageBlocked: typeof import('../cindy-brain/index.js').broadcastGhostMessageBlocked;
  broadcastGhostMessageRewritten: typeof import('../cindy-brain/index.js').broadcastGhostMessageRewritten;
}): Required<Pick<AgentInputCoordinatorDeps, InputHooks>> {
  return {
    // 意识拦截钩(订阅槽①):派发/落库前问已装钩子意识;fail-open 由
    // screenGhostUserMessage 内部收敛,快路径(无钩子意识)零开销。
    screenUserMessage: (sessionId, agentFacingText, item) => {
      const session = getStableSessionForTurnBoundary(sessionId);
      const model = resolveGhostUserHookModel(
        session?.isTurnRunning() === true,
        session?.model,
        item.createOpts.model,
      );
      return withGhostUserHookModel(model, () =>
        screenGhostUserMessage(sessionId, agentFacingText),
      );
    },
    onUserMessageBlocked: (sessionId, item, verdict) => {
      rollbackAgentIslandUserPrompt(sessionId, item.clientId, 'blocked');
      broadcastGhostMessageBlocked({
        sessionId,
        clientId: item.clientId,
        text: item.text,
        ...verdict,
      });
    },
    onUserMessageRewritten: (sessionId, item, info) => (revokeTrustedDesktopQueueOrigin(item), broadcastGhostMessageRewritten({ sessionId, clientId: item.clientId, ...info })),
  };
}
