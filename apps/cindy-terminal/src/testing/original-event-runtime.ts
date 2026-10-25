import { Session, PiAgent, type AgentEvent, type AgentSessionHandle, type Logger } from '@cindy/maker-core';
import { createSessionEventRuntime } from '@cindy/app-runtime/sessionEventRuntime';
import type { SessionEventDependencies } from '@cindy/app-runtime/sessionEventPipeline';
import type { createPersistedSessions } from '@cindy/app-runtime/persistedSessions';
import { createSessionSpendBroadcaster } from '@cindy/app-runtime/sessionSpendBroadcaster';
import { createTurnCostBroadcaster } from '@cindy/app-runtime/turnCostBroadcaster';
import { createTurnCostCalculator } from '@cindy/app-runtime/turnCostCalculator';
import { createScheduleRunCostLedger } from '@cindy/app-runtime/runCostLedger';
import { createDailyModelUsage } from '@cindy/app-runtime/dailyModelUsage';
import { createDailySpend } from '@cindy/app-runtime/dailySpend';
import { createScheduledOutputProjection } from '@cindy/app-runtime/silent-output';
import { createPromptPredictionStopLedger } from '@cindy/app-runtime/promptPredictionStopLedger';
import { SessionTurnActivityTracker } from '@cindy/app-runtime/sessionTurnActivityTracker';
import { ProductTurnWallClockTracker, ProductTurnUsageTargetTracker } from '@cindy/app-runtime/turnWallClock';
import { createWorkerTurnStartSequencer } from '@cindy/app-runtime/workerTurnStartSequencer';
import { AutoResumeBookkeeping } from '@cindy/app-runtime/autoResumeBookkeeping';
import { InterruptedTurnAutoResumeGuard } from '@cindy/app-runtime/interruptedTurnAutoResume';
import { SilentStopAutoResumeGuard } from '@cindy/remote-agent/host/silentStopAutoResume';
import { ClaudeOutputLagTimingGuard } from '@cindy/remote-agent/modelUsageDelta';
import { createBotCompactRuntimeRefreshCoordinator } from '@cindy/app-runtime/botCompactRuntimeRefresh';
import { getModelPriceQuote } from '@cindy/model-providers/modelPriceQuote';
import type { OwnerBroadcastTap, DataOwnerBroadcastScope } from '@cindy/app-runtime/ownerBroadcast';
import type { DbLogger } from '@cindy/runtime-db/logging';
import type { NodeDatabase } from '../database.js';

