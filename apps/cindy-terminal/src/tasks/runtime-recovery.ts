import { createSessionRuntimeProfiles } from '@cindy/app-runtime/sessionRuntimeProfiles';
import type { createSessionRuntimeAxes } from '@cindy/app-runtime/sessionRuntimeAxes';
import { createSessionRecoveryLeases } from '@cindy/app-runtime/sessionRecoveryLeases';
import type { Session, Logger } from '@cindy/maker-core';
import { createBotModelChainSettings } from '@cindy/app-runtime/botModelChainSettings';
import { createBotFallbackCandidateReader } from '@cindy/app-runtime/botFallbackCandidate';
import { hasExplicitSessionTaskModel } from '@cindy/app-runtime/sessionTaskModelOverride';
import { createSessionRuntimeFallback } from '@cindy/app-runtime/sessionRuntimeFallback';
import { createInterruptedTurnRecovery } from '@cindy/app-runtime/interruptedTurnRecovery';
import { isInterruptedTurnError, type InterruptedTurnErrorSignals } from '@cindy/app-runtime/interruptedTurnAutoResume';
import { isBotCandidateUnavailable } from '@cindy/app-runtime/botCandidateRecovery';
import type { createSessionRuntimeControl, SessionRuntimeProfile } from '@cindy/app-runtime/sessionRuntimeControl';
import type { AgentInputCoordinator, AgentInputCoordinatorDeps } from '@cindy/app-runtime/agent-input-coordinator';
import type { AgentInputQueuedMessage } from '@cindy/maker-shared/agent-input-queue';
import type { createSchedulerRecoveryBridge } from '@cindy/app-runtime/schedulerRecoveryBridge';
import type { TerminalTaskHost } from './host.js';
import type { createTerminalTaskEvents } from './events.js';
import type { NodeDatabase } from '../database.js';
import type { TerminalConversations } from './conversations.js';

