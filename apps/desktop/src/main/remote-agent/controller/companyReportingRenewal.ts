import { companyExecutionReporting, readCompanyExecutionChallenge } from '../../usage/companyTokenFacts.js';
import type { RemoteAgentInvoke } from './poller.js';

export function createCompanyReportingRenewal(invoke: RemoteAgentInvoke) {
  // A link has one active run. Reconnects get a new id and cannot reuse the old grant.
  let renewal: { runId: string; pending: Promise<void>; freshUntil: number } | undefined;
  return async function syncReporting(runId: string, valid: () => boolean, executorChanged = false): Promise<void> {
    const service = companyExecutionReporting();
    if (!service) return;
    if (!executorChanged && renewal?.runId === runId && Date.now() < renewal.freshUntil) return renewal.pending;
    const started = Date.now();
    const entry = { runId, pending: Promise.resolve(), freshUntil: Infinity };
    renewal = entry;
    let acknowledged = false;
    entry.pending = (async () => {
      if (!service.available() || !valid()) return;
      const challenge = readCompanyExecutionChallenge(await invoke([{ op: 'company-reporting-challenge', runId }]));
      if (renewal !== entry || !valid() || !challenge) return;
      const grant = await service.issue(challenge);
      if (renewal !== entry || !valid() || !grant) return;
      const ack = await invoke([{ op: 'company-reporting-grant', runId, grant }]) as { authorized?: boolean } | null;
      if (ack?.authorized) {
        acknowledged = true;
        const midnight = new Date(started);
        midnight.setUTCHours(24, 0, 0, 0);
        entry.freshUntil = Math.min(started + 110_000, midnight.getTime());
      }
    })().catch(() => undefined).finally(() => {
      if (!acknowledged) entry.freshUntil = Date.now() + 30_000;
    });
    return entry.pending;
  };
}
