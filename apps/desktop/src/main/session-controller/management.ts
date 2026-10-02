import type { Session, SessionTreeSnapshot } from '@cindy/maker-core';
import type { AgentInputProjection } from '../../shared/agentInputQueue.js';
import type { SessionOperation } from '@cindy/maker-shared/session-controller';
import { createSessionController, sessionOperation, type SessionControllerDeps } from './controller.js';
import { requireSessionCaller } from './callerContext.js';
import type { HostInteractionOrigin } from './interactions.js';
import type { PendingInteractionSnapshotEntry } from '../maker-ipc/register.js';

export interface SessionInputControlOptions {
  expectedClearBoundaryMs?: number | null;
  durableDelivery?: boolean;
}
type QueueTarget = { sessionId: string; options?: SessionInputControlOptions };

/** Complete host management ports. UI and internal hosts use these typed methods;
 * caller policy, not transport or presence in this interface, grants each operation. */
export interface SessionManagementPorts {
  deleteMessage(params: { sessionId: string; clientId: string }): Promise<{ sessionId: string; clientId: string; clientIds: string[] }>;
  listBackgroundTasks(params: { sessionId: string }): Promise<{ tasks: ReturnType<Session['listBackgroundTasks']>; pendingContinuations: number }> | { tasks: ReturnType<Session['listBackgroundTasks']>; pendingContinuations: number };
  inspectInteractions(params: { sessionId: string }): Promise<PendingInteractionSnapshotEntry[]>;
  resolveInteraction(params: { sessionId?: string; requestId: string; decision: unknown; origin?: HostInteractionOrigin }): Promise<{ accepted: boolean }>;
  pauseQueue(params: QueueTarget & { options?: SessionInputControlOptions & { keepQueue?: boolean; pauseQueue?: boolean } }): Promise<AgentInputProjection>;
  resumeQueue(params: QueueTarget): Promise<AgentInputProjection>;
  retryInput(params: QueueTarget): Promise<AgentInputProjection>;
  clearInputError(params: QueueTarget): Promise<AgentInputProjection>;
  removeInput(params: QueueTarget & { inputId: string }): Promise<AgentInputProjection & { inputDeliveryCancelled?: boolean }>;
  moveInput(params: QueueTarget & { inputId: string; targetIndex: number }): Promise<AgentInputProjection>;
  updateInputPresentation(params: QueueTarget & { expanded: boolean }): Promise<AgentInputProjection>;
  setInteractionLock(params: QueueTarget & { lockId: string; locked: boolean }): Promise<AgentInputProjection>;
  setEditLock(params: QueueTarget & { inputId: string; locked: boolean }): Promise<AgentInputProjection>;
  clearInputs(params: { sessionId: string; clearedAt?: string }): Promise<AgentInputProjection>;
  changePlanMode(params: { sessionId: string; enabled: boolean }): Promise<void | Record<string, never>>;
  inspectHistory(params: { sessionId: string }): Promise<SessionTreeSnapshot | null>;
  navigateHistory(params: { sessionId: string; entryId: string; options?: Parameters<Session['navigateSessionTree']>[1] }): Promise<{
    tree: SessionTreeSnapshot; draftText?: string; cancelled: boolean;
  } | null>;
}

export const MANAGEMENT_OPERATIONS = {
  deleteMessage: 'deleteMessage',
  listBackgroundTasks: 'listBackgroundTasks', inspectInteractions: 'inspectInteractions', resolveInteraction: 'resolveInteraction',
  pauseQueue: 'pauseQueue', resumeQueue: 'resumeQueue', retryInput: 'retryInput', clearInputError: 'clearInputError',
  removeInput: 'withdrawOwnedInput', moveInput: 'moveInput', updateInputPresentation: 'updateInputPresentation',
  setInteractionLock: 'setInputLock', setEditLock: 'setInputLock', clearInputs: 'clearInputs',
  changePlanMode: 'changePermission', inspectHistory: 'inspectHistory', navigateHistory: 'rewind',
} as const satisfies Record<keyof SessionManagementPorts, SessionOperation>;

export function createSessionManagementController(deps: SessionControllerDeps, ports: SessionManagementPorts): SessionManagementPorts {
  // A typed method closes over its concrete input and result. No IPC handler,
  // Electron event or untyped dispatch is called from the business service.
  function bind<K extends keyof SessionManagementPorts>(key: K): SessionManagementPorts[K] {
    type Params = Parameters<SessionManagementPorts[K]>[0];
    const controller = createSessionController(deps, {
      execute: sessionOperation({ operation: MANAGEMENT_OPERATIONS[key], targets: (p: Params) => p.sessionId ? [p.sessionId] : [],
        execute: (_scope, p: Params) => (ports[key] as (p: Params) => ReturnType<SessionManagementPorts[K]>)(p) }),
    });
    return ((p: Params) => controller.invoke(controller.issueCaller(requireSessionCaller()), 'execute', p)) as SessionManagementPorts[K];
  }
  return Object.fromEntries(Object.keys(MANAGEMENT_OPERATIONS).map(key => [key, bind(key as keyof SessionManagementPorts)])) as unknown as SessionManagementPorts;
}
