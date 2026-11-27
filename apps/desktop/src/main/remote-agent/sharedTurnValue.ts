import type { AgentEvent } from '@cindy/maker-core';
import type { RegionalMoney } from '../../shared/regionalMoney.js';

export type SharedTurnValue = Pick<RegionalMoney, 'amount' | 'currency'>;
const accepted = Symbol('authorized shared Codex turn value');
type AcceptedEvent = AgentEvent & {
  [accepted]?: { sessionId: string; agentDeviceId: string; money?: RegionalMoney };
};

/** Bind the decoded amount to the authenticated run locally. JSON cannot supply this marker. */
export function acceptSharedTurnValue(event: AgentEvent, sessionId: string, agentDeviceId: string): AgentEvent {
  if (event.type !== 'done' || event.source !== 'codex' || event.turnScope === 'background' || event.agentMeta?.parentUuid) return event;
  const value = (event.data as { sharedTurnValue?: Partial<SharedTurnValue> } | null)?.sharedTurnValue;
  const money: RegionalMoney | undefined = value && typeof value === 'object' && Object.keys(value).every(key => key === 'amount' || key === 'currency') &&
    typeof value.amount === 'number' && Number.isFinite(value.amount) && value.amount > 0 &&
    (value.currency === 'CNY' || value.currency === 'USD')
    ? { amount: value.amount, currency: value.currency, approximate: true, kind: 'value-estimate' }
    : undefined;
  const result: AcceptedEvent = { ...event, [accepted]: { sessionId, agentDeviceId, money } };
  return result;
}

export function sharedTurnReceipt(event: AgentEvent, sessionId: string, agentDeviceId: string) {
  const receipt = (event as AcceptedEvent)[accepted];
  return receipt && receipt.sessionId === sessionId && receipt.agentDeviceId === agentDeviceId ? receipt : undefined;
}
