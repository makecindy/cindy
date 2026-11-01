import { randomUUID } from 'node:crypto';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { botSessionLinks, messages } from '@cindy/runtime-db/schema';
import type { DbClient } from '@cindy/runtime-db';
import { createSessionTerminalReader } from '@cindy/runtime-db/sessionTerminal';
import { createSessionActivityReader, createPersistedSessionActivityReader } from '@cindy/app-runtime/sessionActivityProjection';
import { createSessionControlService } from '@cindy/app-runtime/sessionControlService';
import { createSessionControlCoordinator } from '@cindy/app-runtime/sessionControlCoordinator';
import { createSessionControlInputBuilder } from '@cindy/app-runtime/sessionControlInput';
import { createSessionSenderIdentityReader } from '@cindy/app-runtime/sessionSenderIdentity';
import { createAgentRequestCapture, ownerChannelInputEvidence } from '@cindy/app-runtime/agentRequestCapture';
import { taskActionPrincipal } from '@cindy/app-runtime/taskActionAuthorization';
import { readChannelToolScope } from '@cindy/im-runtime/channelToolScope';
import { extractPlainText } from '@cindy/im-runtime/agentHandoff';
import { createSessionRuntimeManagement } from '@cindy/app-runtime/sessionRuntimeManagement';
import { setSessionRuntimeHarness } from '@cindy/app-runtime/sessionRuntimeHarnessSelection';
import { hasExplicitSessionTaskModel } from '@cindy/app-runtime/sessionTaskModelOverride';
import type { createSessionRuntimeControl } from '@cindy/app-runtime/sessionRuntimeControl';
import { assertReviewSessionExternalInputAllowed } from '@cindy/app-runtime/reviewSessionInputPolicy';
import { assertCindyMakeSessionAvailable } from '@cindy/app-runtime/cindyMakeFeatureGate';
import type { AgentInputCoordinator } from '@cindy/app-runtime/agent-input-coordinator';
import { performSessionAgentSwitch } from '@cindy/im-runtime/sessionAgentSwitch';
import { createQueueReorderAdapter } from '@cindy/im-runtime/sessionQueueControl';
import { effectiveSourceIdForModel, findCatalogModel } from '@cindy/model-providers';
import type { Session } from '@cindy/maker-core';
import type { ForwardedRequestSource } from '@cindy/maker-shared/forwarded-request-types';
import type { TerminalTaskHost } from './host.js';
import type { TerminalConversations } from './conversations.js';
import type { createTerminalRuntimeRecovery } from './runtime-recovery.js';
import type { createTerminalTaskEvents } from './events.js';

