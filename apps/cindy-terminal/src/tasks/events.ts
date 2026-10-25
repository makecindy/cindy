import type { createSessionActivityBridge } from '@cindy/app-runtime/session-activity/bridge';
import {composeResponseObservers} from '@cindy/app-runtime/composeResponseObservers';
import type {ResolvedRoute,AgentKind} from '@cindy/model-providers';
import type {ProviderProxyObservation} from '../models/proxy.js';
import {createOverrideSettingsFile} from '@cindy/app-runtime/overrideSettingsFile';
import path from 'node:path';
import type {AgentEvent, Session, InteractionRequest, InteractionDecision, Logger} from '@cindy/maker-core';
import {createSessionEventRuntime} from '@cindy/app-runtime/sessionEventRuntime';
import type {SessionEventDependencies} from '@cindy/app-runtime/sessionEventPipeline';
import {createSessionEventGuards} from '@cindy/app-runtime/sessionEventGuards';
import {isGatewayProxyTokenRecoveryErrorEventForProvider} from '@cindy/app-runtime/gatewayProxyTokenRecovery';
import {createPromptPredictionStopLedger} from '@cindy/app-runtime/promptPredictionStopLedger';
import {SessionTurnActivityTracker} from '@cindy/app-runtime/sessionTurnActivityTracker';
import {createWorkerTurnStartSequencer} from '@cindy/app-runtime/workerTurnStartSequencer';
import {createScheduledOutputProjection} from '@cindy/app-runtime/silent-output';
import {AutoResumeBookkeeping} from '@cindy/app-runtime/autoResumeBookkeeping';
import {InterruptedTurnAutoResumeGuard} from '@cindy/app-runtime/interruptedTurnAutoResume';
import {createBotCompactRuntimeRefreshCoordinator, type BotCompactRuntimeRefreshDeps} from '@cindy/app-runtime/botCompactRuntimeRefresh';
import {createClaudeSessionRouteRegistry} from '@cindy/app-runtime/claude-session-route-registry';
import {createClaudeSessionBackgroundActivity} from '@cindy/app-runtime/claude-session-background-activity';
import {createClaudeGatewayErrorTracker} from '@cindy/app-runtime/claude-gateway-error-observer';
import {createProviderUpstreamErrorObservers} from '@cindy/app-runtime/provider-upstream-error-observer';
import {redactEventForRenderer} from '@cindy/app-runtime/sessionEventRedaction';
import {withGhostAssistantHookModel} from '@cindy/app-runtime/subscriptionGateway';
import {ClaudeOutputLagTimingGuard} from '@cindy/remote-agent/modelUsageDelta';
import type {AgentInputCoordinator} from '@cindy/app-runtime/agent-input-coordinator';
import type {TerminalConversations} from './conversations.js';
import type {TerminalUsage} from './usage.js';
import type {TerminalModelConfig} from '../models/config.js';
import type {TerminalTurnLifecycle} from './turn-lifecycle.js';
import type {TerminalTaskChanges} from './changes.js';
import type {TerminalPluginEvents} from '../plugins/events.js';
import type {createSessionTaskSummary} from '@cindy/app-runtime/sessionTaskSummary';

/** Original services register their live bindings as they do in Desktop's
 * maker host. Pending operations retain the service that owns their lifetime. */
export interface TerminalEventBindings {
  onAutoResumeFailed?: (id: string, token?: number) => void;
  botRefresh?:BotCompactRuntimeRefreshDeps['refresh'];
  goalIdle?:(id:string)=>void;
  pendingCredentialSwitch?:{onTurnSettled(id:string):Promise<unknown>};
  isCcMgrUpgradeInFlight?:(id:string|null|undefined)=>boolean;
  settlePendingSessionRuntimeControl?:SessionEventDependencies['settlePendingSessionRuntimeControlHolder'];
  deferredCodexRestart?:SessionEventDependencies['deferredCodexRestartHolder'];
  gatewayCodexRestart?:SessionEventDependencies['gatewayCodexRestartHolder'];
  refreshRemoteCodexMcp?:SessionEventDependencies['refreshRemoteCodexMcpOnTurnSettledHolder'];
  botDelegation?:SessionEventDependencies['botDelegationServiceHolder'];
  botGroupChat?:SessionEventDependencies['botGroupChatServiceHolder'];
  gitSnapshots?:SessionEventDependencies['gitSnapshotCoordinator'];
  usageLimitAutoResume?:SessionEventDependencies['usageLimitAutoResume'];
}

