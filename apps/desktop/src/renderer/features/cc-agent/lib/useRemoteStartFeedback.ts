import { useMemo } from 'react';

import type { ChatMessage as Message } from '@/lib/makerChatStore';
import {
  getStartingInputClientId,
  hasStartingTerminal,
  useStartingSessionIds,
} from '@/lib/sessionStartingStore';
import {
  hasTurnResponse,
  remoteResponsePendingStatus,
  remoteWaitingScope,
} from './localizeAgentStatus';

interface RemoteStartFeedbackInput {
  sessionId: string | null | undefined;
  agentDeviceId: string | null | undefined;
  remoteHostId: string | null | undefined;
  status: string;
  isRunning: boolean;
  messages: readonly Message[];
  queuePaused: boolean;
  credentialSwitchWait: unknown;
  pendingPermission: unknown;
  pendingAskUser: unknown;
  pendingPluginSetup: unknown;
  pendingPlanReview: unknown;
}

/** Derives the session view's pre-response status and owns absorption of its starting marker. */
export function useRemoteStartFeedback({
  sessionId,
  agentDeviceId,
  remoteHostId,
  status,
  isRunning,
  messages,
  queuePaused,
  credentialSwitchWait,
  pendingPermission,
  pendingAskUser,
  pendingPluginSetup,
  pendingPlanReview,
}: RemoteStartFeedbackInput) {
  // SSH has no agentDeviceId, but its host-side preflight is still remote preparation.
  const remoteWaiting = remoteWaitingScope(agentDeviceId, remoteHostId);
  const startingInputClientId = sessionId ? getStartingInputClientId(sessionId) : undefined;
  const receivedRemoteResponse = useMemo(
    () => hasTurnResponse(messages, startingInputClientId), [messages, startingInputClientId],
  );
  const receivedTerminalStatus = Boolean(sessionId && hasStartingTerminal(sessionId));
  // A retained error belongs to the previous turn until running clears it.
  // Only a newly received terminal event may settle this send's preparation.
  const settledStartingSessions = useMemo(() => new Set(
    remoteWaiting && sessionId && (isRunning || receivedRemoteResponse || receivedTerminalStatus
      || queuePaused || credentialSwitchWait
      || pendingPermission || pendingAskUser || pendingPluginSetup || pendingPlanReview)
      ? [sessionId] : [],
  ), [remoteWaiting, sessionId, isRunning, receivedRemoteResponse, receivedTerminalStatus,
    queuePaused, credentialSwitchWait,
    pendingPermission, pendingAskUser, pendingPluginSetup, pendingPlanReview]);
  const startingSessions = useStartingSessionIds(settledStartingSessions);
  const waitingRemoteStart = Boolean(remoteWaiting && sessionId
    && startingSessions.has(sessionId) && !settledStartingSessions.has(sessionId));

  return {
    waitingRemoteStart,
    status: waitingRemoteStart ? 'Waiting for remote response' : remoteResponsePendingStatus(
      status, agentDeviceId, isRunning, messages,
    ),
  };
}