/** Host ports only; task decisions and queue state remain in the original runtime. */
export function createTerminalSessionControl(host:{
  tasks:TerminalTaskHost;
  getDbClient():DbClient;
  guard():void;
  live(id:string):Session|undefined;
  coordinator:AgentInputCoordinator;
  conversations:TerminalConversations;
  control:ReturnType<typeof createSessionRuntimeControl>;
  recovery:ReturnType<typeof createTerminalRuntimeRecovery>;
  events:ReturnType<typeof createTerminalTaskEvents>;
  formatForwardedRequest(source:ForwardedRequestSource,supplement:string):string;
}) {
  const {tasks,getDbClient,guard,live,coordinator,conversations,control,recovery,events}=host;
  const guardedDb=()=>{guard();return getDbClient();};
  const readActivity=createSessionActivityReader({
    getLiveSnapshot:id=>tasks.sessionActivity.service.getSessionActivitySnapshot(id),
    getPersistedFacts:createPersistedSessionActivityReader(guardedDb),
    getLatestTerminal:createSessionTerminalReader(guardedDb).readLatestSessionTerminal,
  });
  const capture=createAgentRequestCapture(host.formatForwardedRequest);
  const captureRequest=async(id:string,supplement:string)=>{
    guard(); const scope=conversations.broadcastTap.captureDataOwnerBroadcastScope();
    const active=coordinator.getAcceptedInputProvenance(id);
    const lane=readChannelToolScope({sessionId:id,sessionInstanceId:live(id)?.instanceId});
    const principal=taskActionPrincipal(id);
    const [companion]=await guardedDb().drizzle.select({role:botSessionLinks.role}).from(botSessionLinks)
      .where(and(eq(botSessionLinks.sessionId,id),inArray(botSessionLinks.role,['canonical','group','channel','thread']),isNull(botSessionLinks.archivedAt))).limit(1);
    const ownerVerified=!!companion&&principal==='owner';
    const evidence=active??(ownerVerified?await ownerChannelInputEvidence(lane,async clientId=>{
      const [row]=await guardedDb().drizzle.select({content:messages.content}).from(messages)
        .where(and(eq(messages.sessionId,id),eq(messages.clientId,clientId),eq(messages.role,'user'),isNull(messages.rewindAt))).limit(1);
      return row?extractPlainText(row.content):null;
    }):null);
    const request=await capture(id,supplement,evidence,()=>conversations.messages.listMessagesForAgentHandoff(id,1,undefined,'user'),!!companion,ownerVerified);
    guard(); if(!conversations.broadcastTap.isDataOwnerBroadcastScopeCurrent(scope))throw new Error('Data owner changed before request capture');
    return request;
  };
  const buildInput=createSessionControlInputBuilder({buildCreateOptsForQueuedSession:async(id,_meta,inheritPlan)=>{
    const row=await tasks.storage.get(id);guard();if(!row)throw new Error('TASK_NOT_FOUND');
    return {agentKind:row.agentKind,model:row.model,providerId:row.providerId,workingDir:row.workDir,
      remoteHostId:row.remoteHostId,agentDeviceId:row.agentDeviceId,effort:row.effort,fastMode:row.fastMode,
      permissionMode:row.permissionMode,planMode:inheritPlan?row.planMode:false,orcaRole:row.orcaRole};
  }});
  const service=createSessionControlService({
    formatForwardedRequest:host.formatForwardedRequest,
    sessionExists:async id=>(await tasks.storage.get(id))!==null,
    getLiveSession:id=>live(id)??null,getSessionActivitySnapshot:readActivity,
    ...createSessionRuntimeManagement({
      ...control,getLiveSession:id=>live(id)??null,readCanonicalSessionActivity:readActivity,
      readSessionRuntimeProfiles:recovery.readProfiles,readBotFallbackCandidate:recovery.readBotFallbackCandidate,
      hasExplicitSessionTaskModel:id=>hasExplicitSessionTaskModel(guardedDb,id),
      readSessionRuntimeFallbackSettings:()=>events.fallbackSettings.read(),
      applySessionRuntimeSelection:tasks.routes.applyRuntimeSelection,
      setHarness:({targetSessionId,expectedGeneration,patch,beforeMutation})=>setSessionRuntimeHarness({
        withSessionLock:(id,run)=>tasks.routes.withLock(id,run),ownerEpoch:control.captureSessionRuntimeControlOwnerEpoch,
        generation:id=>control.getSessionRuntimeControlSnapshot(id).generation,
        pendingRevision:id=>tasks.routes.pending.revision!(id),pending:id=>tasks.routes.pending.get(id),
        read:async id=>(await recovery.readProfiles(id))?.effective??null,
        resolve:async(profile,explicit)=>{
          const assertRoute=tasks.routes.deps.assertModelRouteUsable;
          if(!assertRoute)throw new Error('Model route validation is not bound');
          const reroute=await assertRoute(profile.agentKind,profile.model,profile.providerId,targetSessionId);
          const providers=await tasks.models.views({allowSideEffects:false});guard();
          const providerId=reroute && tasks.routes.deps.shouldApplyExclusiveProviderReroute?.(profile.providerId)
            ?reroute:profile.providerId??effectiveSourceIdForModel(providers,null,profile.model,profile.agentKind);
          const provider=providers.find(candidate=>candidate.id===providerId);
          const model=findCatalogModel(provider,profile.model,profile.agentKind,{exact:true});
          if(!provider?.connected||!model)throw Object.assign(new Error(`model "${profile.model}" is unavailable for harness "${profile.agentKind}"`),{code:'INVALID_PARAMS'});
          const axes=control.resolveSessionRuntimeAxes({model,effort:profile.effort,fastMode:profile.fastMode,effortExplicit:explicit.effort,fastExplicit:explicit.fast});
          if(!axes.ok)throw Object.assign(new Error(`target model runtime axes unavailable: ${axes.reason}`),{code:'INVALID_PARAMS'});
          return {...profile,providerId:providerId??null,effort:axes.effort,fastMode:axes.fastMode};
        },
        stage:(id,profile,assertSelectionCurrent,beforeMutation)=>performSessionAgentSwitch(tasks.routes.deps,{
          sessionId:id,targetAgentKind:profile.agentKind,model:profile.model,providerId:profile.providerId,effort:profile.effort,fastMode:profile.fastMode,
          runtimeSource:'agent',assertSelectionCurrent,beforeMutation,
        }),
      },{targetSessionId,expectedGeneration,patch,beforeMutation}),
    }),
    assertExternalInputAllowed:async id=>{
      guard();const source=(await tasks.storage.get(id))?.source??null;
      assertCindyMakeSessionAvailable(source);await assertReviewSessionExternalInputAllowed(id,()=>source);
    },
    ...createSessionControlCoordinator({captureSessionAgentRequest:captureRequest,getSessionMeta:id=>tasks.storage.get(id),
      buildSessionControlInputItem:buildInput,readSenderIdentity:createSessionSenderIdentityReader(guardedDb),inputCoordinator:coordinator,
      ...createQueueReorderAdapter({getLiveSession:live,hasSendToSessionLock:id=>tasks.routes.isLocked(id),getCoordinator:()=>coordinator}),
    }),
    createId:randomUUID,
  });
  return {service,buildInput,captureRequest};
}
