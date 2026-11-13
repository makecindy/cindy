import type { SendOptions } from './agents/base-agent.js';
import { isTerminalAgentErrorEvent, type AgentEvent } from './types/events.js';

// Call-local provenance never crosses a wire or comes from provider event fields.
const sendOwners = new WeakMap<SendOptions, { generation: number; terminalStatus: () => 'settled' | 'unsettled' | undefined }>();
const terminalOwners = new WeakMap<AgentEvent, number>();

export function bindSessionSendOwner(
  options: SendOptions, generation: number, terminalStatus: () => 'settled' | 'unsettled' | undefined,
): SendOptions {
  sendOwners.set(options, { generation, terminalStatus });
  return options;
}

/** Mark an adapter-synthesized terminal for the exact Session.send that owns it. */
export function markSessionSendTerminal(options: SendOptions | undefined, event: AgentEvent): AgentEvent {
  const generation = options && sendOwners.get(options)?.generation;
  if (generation !== undefined && event.turnScope !== 'background'
    && (event.type === 'done' || isTerminalAgentErrorEvent(event))) terminalOwners.set(event, generation);
  return event;
}

export function readSessionSendTerminalOwner(event: AgentEvent): number | undefined {
  return terminalOwners.get(event);
}

/** Read the owning Session after queued provider events have been consumed. */
export function readSessionSendTerminalStatus(options: SendOptions | undefined): 'settled' | 'unsettled' | undefined {
  return options && sendOwners.get(options)?.terminalStatus();
}