/** Node bindings for the original interrupted-turn recovery and fallback services. */
export function createTerminalRuntimeRecovery(host: {
  tasks: TerminalTaskHost;
  profileDir: string;
  database: NodeDatabase;
  conversations: TerminalConversations;
  events: ReturnType<typeof createTerminalTaskEvents>;
  control: ReturnType<typeof createSessionRuntimeControl>;
  axes: ReturnType<typeof createSessionRuntimeAxes>;
  coordinator(): AgentInputCoordinator;
  scheduler: ReturnType<typeof createSchedulerRecoveryBridge>;
  live(id: string): Session | undefined;
  close(id: string): Promise<void>;
  withCloseSuppressed<T>(id: string, work: () => Promise<T>): Promise<T>;
  guard(): void;
  log: Logger;
}) {
  const {tasks, database, control, events, log} = host;
  const db = () => {host.guard(); return database.getDbClient();};
  const botFallbackInputs = new WeakSet<object>();
  const pendingSessionRuntimeFallbackRebuilds = new WeakMap<Session, number>();
  const pendingContinuationOnlyAutoResumeRebuilds = new WeakMap<Session, number>();
  const models = createBotModelChainSettings({
    userDataPath: () => host.profileDir, hasDataOwner: () => true,
    ownerScopedUserDataPath: () => host.profileDir,
    activeOwnerScopeKey: () => {host.guard(); const owner=database.getCurrentDbClientSnapshot()!; return owner.userId+':'+owner.clientEpoch;},
    listAvailableAgents: () => (['claude-code','codex','pi'] as const).filter(kind => tasks.isAgentAvailable(kind)),
    getDesktopProviderService: () => ({listProviders: options => tasks.models.views(options)}),
    waitForModelVisibilityMirror: () => tasks.models.waitForModelVisibility(),
    getModelVisibilityOverride: (...args) => tasks.models.visibility.mirror.getModelVisibilityOverride(...args), log,
  });
  const readBotFallbackCandidate = createBotFallbackCandidateReader({getDbClient:db,
    readEffectiveBotModelChain:models.readEffectiveBotModelChain,
    getSessionRuntimeControlSnapshot:control.getSessionRuntimeControlSnapshot});
  const readProfiles = createSessionRuntimeProfiles({
    ...control, ...tasks.routes.providers, ...host.axes, getDbClient: db, log,
    maker: {getSession: host.live, getSessionMeta: id => tasks.storage.get(id)},
    agentSwitchPending: tasks.routes.pending,
  });
  const changed = async (id:string) => {
    const row=await tasks.storage.get(id); host.guard(); if (!row) return;
    const profiles=await readProfiles(id); if (!profiles) return;
    host.conversations.notifications.broadcastSessionPatched(id,control.projectSessionRuntimeControl(id,profiles.baseline));
  };
  const fallback = createSessionRuntimeFallback({
    ...control, getDbClient:db, log,
    maker:{getSession:host.live,closeSession:host.close},
    readSessionRuntimeProfiles:readProfiles,
    canApplyAutomaticRuntimeSelection:(id,generation)=>!tasks.routes.pending.get(id)&&control.sessionRuntimeGenerationMatches(id,generation),
    hasExplicitSessionTaskModel:id=>hasExplicitSessionTaskModel(db,id),
    readBotFallbackCandidate,
    readSessionAgentDeviceId:async id=>(await tasks.storage.get(id))?.agentDeviceId??null,
    readSessionRuntimeFallbackSettings:()=>events.fallbackSettings.read(),
    getDesktopProviderService:()=>({listProviders:()=>tasks.models.views()}),getActiveCatalog:()=>tasks.models.activeCatalog(),
    pendingSessionRuntimeFallbackRebuilds,
    withSendToSessionLock:(id,work)=>tasks.routes.withLock(id,work),
    applySessionRuntimeSelection: (...args) => tasks.routes.applyRuntimeSelection(...args),
    getPendingCredentialSwitchTarget:id=>tasks.routes.credentials.get(id),
    clearPendingCredentialSwitchForSession:(id,options)=>{tasks.routes.credentials.clear(id);if(options?.wake!==false)host.coordinator().wakeSession(id,'pending-credential-switch-cancelled');},
    broadcastSessionRuntimeProjection:changed,agentSwitchDeps:tasks.routes.deps,withRehydrateCloseSuppressed:host.withCloseSuppressed,
  });
  const canRecoverTurn=(signals:InterruptedTurnErrorSignals,item?:AgentInputQueuedMessage|null)=>isInterruptedTurnError(signals)
    ||(!!item&&botFallbackInputs.has(item.createOpts)&&isBotCandidateUnavailable(signals));
  const recover=createInterruptedTurnRecovery({coordinator:host.coordinator,canRecoverTurn,botFallbackInputs,
    interruptedTurnAutoResumeGuard:events.interrupted,saveTurnStartedAtForDeferred:host.conversations.persistence.saveTurnStartedAtForDeferred,
    log,autoResumeBookkeeping:events.bookkeeping,beginSchedulerAutoResume:host.scheduler.beginSchedulerAutoResume,
    getStableSessionForTurnBoundary:host.live,pendingContinuationOnlyAutoResumeRebuilds,
    maybeApplySessionRuntimeFallback:fallback,pendingSessionRuntimeFallbackRebuilds});
  const discarded:NonNullable<AgentInputCoordinatorDeps['onResumableTurnErrorDiscarded']>=(id,options)=>{
    if(options.surfaceError)events.bookkeeping.surfaceSuppressedError(id,{deferredOwner:options.owner});
    else events.bookkeeping.flushSuppressedError(id,{deferredOwner:options.owner});
  };
  const leases=createSessionRecoveryLeases({coordinator:host.coordinator,interruptedTurnAutoResumeGuard:events.interrupted,autoResumeBookkeeping:events.bookkeeping,pendingContinuationOnlyAutoResumeRebuilds,pendingSessionRuntimeFallbackRebuilds});
  return {leases,recover,canRecoverTurn,discarded,models,readProfiles,readBotFallbackCandidate,pendingSessionRuntimeFallbackRebuilds,pendingContinuationOnlyAutoResumeRebuilds,
    async noteInput(id:string,createOpts:object){
      const profile=await readProfiles(id);if(!profile)return;
      const bot=await readBotFallbackCandidate(id,profile.effective);host.guard();
      if(bot.isBot)botFallbackInputs.add(createOpts);else botFallbackInputs.delete(createOpts);
    },
  };
}
