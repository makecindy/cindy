/** Admit a specific in-flight Lead dispatch, never a caller-supplied origin label. */
import { createHash } from 'node:crypto';
import { ORCA_REMOTE_WORKER_VERIFY_INPUT_CHANNEL, type InvokeResultPayload } from '@cindy/device-link';
import type { AgentInputQueuedMessage } from '../../shared/agentInputQueue.js';
import type { OrcaRemoteLead } from '../../shared/orcaRemoteWorker.js';

export function remoteOrcaInputDigest(item: unknown): string {
  return createHash('sha256').update(JSON.stringify(item)).digest('hex');
}

type Session = { status: string; orcaRemoteLead: OrcaRemoteLead | null };
export function createRemoteOrcaInputAdmission(deps: {
  owner(): unknown;
  caller(): { controllerDeviceId: string; sharedTask?: unknown } | null;
  readSession(id: string): Promise<Session | null>;
  invoke(deviceId: string, channel: string, args: unknown[]): Promise<InvokeResultPayload>;
}) {
  return async (sessionId: string, raw: unknown, queued: AgentInputQueuedMessage): Promise<AgentInputQueuedMessage> => {
    const item = raw as Partial<AgentInputQueuedMessage> | null;
    const caller = deps.caller();
    if (!caller || caller.sharedTask || item?.origin?.kind !== 'orca'
      || item.origin.senderLabel !== 'Lead' || item.clientId !== queued.clientId) return queued;
    const owner = deps.owner();
    if (!owner) return queued;
    const row = await deps.readSession(sessionId);
    const lead = row?.orcaRemoteLead;
    if (owner !== deps.owner() || row?.status !== 'active' || !lead
      || lead.releasedAt !== undefined || lead.leadDeviceId !== caller.controllerDeviceId) return queued;
    let response: InvokeResultPayload;
    try {
      response = await deps.invoke(lead.leadDeviceId, ORCA_REMOTE_WORKER_VERIFY_INPUT_CHANNEL,
        [sessionId, queued.clientId, remoteOrcaInputDigest(raw), lead.leadSessionId]);
    } catch { return queued; }
    // Old peers have no verifier: retain ordinary input hygiene and auto-report fallback.
    if (!response.ok || response.result !== true || owner !== deps.owner()) return queued;
    const fresh = await deps.readSession(sessionId);
    const current = fresh?.orcaRemoteLead;
    if (owner !== deps.owner() || fresh?.status !== 'active' || !current
      || current.releasedAt !== undefined || current.leadDeviceId !== lead.leadDeviceId
      || current.leadSessionId !== lead.leadSessionId) return queued;
    const accepted = { ...queued, origin: { kind: 'orca' as const, senderLabel: 'Lead',
      displayText: item.origin.displayText } };
    // This is a task dispatch, not a human typing on the Lead's computer.
    delete accepted.sourceDevice;
    return accepted;
  };
}