export function createTerminalTaskEvents(host:{
  conversations:TerminalConversations;
  usage:TerminalUsage;
  models:TerminalModelConfig;
  summary:ReturnType<typeof createSessionTaskSummary>;
  lifecycle:TerminalTurnLifecycle;
  changes:TerminalTaskChanges;
  profileDir:string;
  region:'cn'|'global';
  logger:Logger;
  current():boolean;
  coordinator():AgentInputCoordinator;
  provider(id:string):string|null;
  fastMode(id:string):boolean|'ultrafast';
  model(id:string):Promise<string>;
  pluginEvents():TerminalPluginEvents|undefined;
  hasPendingInteraction(id:string):boolean;
  clearPendingInteraction:SessionEventDependencies['clearPendingInteraction'];
  overflow:SessionEventDependencies['contextOverflowRolloverHolder'];
  orca:NonNullable<SessionEventDependencies['orcaTeamServiceForEvents']>;
  wireNoteMemory:NonNullable<SessionEventDependencies['wireNoteMemory']>;
  images:{deliver(id:string,event:AgentEvent):Promise<void>};
  activityBridge(): ReturnType<typeof createSessionActivityBridge>;
  emit(channel:string,payload:unknown):void;
  t(key:string,params?:Record<string,string|number>):string;
  bindings:TerminalEventBindings;
  onSuccessfulProductTurn:SessionEventDependencies['onSuccessfulProductTurn'];
  onUnsuccessfulProductTurn:SessionEventDependencies['onUnsuccessfulProductTurn'];
}) {
  const {conversations:c,usage,bindings}=host;
  const {persistence:p}=c;
  const activity=new SessionTurnActivityTracker();
  const scheduledOutput=createScheduledOutputProjection();
  const claudeRoutes=createClaudeSessionRouteRegistry();
  const claudeActivity=createClaudeSessionBackgroundActivity(()=>host.logger);
  claudeActivity.setClaudeBackgroundActivityBroadcaster(payload=>host.emit('maker:session-background-activity-changed',payload));
  claudeRoutes.onClaudeSessionRouteChange((sessionId,route)=>host.emit('maker:claude-session-route-changed',{sessionId,route}));
  const upstreamErrors=createProviderUpstreamErrorObservers();
  upstreamErrors.setProviderUpstreamErrorBroadcaster(event=>host.emit('maker:provider:upstream-error',event));
  const claudeErrors=createClaudeGatewayErrorTracker({...claudeRoutes,...upstreamErrors});
  const guards=createSessionEventGuards({coordinator:host.coordinator,currentLedgerCurrency:usage.currentLedgerCurrency});
  const settings = (file:string, defaultEnabled:boolean) => createOverrideSettingsFile({
    filePath: () => path.join(host.profileDir,file), defaults: {enabled:defaultEnabled},
    normalize: raw => ({enabled: raw && typeof raw === 'object' && typeof (raw as {enabled?:unknown}).enabled === 'boolean'
      ? (raw as {enabled:boolean}).enabled : defaultEnabled}), log:host.logger, label:file,
  });
  const interruptedSettings = settings('interrupted-turn-auto-resume-settings.json',true);
  const fallbackSettings = settings('session-runtime-fallback-settings.json',false);
  const interrupted=new InterruptedTurnAutoResumeGuard({log:host.logger,isEnabled:()=>
    interruptedSettings.read().enabled || fallbackSettings.read().enabled});
  const bookkeeping=new AutoResumeBookkeeping({
    onAutoResumeFailed:(...args)=>bindings.onAutoResumeFailed?.(...args),
    persistSuppressedError:(id,detail)=>{p.onTurnErrorEvent(id,detail,null);},
    finalizeOrcaSuppressedTerminal:(sessionId,terminal)=>{void host.orca.handleWorkerTerminalTurn({sessionId,...terminal,capture:terminal.capture as ReturnType<typeof host.orca.captureWorkerTerminalTurn>}).catch(()=>host.logger.warn('Orca terminal could not settle'));},
    finalizeBotGroupSuppressedTerminal:terminal=>{void bindings.botGroupChat?.settleLaneTurn(terminal);},
    markOutcome:(id,clientId,outcome)=>{void p.markAutoResumeOutcome(id,clientId,outcome);},
    rollbackGuardPendingResume:(id,token)=>{if(typeof token==='number')interrupted.noteResumeSendFailed(id,token);},
    abandonTakeover:(...args)=>host.coordinator().abandonAutoResume(...args),
    log:(message,fields)=>host.logger.debug(message,fields),
  });
  const compact=createBotCompactRuntimeRefreshCoordinator({
    hasPendingInteraction:host.hasPendingInteraction,
    refresh:(...args)=>bindings.botRefresh?.(...args)??Promise.resolve('deferred'),
    onError:(sessionId,error)=>host.logger.warn('Bot compact runtime refresh failed; lazy resume remains available',{sessionId,error:String(error)}),
  });
  const owner=c.broadcastTap.captureDataOwnerBroadcastScope();
  const events=createSessionEventRuntime({
    ...usage,...c.messages,...p,...c.activeTurn,...c.subagentFence,...host.summary,...createPromptPredictionStopLedger(),
    ...claudeActivity,...claudeRoutes,...claudeErrors,
    createLogger:()=>host.logger,
    activeOwnerScopeKey:()=>host.current()?owner.ownerScopeKey!:'closed',isAppSessionBoundaryPending:()=>!host.current(),
    stream:{persistence:p,fence:c.subagentFence,persistSubagentTaskUpdate:c.subagents.persistSubagentTaskUpdate,
      broadcastSubagentRunsChanged:c.subagentService.broadcastSubagentRunsChanged},
    scheduledOutput,CURRENT_CINDY_REGION:host.region,
    MAKER_PUSH:{EVENT:'maker:event',INTERACTION_DISMISSED:'maker:interaction-dismissed'},
    getActiveCatalog:()=>host.models.catalogRuntime.getActiveCatalog(),getSessionProvider:host.provider,
    isUserProviderSession:id=>host.models.catalogRuntime.getActiveCatalog().providers.find(provider=>provider.id===host.provider(id))?.source==='user',
    getSessionFastMode:host.fastMode,
    readClaudeApiKey:()=>host.models.gatewayCredentials()?.apiKey??null,
    getCodexProxyAuthInjection:()=>host.models.openAiAccount('openai')?.connected()?'oauth-bearer':'env-key',
    broadcastSchedulerChanged:scheduleId=>host.emit('maker:scheduler:changed',{scheduleId}),
    isCcMgrUpgradeInFlight:id=>bindings.isCcMgrUpgradeInFlight?.(id)===true,
    finalizeTurnChangeSet:host.changes.store.finalizeTurnChangeSet,t:host.t,
    hasEnabledGhostAssistantHook:()=>host.pluginEvents()?.replies.hasEnabledGhostAssistantHook()===true,
    runGhostAssistantReplyHook:(...args)=>host.pluginEvents()?.replies.runGhostAssistantReplyHook(...args),withGhostAssistantHookModel,
  });
  const generations=new Map<string,number>();
  const claudeOutputLagTimingGuard = new ClaudeOutputLagTimingGuard();
  const deps:SessionEventDependencies={
    onSuccessfulProductTurn:host.onSuccessfulProductTurn,onUnsuccessfulProductTurn:host.onUnsuccessfulProductTurn,
    ...guards,log:host.logger,wireNoteMemory:host.wireNoteMemory,
    botCompactRuntimeRefreshCoordinator:compact,
    attemptBotCompactRuntimeRefresh:session=>{if(compact.hasPending(session.id))void compact.attempt(session);},
    interruptedTurnAutoResumeGuard:interrupted,
    get usageLimitAutoResume(){return bindings.usageLimitAutoResume;},
    redactEventForRenderer,
    handleAgentIslandInteractionDismissed: (...args) => host.activityBridge().handleAgentIslandInteractionDismissed(...args),
    handleAgentIslandEventAfterBroadcast: (...args) => host.activityBridge().handleAgentIslandEventAfterBroadcast(...args),
    clearPendingInteraction:host.clearPendingInteraction,
    persistInteractionDecision:(id,persistId,kind,request,decision)=>{
      if(kind==='ask_user_question'||kind==='plan_review')p.onInteractionResolved(id,persistId,kind,request,decision as Record<string,unknown>);
    },
    broadcastToAllWindows:host.emit,
    broadcastCodexImageAsToolResult:async(id,event)=>{try{await host.images.deliver(id,event);}catch{host.logger.warn('Generated image delivery could not be persisted',{sessionId:id});}},
    autoResumeBookkeeping:bookkeeping,pendingFailedTurnAssistantPersistId:new Map(),
    silentStopAutoResumeGuard:host.lifecycle.guard,sessionTurnActivityTracker:activity,
    productTurnWallClockTracker:host.lifecycle.wallClock,productTurnUsageTargetTracker:host.lifecycle.usageTargets,
    advanceSessionTurnBoundaryGeneration:id=>{const next=(generations.get(id)??0)+1;generations.set(id,next);return next;},
    get gitSnapshotCoordinator(){return bindings.gitSnapshots??null;},
    workerTurnStartSequencer:createWorkerTurnStartSequencer(host.logger),orcaTeamServiceForEvents:host.orca,
    turnModelPromiseBySession:new Map(),readSessionModelForUsage:host.model,turnUsageContextBySession:new Map(),
    silentStopTurnLeaseGate:host.lifecycle.leaseGate,get agentInputCoordinatorHolder(){return host.coordinator();},
    handleSilentStopTurnEnd:(...args)=>host.lifecycle.handleSilentStopTurnEnd(...args),
    isGatewayProxyTokenRecoveryErrorEvent:(id,event)=>isGatewayProxyTokenRecoveryErrorEventForProvider(host.provider(id),event),
    overflowSuppressedBroadcasts:new Map(),
    notifyGoalIdleAfterTurnSettled:id=>bindings.goalIdle?.(id),
    settlePendingCredentialSwitch:(id,source)=>{void bindings.pendingCredentialSwitch?.onTurnSettled(id).catch(error=>host.logger.warn('pending credential switch settle failed',{sessionId:id,source,error:String(error)}));},
    get settlePendingSessionRuntimeControlHolder(){return bindings.settlePendingSessionRuntimeControl??null;},
    get deferredCodexRestartHolder(){return bindings.deferredCodexRestart??null;},
    get gatewayCodexRestartHolder(){return bindings.gatewayCodexRestart??null;},
    get refreshRemoteCodexMcpOnTurnSettledHolder(){return bindings.refreshRemoteCodexMcp??null;},
    markTurnEndedAfterPersistDrain:id=>c.activeTurn.markSessionTurnEndedAfterBarrier(id,p.drainPersistQueue()),
    get botDelegationServiceHolder(){return bindings.botDelegation??null;},
    get botGroupChatServiceHolder(){return bindings.botGroupChat??null;},
    contextOverflowRolloverHolder:host.overflow,
    lastReportedModelUsageBySession:new Map(),claudeOutputLagTimingGuard,
    lastReportedCostUsdBySession:new Map(),
  };
  // Every native process owns a loopback proxy. Remap its local request counter
  // into this owner's sequence before feeding the original shared observers.
  let nextProxyRequest=0;
  function proxyObservation(sessionId:string,route:ResolvedRoute,agent:AgentKind):ProviderProxyObservation {
    const requests=new Map<number,{id:number;upstream:string}>();
    const provider=upstreamErrors.createProviderUpstreamErrorObserver({agent,
      resolveUserProviderId:()=>route.provider.source==='user'?route.provider.id:null,
      resolveUserProviderName:()=>route.provider.name});
    const observe=composeResponseObservers(provider,...(agent==='claude-code'?
      [claudeActivity.createClaudeSessionActivityResponseObserver(()=>sessionId),claudeErrors.createClaudeGatewayErrorObserver()]:[]));
    return {
      request(context,resolved){
        if(!host.current())return;
        const id=++nextProxyRequest;
        requests.set(context.reqId,{id,upstream:resolved.routing.upstream??''});
        while(requests.size>256)requests.delete(requests.keys().next().value!);
        if(agent!=='claude-code')return;
        claudeRoutes.noteClaudeSessionRequest(sessionId,id);
        const billing=resolved.provider.id==='xd'?'gateway':resolved.provider.id==='anthropic'?'subscription':null;
        if(billing)claudeRoutes.recordClaudeRequestRoute(id,sessionId,billing);
      },
      response(context){
        const request=requests.get(context.reqId);requests.delete(context.reqId);
        if(!host.current()||!request)return null;
        return observe({...context,reqId:request.id,upstreamBase:request.upstream});
      },
    };
  }
  return {claudeOutputLagTimingGuard,fallbackSettings,proxyObservation,activity,scheduledOutput,interrupted,bookkeeping,compact,claudeRoutes,claudeActivity,claudeErrors,upstreamErrors,guards,deps,
    handle:(session:Session,event:AgentEvent)=>events.handleSessionEvent(deps,session,event),
    close(){claudeActivity.resetClaudeBackgroundActivityForTests();claudeRoutes.resetClaudeSessionRouteRegistryForTest();claudeErrors.resetClaudeGatewayErrorObserverForTest();},
  };
}