/** Native provider and external account services are fixtures; persistence and the event pipeline are real. */
export function originalEventRuntimeFixture(input: {
  runtime: ReturnType<typeof createPersistedSessions<object>>;
  database: NodeDatabase;
  logger: DbLogger;
  owner: DataOwnerBroadcastScope;
  current(): boolean;
  publish(channel: string, payload: unknown): void;
  id: string;
  workDir: string;
}) {
  const {runtime, database, id, workDir} = input;
  const logger: Logger = {...input.logger, trace() {}, fatal: input.logger.error, child: () => logger};
  const broadcastTap: OwnerBroadcastTap = {
    captureDataOwnerBroadcastScope: () => input.owner,
    isDataOwnerBroadcastScopeCurrent: () => input.current(),
    getSafeDataOwnerPushStamp: () => input.current() ? input.owner.ownerStamp : undefined,
    tapWindowBroadcast: input.publish,
  };
  const moneyHost = {...runtime.money, getDbClient: database.getDbClient,
    createLogger: () => logger, currentLedgerCurrency: () => 'USD' as const};
  const spend = createSessionSpendBroadcaster({...moneyHost, broadcastTap, broadcastLocal: (channel, payload, ..._stamp) => input.publish(channel, payload)});
  const scheduleCost = createScheduleRunCostLedger(moneyHost);
  const daily = createDailySpend(moneyHost);
  const models = createDailyModelUsage({...moneyHost, localDayKey: daily.localDayKey});
  const turnCost = createTurnCostBroadcaster({...moneyHost, ...runtime.usage, ...runtime.messages,
    ...runtime.persistence, ...scheduleCost, broadcastTap, broadcastLocal: (channel, payload, ..._stamp) => input.publish(channel, payload)});
  const calculator = createTurnCostCalculator({...moneyHost, ...runtime.usage});
  let usageSaved!: () => void;
  const usageFinished = new Promise<void>(resolve => {usageSaved = resolve;});
  const writes: Promise<unknown>[] = [];
  const track = <T>(operation: Promise<T>): Promise<T> => {writes.push(operation); return operation;};
  const events = createSessionEventRuntime({
    ...moneyHost, ...runtime.usage, ...runtime.messages, ...runtime.persistence, ...runtime.activeTurn,
    ...runtime.subagentFence, ...calculator, ...turnCost, ...createPromptPredictionStopLedger(),
    ...spend,
    stream: {persistence:runtime.persistence, fence:runtime.subagentFence,
      persistSubagentTaskUpdate:runtime.subagents.persistSubagentTaskUpdate,
      broadcastSubagentRunsChanged:runtime.subagentService.broadcastSubagentRunsChanged},
    scheduledOutput:createScheduledOutputProjection(), CURRENT_CINDY_REGION:'global',
    activeOwnerScopeKey:()=>input.owner.ownerScopeKey!, isAppSessionBoundaryPending:()=>!input.current(),
    MAKER_PUSH:{EVENT:'maker:event',INTERACTION_DISMISSED:'maker:interaction-dismissed'},
    getActiveCatalog:()=>({version:'fixture',providers:[]}), getSessionProvider:()=> 'fixture-provider',
    isUserProviderSession:()=>true, getSessionFastMode:()=>false,
    isOpenAiSubscriptionProviderId:()=>false, isClaudeSubscriptionProviderId:()=>false,
    isXaiSubscriptionProviderId:()=>false, readClaudeApiKey:()=>null,
    getCodexProxyAuthInjection:()=> 'env-key',readClaudeSessionRoute:()=>null,
    getGatewayAccountCurrency:async()=>null,getGatewayModelPricingForModel:async()=>null,
    getModelPriceQuote,getReferenceModelPricing:()=>({}),
    getCodexProviderSubscriptionValuePrice:()=>undefined,getSubscriptionDirectValuePrice:()=>undefined,
    getSubscriptionValuePriceFor:()=>undefined,
    codexApiUsageModelKey:model=>model, codexSubscriptionUsageModelKey:model=>model,
    claudeSubscriptionUsageModelKey:model=>model,piSubscriptionUsageModelKey:model=>model,
    recordTurnSpend:async(money,ts)=>{await daily.incrementDailySpend(money,ts);},
    recordModelTurnUsage:delta=>track(models.incrementDailyModelUsage(delta)),
    recordSessionTurnTokens:(...args)=>track(spend.recordSessionTurnTokens(...args)),
    recordSessionContextSnapshot:(...args)=>track(spend.recordSessionContextSnapshot(...args)),
    recordTurnUsageOnMessage:async(...args)=>{const result=await turnCost.recordTurnUsageOnMessage(...args);usageSaved();return result;},
    recordCodexTurnUsage(){},recordCodexAccountUsageSnapshot:async()=>{},recordModelMismatchOnMessage:async()=>{},
    rebroadcastTodaySpend:async()=>{},rebroadcastCodexTodayUsage(){},triggerClaudeAccountUsageRefresh:async()=>{},
    triggerClaudeSubscriptionUsageRefresh(){},triggerCodexAccountUsageRefresh(){},triggerXaiSubscriptionUsageRefresh(){},
    broadcastSchedulerChanged(){},isCcMgrUpgradeInFlight:()=>false,noteClaudeSessionTurnState(){},
    consumeClaudeOpusPlanMismatch:()=>null,finalizeTurnChangeSet:async()=>{},t:key=>key,
    hasEnabledGhostAssistantHook:()=>false,runGhostAssistantReplyHook(){},withGhostAssistantHookModel:(_model,task)=>task(),
    maybeGenerateSessionTaskSummary:async()=>{},refreshSessionListPreview:async()=>{},
  });
  let closed!: () => void;
  const closure = new Promise<void>(resolve => {closed = resolve;});
  const handle: AgentSessionHandle = {
    id:'fixture-native',agentKind:'pi',model:'fixture-model',async send(){},async steer(){},async abort(){},
    async close(){closed();},async *events(){await closure;},setInteractionResolver(){},
    getUsageSnapshot:()=>({tokenUsage:0,contextTokens:0,contextWindow:32000,costUsd:0}),
  };
  const provider = new PiAgent({binaryPath:process.execPath,logger,runtimeConfig:{},
    auth:{getState:async()=>({authenticated:true}),getAuthEnv:async()=>({}),triggerLogin:async()=>({authenticated:true}),logout:async()=>{}}});
  const session = new Session({id,workDir,agentKind:'pi',handle,capabilities:provider.capabilities,logger,turnStallMs:0});
  const activity = new SessionTurnActivityTracker();
  const deps: SessionEventDependencies = {
    log:logger,botCompactRuntimeRefreshCoordinator:createBotCompactRuntimeRefreshCoordinator({hasPendingInteraction:()=>false,refresh:async()=> 'not-bot'}),
    attemptBotCompactRuntimeRefresh(){},isFencedStaleSessionTerminal:()=>false,
    interruptedTurnAutoResumeGuard:new InterruptedTurnAutoResumeGuard({isEnabled:()=>false,log:logger}),
    silentStopAutoResumeGuard:new SilentStopAutoResumeGuard({isEnabled:()=>false,log:logger}),
    redactEventForRenderer:event=>event,handleAgentIslandInteractionDismissed(){},clearPendingInteraction:()=>null,
    defaultDecisionForPending(){throw new Error('No interaction in event fixture');},persistInteractionDecision(){},
    broadcastToAllWindows:input.publish,broadcastCodexImageAsToolResult:async()=>{},
    autoResumeBookkeeping:new AutoResumeBookkeeping({persistSuppressedError:(sid,detail)=>{runtime.persistence.onTurnErrorEvent(sid,detail,null);},
      markOutcome(){},rollbackGuardPendingResume(){},abandonTakeover(){}}),
    pendingFailedTurnAssistantPersistId:new Map(),sessionTurnActivityTracker:activity,
    productTurnWallClockTracker:new ProductTurnWallClockTracker(),productTurnUsageTargetTracker:new ProductTurnUsageTargetTracker(),
    advanceSessionTurnBoundaryGeneration:()=>session.getTurnGeneration(),gitSnapshotCoordinator:null,
    workerTurnStartSequencer:createWorkerTurnStartSequencer(logger),orcaTeamServiceForEvents:null,
    turnModelPromiseBySession:new Map(),readSessionModelForUsage:async()=> 'fixture-model',turnUsageContextBySession:new Map(),
    silentStopTurnLeaseGate:{turnLeaseIdForEvent:()=>undefined},agentInputCoordinatorHolder:null,
    handleSilentStopTurnEnd:async()=>{},isRemoteAuthRetryErrorEvent:()=>false,isGatewayProxyTokenRecoveryErrorEvent:()=>false,
    overflowSuppressedBroadcasts:new Map(),handleAgentIslandEventAfterBroadcast(){},notifyGoalIdleAfterTurnSettled(){},
    settlePendingCredentialSwitch(){},settlePendingSessionRuntimeControlHolder:null,deferredCodexRestartHolder:null,
    refreshRemoteCodexMcpOnTurnSettledHolder:null,
    markTurnEndedAfterPersistDrain:sid=>runtime.activeTurn.markSessionTurnEndedAfterBarrier(sid,runtime.persistence.drainPersistQueue()),
    botDelegationServiceHolder:null,contextOverflowRolloverHolder:null,lastReportedModelUsageBySession:new Map(),
    claudeOutputLagTimingGuard:new ClaudeOutputLagTimingGuard(),lastReportedCostUsdBySession:new Map(),
    unpricedSubscriptionValueMarker:()=>({amount:0,currency:'USD',approximate:true,kind:'value-estimate',estimateReasons:['subscription-value']}),
  };
  return {
    emit(event: AgentEvent){events.handleSessionEvent(deps,session,{...event,source:'pi',sessionInstanceId:session.instanceId,sessionTurnGeneration:session.getTurnGeneration()});},
    async settled(){await usageFinished;await Promise.all(writes);await runtime.drain(id);},
    async close(){activity.deleteSession(id);await session.close();},
  };
}
