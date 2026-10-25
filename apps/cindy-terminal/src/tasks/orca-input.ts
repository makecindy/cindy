import type { AgentInputQueuedMessage } from '@cindy/maker-shared/agent-input-queue';
import type { TerminalOrcaStore } from './orca-store.js';
import type { TerminalTaskStorage } from './storage.js';
import type { UserMessage } from '@cindy/maker-core';

/** Only the host dispatcher creates this receipt. Wire input cannot supply it. */
export interface TerminalOrcaInput {
  teamId: string;
  workerId: string;
  leadSessionId: string;
  workerSessionId: string;
  source: 'lead' | 'worker';
  origin: Extract<NonNullable<AgentInputQueuedMessage['origin']>, { kind: 'orca' }>;
  persistedContent: string;
}

/** Keep native sender instructions out of visible history without losing attachments. */
export function terminalOrcaHistoryMessage(message: UserMessage, input?: TerminalOrcaInput): UserMessage {
  if (!input) return message;
  if (typeof message.content === 'string') return { ...message, content: input.persistedContent };
  let replaced = false;
  return { ...message, content: message.content.map(block => {
    if (block.type !== 'text' || replaced) return block;
    replaced = true;
    return { ...block, text: input.persistedContent };
  }) };
}

export async function assertTerminalOrcaInput(
  store: TerminalOrcaStore, tasks: TerminalTaskStorage, target: string, input: TerminalOrcaInput,
) {
  const link = await store.getWorkerLink({ workerId: input.workerId, workerSessionId: input.workerSessionId });
  const [lead, worker] = await Promise.all([tasks.get(input.leadSessionId), tasks.get(input.workerSessionId)]);
  const team = await store.getActiveTeamByLead(input.leadSessionId);
  if (!link || link.teamId !== input.teamId || link.leadSessionId !== input.leadSessionId || team?.id !== input.teamId
    || !lead || lead.deleted || lead.archived || !worker || worker.deleted || worker.archived
    || target !== (input.source === 'lead' ? input.workerSessionId : input.leadSessionId)
    || input.origin.senderSessionId !== (input.source === 'lead' ? input.leadSessionId : input.workerSessionId)) {
    throw new Error('ORCA_ASSIGNMENT_REVOKED');
  }
}

/** Re-resolve the shared dispatcher's sender against current persisted links. */
export async function captureTerminalOrcaInput(
  store: TerminalOrcaStore, tasks: TerminalTaskStorage, target: string, item: Pick<AgentInputQueuedMessage, 'origin' | 'persistedContent'>,
): Promise<TerminalOrcaInput> {
  const origin = item.origin;
  if (origin?.kind !== 'orca' || !origin.senderSessionId) throw new Error('ORCA_ASSIGNMENT_INVALID');
  let link = await store.getWorkerLink({ workerSessionId: target });
  const source = link?.leadSessionId === origin.senderSessionId ? 'lead' : 'worker';
  if (source === 'worker') link = await store.getWorkerLink({ workerSessionId: origin.senderSessionId });
  if (!link) throw new Error('ORCA_ASSIGNMENT_INVALID');
  const worker = (await store.listWorkersByLead(link.leadSessionId)).find(row => row.id === link.workerId);
  if (!worker) throw new Error('ORCA_ASSIGNMENT_REVOKED');
  const input: TerminalOrcaInput = { teamId: link.teamId, workerId: link.workerId,
    leadSessionId: link.leadSessionId, workerSessionId: link.workerSessionId, source,
    origin: { ...origin, senderLabel: source === 'lead' ? 'Lead' : worker.role }, persistedContent: item.persistedContent };
  await assertTerminalOrcaInput(store, tasks, target, input);
  return input;
}
