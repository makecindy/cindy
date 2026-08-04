import {
  listWorkersByLeads,
  type OrcaWorkerRecord,
} from '../orcaTeamStore.js';

const listWorkersByLeadInflight = new Map<string, Promise<OrcaWorkerRecord[]>>();

function ensureWorkersByLeadRequests(leadSessionIds: readonly string[]): void {
  const missingLeadSessionIds = leadSessionIds.filter(
    (leadSessionId) => !listWorkersByLeadInflight.has(leadSessionId),
  );
  if (missingLeadSessionIds.length === 0) return;

  const batchRequest = listWorkersByLeads(missingLeadSessionIds);
  for (const leadSessionId of missingLeadSessionIds) {
    const promise = batchRequest.then((grouped) => grouped[leadSessionId] ?? []);
    listWorkersByLeadInflight.set(leadSessionId, promise);
    void promise
      .finally(() => {
        if (listWorkersByLeadInflight.get(leadSessionId) === promise) {
          listWorkersByLeadInflight.delete(leadSessionId);
        }
      })
      .catch(() => undefined);
  }
}

export function invalidateWorkersByLeadSingleFlight(leadSessionId: string): void {
  listWorkersByLeadInflight.delete(leadSessionId);
}

export function listWorkersByLeadSingleFlight(
  leadSessionId: string,
): Promise<OrcaWorkerRecord[]> {
  const existing = listWorkersByLeadInflight.get(leadSessionId);
  if (existing) return existing;
  ensureWorkersByLeadRequests([leadSessionId]);
  return listWorkersByLeadInflight.get(leadSessionId)!;
}

export async function listWorkersByLeadsSingleFlight(
  leadSessionIds: readonly string[],
): Promise<Record<string, OrcaWorkerRecord[]>> {
  const uniqueLeadSessionIds = [...new Set(leadSessionIds)];
  ensureWorkersByLeadRequests(uniqueLeadSessionIds);
  const entries = await Promise.all(
    uniqueLeadSessionIds.map(async (leadSessionId) => [
      leadSessionId,
      await listWorkersByLeadInflight.get(leadSessionId)!,
    ] as const),
  );
  return Object.fromEntries(entries);
}

export function __resetOrcaWorkerListSingleFlightForTest(): void {
  listWorkersByLeadInflight.clear();
}
